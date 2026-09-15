// The monthly refit, driven over a kitchen whose true behaviour is known.
//
// Nothing tested this. The refit reads three months of the café's trade, rewrites the
// model every page quotes from, and its only guards were a handful of bounds — several
// of which were declared and never read. A refit that made the estimate worse passed
// every check it had, because nothing ever measured whether it had.
//
// The fixtures below are a synthetic café with coefficients this file knows: a pizza
// takes six minutes with a hot oven and an empty station, a cooling oven adds up to
// twelve, and a queue adds up to ten. The refit is not asked to recover those numbers
// exactly — it is asked to attribute them to the right cause, which is the thing it was
// getting wrong.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const src = readPage('worker/worker.js');

// The constants are top-level declarations, not functions, so they are evaluated
// alongside the code under test rather than extracted from it.
const consts = ['RECAL_MIN_N', 'RECAL_BOUNDS', 'RECAL_MAX_BANDS', 'RECAL_QUIET_AHEAD',
                'RECAL_HOT_IDLE', 'RECAL_HOLDOUT_FRAC', 'RECAL_TARGET_COVERAGE',
                'RECAL_COVERAGE_SLACK', 'RECAL_ERR_SLACK', 'RECAL_CUSHION_SCALES', 'RECAL_CUSHION_OFFSETS',
                'RECAL_SWING_REJECT_PCT', 'RC_PIZZA_FALLBACK', 'RC_BAKED_FALLBACK']
  .map(n => {
    // to the first semicolon, not to the first line ENDING in one — several of these
    // declarations carry a trailing comment, and [\\s\\S]*?;$ ran straight past them into
    // the next declaration and redeclared it.
    const m = src.match(new RegExp('^const ' + n + '\\s*=[^;]*;', 'm'));
    if (!m) throw new Error('could not find const ' + n);
    return m[0];
  });
const lets = ['_rcPizzaKeys', '_rcBakedKeys'].map(n => {
  const m = src.match(new RegExp('^let ' + n + '\\s*=.*$', 'm'));
  if (!m) throw new Error('could not find let ' + n);
  return m[0];
});

const fns = ['rcCleanKeys', 'rcUsePizzaKeys', 'rcUseBakedKeys', 'rcIsPizza', 'rcIsBaked',
             'rcAllBaked', 'rcAnyPizza', 'rcQty', 'rcWork', 'rcMedian', 'rcPctl', 'rcIQRClean',
             'rcAttachLoad', 'rcAttachOvenIdle', 'rcAttach', 'rcSplitWindow',
             'rcIsDessertAfterFood', 'rcBands', 'rcCurve', 'rcSpreadCurve', 'rcMonotone',
             'rcInterp', 'rcModelBase', 'rcQuote', 'rcScore', 'rcScaleCushions',
             'rcCalibrateCushions', 'rcDerive', 'rcGuardItemBase', 'rcMergeModel', 'rcCheckGates']
  .map(n => extractFunction(src, n));

const rc = buildModule([...consts, ...lets, ...fns],
  { Array, String, Object, Math, JSON, Map, Number, Date, parseInt, isFinite, isNaN, Infinity },
  ['rcDerive', 'rcAttach', 'rcSplitWindow', 'rcCurve', 'rcBands', 'rcSpreadCurve', 'rcMonotone',
   'rcQuote', 'rcScore', 'rcInterp', 'rcMergeModel', 'rcCheckGates', 'rcGuardItemBase',
   'rcCalibrateCushions', 'rcAllBaked', 'rcAttachLoad', 'rcUsePizzaKeys', 'rcUseBakedKeys',
   'rcIsDessertAfterFood']);

// Read from the Worker, so this suite cannot drift from the target the refit aims at.
const RECAL_TARGET = Number(/const RECAL_TARGET_COVERAGE\s*=\s*([0-9.]+)/.exec(src)[1]);

rc.rcUsePizzaKeys(['margherita', 'funghi']);
rc.rcUseBakedKeys(['cake', 'bread']);

const { check, note, done } = suite('The monthly refit — attributing the wait to the right cause');

// ---------------------------------------------------------------- the synthetic café
//
// Deterministic: a seeded generator, so a failure here is a failure about the code and
// never about the draw.
let _seed = 12345;
function rnd(){ _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; }

