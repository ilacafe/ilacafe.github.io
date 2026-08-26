// The overdue alarm on the kitchen screens.
//
// chef.html and barista.html read eta/model to work out when a ticket is late.
// They took it wholesale — `window.etaModel || KDS_ETA_DEF` — so any field the
// live model happened not to carry came back undefined, and etaInterp reads a
// missing curve as zero rather than throwing.
//
// The refit cannot produce such a model: rcMergeModel deep-copies the current one
// and overwrites only what it re-derived. The restore button in analytics can,
// because it writes a snapshot wholesale, and an older snapshot may predate a
// curve that was added later.
//
// What that costs is not a crash. The saturation or oven term quietly becomes
// zero, the threshold comes in short, and the board starts calling tickets late
// while they are on time. A kitchen that learns to ignore the alarm is worse off
// than one that never had it.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const { check, note, done } = suite('Kitchen overdue alarm — a model missing a field');

for (const page of ['chef.html', 'barista.html']) {
  const src = readPage(page);
  const station = page === 'chef.html' ? 'satCurveChef' : 'satCurveBarista';

  // KDS_ETA_DEF is an object literal, not a function, so it is evaluated alongside
  // the two functions under test rather than extracted on its own.
  const defs = /const KDS_ETA_DEF = \{[\s\S]*?\n        \};/.exec(src);
  const withModel = (m) => {
    const mod = buildModule(
      [defs[0], extractFunction(src, 'etaCfg'), extractFunction(src, 'etaInterp')],
      { Object, Math, Number, window: { etaModel: m } },
      ['etaCfg', 'etaInterp', 'KDS_ETA_DEF']);
    return mod;
  };

  const noModel = withModel(null);
  check(page + ' uses its own defaults before the model loads',
        Array.isArray(noModel.etaCfg()[station]) && noModel.etaCfg()[station].length > 0);

  // A complete model wins on every field it carries.
  const full = withModel({ itemBase: { margherita: 9.9 }, fallback: { pizza: 9.4 },
                           [station]: [[0, 1], [8, 2]], qtyCurve: [[1, 0], [9, 3]] });
  check(page + ' prefers the live model where it has a value',
        full.etaCfg()[station][1][1] === 2 && full.etaCfg().itemBase.margherita === 9.9,
        JSON.stringify(full.etaCfg()[station]));

  // The case this exists for: a model with no saturation curve at all.
  const partial = withModel({ itemBase: { margherita: 9.9 }, fallback: { pizza: 9.4 } });
  const curve = partial.etaCfg()[station];
  check(page + ' falls back to its own ' + station + ' when the model has none',
        Array.isArray(curve) && curve.length > 0,
        JSON.stringify(curve));
  check(page + ' so a busy kitchen still adds saturation time',
        partial.etaInterp(curve, 4) > 0,
        'interp gave ' + partial.etaInterp(curve, 4) + ' minutes at a load of 4');
  note('etaInterp reads a missing curve as 0, so this is silent, not loud');

  // fallback and itemBase merge rather than replace, so a sparse model does not
  // erase the per-item bases the station shipped with.
  check(page + ' keeps its default item bases for items the model does not mention',
        Object.keys(partial.etaCfg().itemBase).length > 1,
        JSON.stringify(Object.keys(partial.etaCfg().itemBase)));
  check(page + ' and keeps the fallbacks the model does not carry',
        Number(partial.etaCfg().fallback.drink) > 0,
        JSON.stringify(partial.etaCfg().fallback));
}

// The seeded model has to carry everything the screens read, or the very first
// deploy leaves them on partial data.
{
  const pos = readPage('pos.html');
  const seeded = new Set(
    (/ETA_DEFAULTS\s*=\s*\{[\s\S]*?\n        \};/.exec(pos)[0].match(/^\s{0,20}([a-zA-Z]+)\s*:/gm) || [])
      .map(x => x.trim().replace(':', '')));
  const needed = new Set();
  for (const page of ['chef.html', 'barista.html']) {
    for (const m of readPage(page).matchAll(/\bM\.([a-zA-Z]+)/g)) needed.add(m[1]);
  }
  const missing = [...needed].filter(f => !seeded.has(f));
  check('the model pos.html seeds carries every field the kitchen screens read',
        missing.length === 0, 'missing: ' + missing.join(', '));
  note('reads: ' + [...needed].sort().join(', '));
}

done();
