// The ordering page used to read orders/active, orders/ready and orders/completed
// directly to quote a wait. Those nodes carry every order's items, notes and
// delivery address and are never pruned, so serving four numbers meant publishing
// the café's whole order history to anyone.
//
// The POS now publishes just those numbers to eta/live. The question this suite
// answers is whether that changed the answer: for the same kitchen, the estimate
// must come out the same as it did reading the orders directly. If it doesn't,
// customers get told a different wait than before and the refactor is not neutral.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const idx = readPage('index.html');
const pos = readPage('pos.html');

// ---------------------------------------------------------------- the two sides
const MODEL = JSON.parse(JSON.stringify(
  eval('(' + idx.slice(idx.indexOf('const ETA_DEF = {') + 'const ETA_DEF = '.length,
                        idx.indexOf('};', idx.indexOf('const ETA_DEF = {')) + 1) + ')')));

// customer side: the tempo maths, fed either by orders or by published ratios
const customer = buildModule([
  'let kitchenTempo = 1.0;',
  'const TEMPO_WINDOW_MS = 45*60000, TEMPO_MIN_SAMPLES = 6;',
  'const TEMPO_CLAMP_LO = 0.85, TEMPO_CLAMP_HI = 1.25, TEMPO_SMOOTH = 0.25;',
  'function lc(s){return(s||"").toLowerCase();}',
  extractFunction(idx, 'isPizza'),
  extractFunction(idx, 'isBaked'),
  extractFunction(idx, 'itemBase'),
  extractFunction(idx, 'tempoExpected'),
  extractFunction(idx, 'applyTempo'),
  extractFunction(idx, 'recomputeTempo'),
  extractFunction(idx, 'recomputeTempoFromPace'),
  'function resetTempo(){ kitchenTempo = 1.0; }',
  'function readTempo(){ return kitchenTempo; }',
], { MODEL, Math, Date, Object },
   ['recomputeTempo', 'recomputeTempoFromPace', 'resetTempo', 'readTempo', 'tempoExpected']);

// POS side: turning completions into publishable ratios
const win = { etaModel: MODEL };
const poser = buildModule([
  'function lc(s){ return (s||"").toLowerCase(); }',
  extractFunction(pos, 'isPizza'),
  extractFunction(pos, 'isBaked'),
  extractFunction(pos, 'itemBaseTime'),
  extractFunction(pos, 'etaPaceFrom'),
], { window: win, Math, Object }, ['etaPaceFrom', 'itemBaseTime']);

// ---------------------------------------------------------------- fixtures
const snapOf = arr => ({ forEach: cb => arr.forEach(v => cb({ val: () => v })) });
const now = Date.now();
const mins = n => n * 60000;

// a plausible service: a mix of stations, some fast, some slow, one outlier,
// one too old for the window, one malformed
const completions = [
  { createdAt: now - mins(8),  completedAt: now - mins(2),  items: { 'Margherita': { qty: 1 } } },
  { createdAt: now - mins(12), completedAt: now - mins(5),  items: { 'Al Funghi': { qty: 1 } } },
  { createdAt: now - mins(9),  completedAt: now - mins(4),  items: { 'Latte': { qty: 2 } } },
  { createdAt: now - mins(7),  completedAt: now - mins(3),  items: { 'Cortado': { qty: 1 } } },
  { createdAt: now - mins(20), completedAt: now - mins(10), items: { 'Quattro': { qty: 1 } } },
  { createdAt: now - mins(15), completedAt: now - mins(6),  items: { 'Flat White': { qty: 1 } } },
  { createdAt: now - mins(30), completedAt: now - mins(11), items: { 'Pesto Burrata': { qty: 1 } } },
  { createdAt: now - mins(90), completedAt: now - mins(70), items: { 'Margherita': { qty: 1 } } }, // outside the window
  { createdAt: now - mins(6),  completedAt: now - mins(5.5), items: { 'Espresso': { qty: 1 } } },  // under 1 min
  { completedAt: now - mins(3), items: { 'Latte': { qty: 1 } } },                                  // no createdAt
];

const { check, note, done } = suite('ETA summary — eta/live replaces reading the orders');

// ---------------------------------------------------------------- equivalence
{
  customer.resetTempo();
  customer.recomputeTempo(snapOf(completions));
  const viaOrders = customer.readTempo();

  customer.resetTempo();
  customer.recomputeTempoFromPace(poser.etaPaceFrom(snapOf(completions)));
  const viaSummary = customer.readTempo();

  check('the published summary yields the same kitchen tempo as reading the orders',
        Math.abs(viaOrders - viaSummary) < 1e-9,
        'orders=' + viaOrders + '  summary=' + viaSummary);
  note('tempo ' + viaOrders.toFixed(4) + ' either way');
  check('and it is a real adjustment, not both defaulting to neutral',
        Math.abs(viaOrders - 1.0) > 1e-9, 'both were exactly 1.0, so this proves nothing');
}

// ---------------------------------------------------------------- the same guards
{
  const pace = poser.etaPaceFrom(snapOf(completions));
  check('completions under a minute are dropped', !pace.some(p => p.r != null && p.at === now - mins(5.5)));
  check('completions with no createdAt are dropped', pace.length === 8, 'kept ' + pace.length);
  note('8 of 10 fixtures survive the publish-time bounds — the 45-minute window is');
  note('applied on read, so the older completion is still published, just not counted');

  customer.resetTempo();
  customer.recomputeTempoFromPace(pace.filter(p => p.at > now - mins(45)));
  const windowed = customer.readTempo();
  customer.resetTempo();
  customer.recomputeTempoFromPace(pace);
  check('the 45-minute window is applied on read, so a stale ratio cannot count',
        Math.abs(windowed - customer.readTempo()) < 1e-9);
}

// ---------------------------------------------------------------- fewer than 6 samples
{
  customer.resetTempo();
  customer.recomputeTempoFromPace(poser.etaPaceFrom(snapOf(completions.slice(0, 3))));
  check('under six samples it stays neutral, exactly as before',
        Math.abs(customer.readTempo() - 1.0) < 1e-9, String(customer.readTempo()));
}

// ---------------------------------------------------------------- the clamp still holds
{
  const absurd = [
    { createdAt: now - mins(59), completedAt: now - mins(1), items: { 'Espresso': { qty: 1 } } },
  ];
  const many = [];
  for (let i = 0; i < 8; i++) many.push(absurd[0]);
  customer.resetTempo();
  customer.recomputeTempoFromPace(poser.etaPaceFrom(snapOf(many)));
  const t = customer.readTempo();
  check('a pathologically slow kitchen is still clamped', t <= 1.25 + 1e-9 && t > 1.0, String(t));
}

// ---------------------------------------------------------------- what it leaks
{
  const pace = poser.etaPaceFrom(snapOf([
    { createdAt: now - mins(9), completedAt: now - mins(3),
      items: { 'Margherita': { qty: 1 } },
      destination: '221B Baker Street, Bengaluru',
      notes: 'ring the top bell, flat 3',
      source: 'Web App', trackId: 'trk_abc' },
  ]));
  const json = JSON.stringify(pace);
  check('the published ratio carries only a timestamp and a number',
        Object.keys(pace[0]).sort().join(',') === 'at,r', Object.keys(pace[0]).join(','));
  check('no delivery address travels with it', !/Baker Street/.test(json), json);
  check('no order notes travel with it', !/top bell/.test(json), json);
  check('no item names travel with it', !/Margherita/.test(json), json);
  note('this is the whole point: four numbers instead of ~11,000 order records');
}

done();