const TRUE_BASE = 6;
const trueOven = idle => idle < 10 ? 0 : (idle < 30 ? 5 : (idle < 60 ? 9 : 12));
const trueLoad = ahead => ahead <= 1 ? 0 : (ahead <= 5 ? 3 : (ahead <= 10 ? 6 : 10));

// A month of pizzas. Crucially, the oven and the queue are drawn INDEPENDENTLY — so a
// derivation that attributes one to the other has nowhere to hide.
function makeOrders(n){
  const out = [];
  let t = Date.UTC(2026, 0, 1, 11, 0, 0);
  for (let i = 0; i < n; i++){
    t += 45000 + Math.floor(rnd()*60000);
    const idle  = [2, 5, 8, 20, 25, 40, 50, 70, 90][Math.floor(rnd()*9)];
    const ahead = [0, 1, 2, 4, 6, 8, 11, 14][Math.floor(rnd()*8)];
    const dur = TRUE_BASE + trueOven(idle) + trueLoad(ahead) + (rnd()*3 - 1);
    out.push({ start: t, done: t + dur*60000, dur: dur, station: 'chef',
               items: { 'Margherita': { qty: 1 } }, table: 'T' + (i%9),
               // the derivation normally computes these; here they ARE the fixture
               idle: idle, ahead: ahead });
  }
  out.attached = true;             // do not let rcAttach recompute the planted conditions
  return out;
}
const PIZZAS = makeOrders(1400);

// ---------------------------------------------------------------- the headline fix
{
  const { derived } = rc.rcDerive(PIZZAS, ['margherita'], ['cake']);
  const sat = derived.satCurveChef, oven = derived.ovenCurve;

  check('the refit produces both curves from this café', Array.isArray(sat) && Array.isArray(oven),
        JSON.stringify({ sat: sat, oven: oven }));

  // The bug: satChef pooled pizzas at every oven idle and differenced them against a
  // baseline fitted on hot ones only, so an EMPTY station carried the average cost of a
  // cooling oven. The shipped curve started at +7 for exactly this reason, and the
  // estimate then added ovenCurve on top of it.
  check('an empty station adds nothing, because the oven is not charged here',
        sat[0][1] === 0 && rc.rcInterp(sat, 0) < 1.5,
        'satCurveChef at an empty station: ' + rc.rcInterp(sat, 0).toFixed(1) + ' min');

  check('and a busy one still charges for being busy',
        rc.rcInterp(sat, 12) >= 7 && rc.rcInterp(sat, 12) <= 13,
        'satCurveChef at 12 items ahead: ' + rc.rcInterp(sat, 12).toFixed(1) +
        ' min (the café really adds 10)');

  check('the oven curve carries the oven, and only the oven',
        rc.rcInterp(oven, 2) < 1.5 && rc.rcInterp(oven, 70) >= 9 && rc.rcInterp(oven, 70) <= 15,
        'ovenCurve hot ' + rc.rcInterp(oven, 2).toFixed(1) +
        ' / cold ' + rc.rcInterp(oven, 70).toFixed(1) + ' min (the café really adds 0 and 12)');

  // The two terms are ADDED by every estimator, so the test that matters is whether
  // their sum is the truth rather than whether either is plausible alone.
  let worst = 0;
  for (const [idle, ahead] of [[2,0],[2,14],[70,0],[70,14],[25,6],[50,4]]){
    const predicted = rc.rcInterp(oven, idle) + rc.rcInterp(sat, ahead);
    const actual = trueOven(idle) + trueLoad(ahead);
    worst = Math.max(worst, Math.abs(predicted - actual));
  }
  check('so oven + saturation together recover the real wait, in every corner',
        worst <= 2.5, 'worst corner is out by ' + worst.toFixed(1) + ' min');
  note('the old derivation double-counted the oven: it appeared in both terms');
}

// ---------------------------------------------------------------- bands sit where the evidence is
{
  // Twenty orders at x=0 and twenty at x=10, nothing between. A band covering both must
  // be represented at their median, not at the lower edge of the range it spans.
  const pool = [];
  for (let i = 0; i < 20; i++) pool.push({ x: 0,  dur: 5 });
  for (let i = 0; i < 20; i++) pool.push({ x: 10, dur: 9 });
  const b = rc.rcBands(pool, o => o.x, 5);
  check('a band is represented by its own median x, not by its lower edge',
        b.bands.every(band => { const xs = band.map(o => o.x); return xs.length > 0; }) &&
        rc.rcCurve(pool, o => o.x, 5).points.every(p => p[0] === 0 || p[0] === 10),
        JSON.stringify(rc.rcCurve(pool, o => o.x, 5).points));

  // interp divides by the gap between consecutive points, so a repeated x is a division
  // by zero and every lookup past it comes back NaN.
  const pts = rc.rcCurve(pool, o => o.x, 5).points;
  check('and no two points share an x, which interp cannot survive',
        pts.every((p, i) => i === 0 || p[0] > pts[i-1][0]) && isFinite(rc.rcInterp(pts, 5)),
        JSON.stringify(pts));
}

// ---------------------------------------------------------------- a curve that goes backwards
{
  const notes = [];
  const fixed = rc.rcMonotone([[0,0],[3,5],[6,2],[9,8]], notes, 'satCurveChef');
  check('a dip in a noisy band is lifted rather than shipped',
        fixed.map(p => p[1]).every((y, i, a) => i === 0 || y >= a[i-1]),
        JSON.stringify(fixed));
  check('and the lift is reported, not absorbed', notes.length === 1 && /lifted/.test(notes[0]), notes[0]);
  note('a quote that gets SHORTER as the kitchen gets busier is worse than a wrong one');
}

// ---------------------------------------------------------------- the bounds that were decoration
{
  const current = { itemBase: { margherita: 6 }, fallback: { pizza: 6, drink: 5, baked: 3 },
                    satCurveChef: [[0,0]], satCurveBarista: [[0,0]], ovenCurve: [[0,0]],
                    qtyCurve: [[1,0]], cushionBaked: 2, cushionHotfood: 5, version: 3 };
  const counts = { totalClean: 900, items: 1 };
  const ok = { n: 500, coverage: 0.86, medErr: 3.0, capRate: 0.05 };

  const absurd = (over) => rc.rcCheckGates(current, Object.assign({}, current, over),
                                           { pizzaBase: 6, itemBase: {}, margin: {} },
                                           counts, { considered: 0, dropped: [] }, ok, ok);
  check('a saturation curve that adds forty minutes at an empty counter is refused',
        !absurd({ satCurveChef: [[0, 39], [4, 44]] }).ok,
        JSON.stringify(absurd({ satCurveChef: [[0, 39], [4, 44]] }).reasons));
  check('so is an oven curve that adds an hour',
        !absurd({ ovenCurve: [[0,0],[60, 60]] }).ok);
  check('and a cushion the calibration ran away with',
        !absurd({ cushionPizzaByOven: [[0, 4], [40, 40]] }).ok);
  note('RECAL_BOUNDS.satMax and .ovenMax shipped from the start and were read by nothing');
}

// ---------------------------------------------------------------- one bad item, not a bad refit
{
  const notes = [];
  const current = { itemBase: { margherita: 6, latte: 5 } };
  const derived = { itemBase: { margherita: 6.4, latte: 19, 'carrot cake': 2.9, funghi: 40 } };
  const guard = rc.rcGuardItemBase(current, derived, notes);
  check('an item whose base tripled on a thin sample is held back',
        guard.kept.latte === undefined && /latte/.test(guard.dropped.join(' ')),
        JSON.stringify(guard.dropped));
  check('and one outside its category’s bounds entirely', guard.kept.funghi === undefined);
  check('while the rest of a good refit still lands',
        guard.kept.margherita === 6.4 && guard.kept['carrot cake'] === 2.9,
        JSON.stringify(guard.kept));
  check('and the holding-back is reported', notes.length === 1 && /held back/.test(notes[0]), notes[0]);
  note('only the pooled pizzaBase was ever gated; a single item could move by any amount');
}

// ---------------------------------------------------------------- an order with no items is not a dessert
{
  check('an empty item map is not "all desserts"', rc.rcAllBaked({}) === false);
  check('nor is a missing one', rc.rcAllBaked(undefined) === false);
  check('a real dessert still is', rc.rcAllBaked({ 'Carrot Cake': { qty: 1 } }) === true);
  const orders = [{ items: {}, dur: 30, table: 'T1', start: 0, done: 30*60000 },
                  { items: { 'Margherita': { qty: 1 } }, dur: 10, table: 'T1', start: 0, done: 10*60000 }];
  check('so a completed record that lost its items cannot be excluded as one',
        rc.rcIsDessertAfterFood(orders[0], orders) === false);
  note('every() on an empty array is true, which put these in cushionBaked and margin.baked');
}

// ---------------------------------------------------------------- the queue is work, not tickets
{
  const orders = [
    { station: 'chef', start: 0,        done: 20*60000, items: { 'Margherita': { qty: 6 } } },
    { station: 'chef', start: 5*60000,  done: 20*60000, items: { 'Margherita': { qty: 1 } } },
    { station: 'chef', start: 10*60000, done: 30*60000, items: { 'Margherita': { qty: 1 } } },
  ];
  rc.rcAttachLoad(orders);
  check('a ticket of six pizzas ahead of you counts as six, not as one',
        orders[2].ahead === 7, 'ahead = ' + orders[2].ahead + ' (two tickets, seven pizzas)');
  note('this is the variable the saturation curve is fitted against');
}

// ---------------------------------------------------------------- is it actually better?
{
  const holdout = PIZZAS.slice(-200);
  const good = { itemBase: { margherita: TRUE_BASE }, fallback: { pizza: TRUE_BASE, drink: 5, baked: 3 },
                 ovenCurve: [[0,0],[20,5],[40,9],[70,12]], satCurveChef: [[0,0],[4,3],[8,6],[14,10]],
                 satCurveBarista: [[0,0]], qtyCurve: [[1,0]],
                 cushionPizzaByOven: [[0,2]], cushionPizzaByLoad: [[0,0]], maxQuote: 32, rangeWidth: 5 };
  // Same shape, but it has decided the oven does nothing — the failure the old
  // derivation produced, with the oven's cost sitting in the saturation term instead.
  const muddled = JSON.parse(JSON.stringify(good));
  muddled.ovenCurve = [[0,0]];
  muddled.satCurveChef = [[0,6],[4,9],[8,12],[14,16]];

  const sGood = rc.rcScore(good, holdout), sMuddled = rc.rcScore(muddled, holdout);
  check('a model that blames the wrong cause scores worse on held-out trade',
        sMuddled.medErr > sGood.medErr,
        'median error ' + sGood.medErr + ' vs ' + sMuddled.medErr + ' min');

  const counts = { totalClean: 900, items: 1 };
  const gate = rc.rcCheckGates(good, muddled, { pizzaBase: TRUE_BASE, itemBase: {}, margin: {} },
                               counts, { considered: 0, dropped: [] }, sGood, sMuddled);
  check('and the refit refuses it on those grounds alone',
        !gate.ok && gate.reasons.some(r => /holdout/.test(r)), JSON.stringify(gate.reasons));
  check('while the better one is allowed through',
        rc.rcCheckGates(muddled, good, { pizzaBase: TRUE_BASE, itemBase: {}, margin: {} },
                        counts, { considered: 0, dropped: [] }, sMuddled, sGood).ok);
  note('this gate did not exist: "the model improved" was an assumption, never a measurement');
}

// ---------------------------------------------------------------- cushions aimed at the target
//
// A real service has a long right tail — most orders run close to the median and a few
// run badly over — and the cushion exists to cover it. These orders carry one, so a
// cushion that is too thin genuinely misses the target rather than missing it by
// construction.
{
  const TAILED = PIZZAS.map(o => {
    const tail = 12 * Math.pow(rnd(), 3);      // usually small, occasionally ten minutes
    return Object.assign({}, o, { dur: o.dur + tail });
  });
  TAILED.attached = true;

  const thin = { itemBase: { margherita: TRUE_BASE }, fallback: { pizza: TRUE_BASE, drink: 5, baked: 3 },
                 ovenCurve: [[0,0],[20,5],[40,9],[70,12]], satCurveChef: [[0,0],[4,3],[8,6],[14,10]],
                 satCurveBarista: [[0,0]], qtyCurve: [[1,0]],
                 cushionPizzaByOven: [[0,1.5]], cushionPizzaByLoad: [[0,0]], maxQuote: 32, rangeWidth: 5 };
  const before = rc.rcScore(thin, TAILED);
  const notes = [];
  const cal = rc.rcCalibrateCushions(thin, TAILED, notes);
  const after = rc.rcScore(cal.model, TAILED);

  check('a cushion too thin to cover the café misses the target to begin with',
        before.coverage < RECAL_TARGET, 'coverage ' + (before.coverage*100).toFixed(0) + '%');
  check('and is widened until it hits it',
        after.coverage >= RECAL_TARGET && (cal.scale > 1 || cal.offset > 0),
        'coverage ' + (before.coverage*100).toFixed(0) + '% → ' + (after.coverage*100).toFixed(0) +
        '% at x' + cal.scale + ' +' + cal.offset + ' min');
  check('scaling alone could not have got there, so it added minutes instead',
        cal.offset > 0 || cal.scale <= 3.0,
        'chose x' + cal.scale + ' +' + cal.offset + ' min');
  check('and the widening is on the record',
        notes.some(n => /(scaled|widened)/.test(n) && /coverage/.test(n)), JSON.stringify(notes));
  note('the cushion was p85 of a filtered pool and assumed to land on 85% — nothing checked');
}

// ---------------------------------------------------------------- the two scales never mix
{
  const notes = [];
  const current = { itemBase: {}, version: 1, satCurveChef: [[0,7]], satCurveBarista: [[0,0]],
                    loadUnit: 'tickets' };
  const both = rc.rcMergeModel(current, { itemBase: {}, satCurveChef: [[0,0],[8,6]],
                                          satCurveBarista: [[0,0],[6,4]] }, notes);
  check('a refit that re-fitted both saturation curves declares the item scale',
        both.loadUnit === 'items', both.loadUnit);
  const one = rc.rcMergeModel(current, { itemBase: {}, satCurveChef: [[0,0],[8,6]] }, notes);
  check('one alone is not adopted, because the pair would then be on two scales',
        one.loadUnit === 'tickets' && JSON.stringify(one.satCurveChef) === '[[0,7]]',
        one.loadUnit + ' ' + JSON.stringify(one.satCurveChef));
  check('and that is said out loud', notes.some(n => /previous scale/.test(n)), JSON.stringify(notes));
  note('the pages read whichever queue loadUnit names; a mixed model rescales it silently');
}

// ---------------------------------------------------------------- the whole path, on a real-shaped café
//
// Everything above drives one piece. This drives the run: a café with both stations,
// pizzas, drinks and desserts, through derive → guard → merge → calibrate → gate, the
// same order runRecalibration uses. What it is looking for is that the path completes
// and produces a model the pages can actually read — a refit that throws is a model
// that silently stops being retrained, which is the failure this whole area is about.
{
  const orders = [];
  let t = Date.UTC(2026, 1, 1, 10, 0, 0);
  for (let i = 0; i < 2600; i++){
    t += 20000 + Math.floor(rnd()*40000);
    const r = rnd();
    let station, items, dur;
    if (r < 0.40){
      station = 'chef';
      const idle = [2,6,9,18,25,40,55,80][Math.floor(rnd()*8)];
      const qty = rnd() < 0.75 ? 1 : (rnd() < 0.7 ? 2 : 3);
      items = { 'Margherita': { qty: qty } };
      dur = 6 + trueOven(idle) + (qty-1)*3.5 + rnd()*2;
    } else if (r < 0.50){
      station = 'chef';
      items = { 'Garlic Bread': { qty: 1 } };      // hot food: no pizza key, no baked key
      dur = 8 + rnd()*3;
    } else if (r < 0.88){
      station = 'barista';
      items = { 'Latte': { qty: rnd() < 0.8 ? 1 : 2 } };
      dur = 5 + rnd()*3;
    } else {
      station = 'barista';
      items = { 'Carrot Cake': { qty: 1 } };
      dur = 3 + rnd()*1.5;
    }
    orders.push({ start: t, done: t + dur*60000, dur: dur, station: station,
                  items: items, table: 'T' + (i % 11) });
  }

  rc.rcAttach(orders);
  const { fit, hold } = rc.rcSplitWindow(orders, 0.20);
  check('the window splits into a fit and a holdout, newest last',
        fit.length > hold.length && hold.length > 0 &&
        hold[0].done >= fit[fit.length-1].done,
        fit.length + ' fitted / ' + hold.length + ' held out');

  const out = rc.rcDerive(fit, ['margherita'], ['cake']);
  const notes = out.notes;
  const current = { version: 4, itemBase: { margherita: 6, latte: 5, 'carrot cake': 3 },
                    fallback: { pizza: 7.5, hotfood: 8, drink: 5.5, baked: 3.1 },
                    pizzaKeys: ['margherita'], bakedKeys: ['cake'],
                    ovenCurve: [[0,0]], satCurveChef: [[0,7]], satCurveBarista: [[0,0]],
                    loadUnit: 'tickets', qtyCurve: [[1,0]],
                    cushionDrinkByLoad: [[0,4]], cushionPizzaByOven: [[0,4.7]],
                    cushionPizzaByLoad: [[0,0]], cushionHotfood: 5, cushionBaked: 2,
                    maxQuote: 32, rangeWidth: 5 };

  const guard = rc.rcGuardItemBase(current, out.derived, notes);
  out.derived.itemBase = guard.kept;
  const cal = rc.rcCalibrateCushions(rc.rcMergeModel(current, out.derived, notes), fit, notes);
  const candidate = cal.model;

  check('both stations had the volume to refit, so the queue moves to the item scale',
        candidate.loadUnit === 'items',
        'loadUnit ' + candidate.loadUnit + ', satBarista ' + JSON.stringify(candidate.satCurveBarista));
  check('hot food gets a derived cushion instead of the hand-picked 5 it shipped with',
        candidate.cushionHotfood != null && candidate.cushionHotfood !== 5,
        'cushionHotfood ' + candidate.cushionHotfood);
  check('and the model still carries every field the pages read',
        ['itemBase','fallback','pizzaKeys','bakedKeys','ovenCurve','satCurveChef',
         'satCurveBarista','qtyCurve','cushionDrinkByLoad','cushionPizzaByOven',
         'cushionPizzaByLoad','cushionHotfood','cushionBaked','maxQuote','rangeWidth',
         'loadUnit'].every(k => candidate[k] != null),
        JSON.stringify(Object.keys(candidate)));
  check('the version moved and the source says where it came from',
        candidate.version === 5 && candidate.source === 'recalibration',
        candidate.version + ' / ' + candidate.source);

  const holdClean = hold.filter(o => !rc.rcIsDessertAfterFood(o, orders));
  const sOld = rc.rcScore(current, holdClean), sNew = rc.rcScore(candidate, holdClean);
  const gate = rc.rcCheckGates(current, candidate, out.derived,
                               { totalClean: fit.length, items: Object.keys(guard.kept).length },
                               guard, sOld, sNew);
  check('and the refit derived from this café passes its own gates',
        gate.ok, JSON.stringify(gate.reasons));
  // The incumbent here is the model as it shipped, phantom +7 saturation floor and
  // all. It covers MORE of the holdout than the refit does — by over-quoting every
  // order — and is wrong by nearly twice as much. That is the case the gate has to get
  // right: coverage is a constraint to meet, not a score to maximise, or the refit
  // would refuse every model that stopped over-quoting.
  check('having met the coverage target and quoted them considerably closer',
        sNew.coverage >= RECAL_TARGET && sNew.medErr < sOld.medErr,
        'on-time ' + (sOld.coverage*100).toFixed(0) + '% → ' + (sNew.coverage*100).toFixed(0) +
        '%, typical error ' + sOld.medErr + ' → ' + sNew.medErr + ' min');
  check('and the over-quoting incumbent is not preferred just for covering more',
        sOld.coverage > sNew.coverage && sOld.medErr > sNew.medErr,
        'the shipped model covers ' + (sOld.coverage*100).toFixed(0) + '% by quoting long');
  note('every station, every category, in the order runRecalibration runs them');
  if (notes.length) note('the run said: ' + notes.join(' | '));
}

done();
