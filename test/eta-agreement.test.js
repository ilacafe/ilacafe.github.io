// The counter, the ordering page and the monthly refit must quote the same wait for
// the same cart in the same kitchen. Three copies of one formula, and nothing but this
// suite holding them together.
//
// The first two diverged twice, and both are asserted here:
//
//   1. The kitchen-tempo multiplier existed only in the ordering page. pos.html had
//      no tempo concept at all, so whenever the kitchen was running off-pace the two
//      diverged — and since the POS stamps its estimate onto the order, admin's ETA
//      accuracy report was scoring a number no customer was ever shown.
//
//   2. The POS splits items across stations using the routing configured per item in
//      admin; the ordering page guessed from the name alone. Anything routed to the
//      chef that is not recognised as a pizza — garlic bread, hot food — landed on
//      the barista in one and the chef in the other. The chef saturation curve starts
//      seven minutes above the barista's, so that alone moved the quote.
//
// The third copy is new: the refit now replays the estimate to ask whether a candidate
// model would have quoted the last month's orders better than the model it is
// replacing. That is the only way to gate a refit on accuracy rather than on plausible-
// looking coefficients, and it costs a third copy of the formula in worker.js. This
// suite is the price of that copy — rcQuote is driven here beside the other two.
//
// It also drives them on DIFFERENT CLOCKS. Every timestamp the estimate reads is
// stamped by the server; the devices reading them are a counter iPad, a customer's
// handset and a Worker, and all three used to subtract their own Date.now(). The suite
// could never see it, because it handed every side the same machine's clock. Now each
// side gets its own skew, and the answers still have to match.

const { readPage, extractFunction, extractAssignedFunction, buildModule, suite } = require('./helpers');

const pos = readPage('pos.html');
const idx = readPage('index.html');
const wkr = readPage('worker/worker.js');

// One menu, shaped as admin writes it, driving both pages.
const MENU = {
  'Coffee': {
    'Latte':     { hasSizes: true, priceReg: 250, priceLrg: 320, routing: 'barista' },
    'Cortado':   { price: 180, routing: 'barista' },
  },
  'Pizza': {
    'Margherita':    { price: 480, routing: 'chef' },
    'Pesto Burrata': { price: 620, routing: 'chef' },
  },
  // the case that used to diverge: chef-routed, but nothing in the name says pizza
  'Kitchen': { 'Garlic Bread': { price: 260, routing: 'chef' },
               // and one the model has never measured, so it lands on a category fallback
               'Soup of the Day': { price: 240, routing: 'chef' } },
  'Bakery':  { 'Carrot Cake':  { price: 220, routing: 'barista' } },
};

const MODEL = JSON.parse(JSON.stringify(
  eval('(' + idx.slice(idx.indexOf('const ETA_DEF = {') + 'const ETA_DEF = '.length,
                        idx.indexOf('};', idx.indexOf('const ETA_DEF = {')) + 1) + ')')));

// Every timestamp in the estimate is stamped by the server. The devices reading them
// are a counter iPad, a customer's handset and a Worker, and each has its own wrong
// clock — so each module below is handed a Date whose now() is wrong by this much, and
// a serverTimeOffset that should cancel it exactly. A side that reaches for its own
// Date.now() anywhere in the estimate is then off by its error, and the agreement
// breaks; a side that goes through serverNow() reads the true server clock and agrees.
//
// This is the failure the old suite could not see. It gave every estimator the same
// machine's clock, so the one bug the agreement is meant to catch — a page measuring a
// server timestamp against the handset — was invisible to it. A phone a quarter of an
// hour fast read the oven as a quarter of an hour colder than it was, which is worth up
// to twelve minutes of oven curve on a pizza, and nothing anywhere said so.
const DEVICE_ERR = { pos: -7*60000, cust: +15*60000 };
const posClock  = { err: 0 };               // the counter iPad's error against the server
const custClock = { err: 0 };               // the handset's
let NOW = Date.now();                       // the server's clock, the one truth here

// ---------------------------------------------------------------- the POS estimator
const posWin = { etaModel: MODEL, etaLoad: { chef: 0, barista: 0 }, etaWork: { chef: 0, barista: 0 },
                 etaLastPizzaOutMs: 0, etaTempo: 1.0, itemRoutingMap: {}, cart: {} };
const posApi = buildModule([
  'function lc(s){ return (s||"").toLowerCase(); }',
  // serverTimeOffset is the server's clock MINUS this device's, so it cancels the
  // device's error exactly. Date.now() below is the wrong one; serverNowSafe is not.
  'function serverNowSafe(){ return Date.now() - POSCLOCK.err; }',
  extractFunction(pos, 'interp'),
  extractFunction(pos, 'isPizza'),
  extractFunction(pos, 'isBaked'),
  extractFunction(pos, 'itemBaseTime'),
  extractAssignedFunction(pos, 'estimateETA'),
], { window: posWin, POSCLOCK: posClock, Math, Object, parseInt, parseFloat,
     Date: { now: () => Date.now() + posClock.err } }, ['estimateETA']);

// ---------------------------------------------------------------- the ordering page estimator
const custWin = { custRouting: {} };
const custApi = buildModule([
  'let loadChef = 0, loadBar = 0, workChef = 0, workBar = 0, lastPizzaOut = 0, kitchenTempo = 1.0, skew = 0;',
  'function setState(s){ loadChef = s.loadChef; loadBar = s.loadBar; workChef = s.workChef; workBar = s.workBar; lastPizzaOut = s.lastPizzaOut; kitchenTempo = s.kitchenTempo; skew = s.skew || 0; }',
  'function serverNow(){ return Date.now() + skew; }',
  'function lc(s){return(s||"").toLowerCase();}',
  extractFunction(idx, 'interp'),
  extractFunction(idx, 'isPizza'),
  extractFunction(idx, 'isBaked'),
  extractFunction(idx, 'itemBase'),
  extractFunction(idx, 'custRouteFor'),
  extractAssignedFunction(idx, 'custEstimateETA'),
], { window: custWin, MODEL, Math, Object, parseInt, parseFloat,
     Date: { now: () => Date.now() + custClock.err } },
   ['custEstimateETA', 'setState']);

// ---------------------------------------------------------------- the refit's replay
// The Worker classifies through the lists it settles from the model, the same fields
// the pages read, so the comparison below is between the coefficients and nothing else.
const wkrDecls = [/^const RC_PIZZA_FALLBACK\s*=.*$/m, /^const RC_BAKED_FALLBACK\s*=.*$/m,
                  /^let _rcPizzaKeys\s*=.*$/m, /^let _rcBakedKeys\s*=.*$/m]
  .map(re => { const m = wkr.match(re); if (!m) throw new Error('missing declaration: ' + re); return m[0]; });
const wkrApi = buildModule([
  ...wkrDecls,
  extractFunction(wkr, 'rcCleanKeys'),
  extractFunction(wkr, 'rcUsePizzaKeys'),
  extractFunction(wkr, 'rcUseBakedKeys'),
  extractFunction(wkr, 'rcIsPizza'),
  extractFunction(wkr, 'rcIsBaked'),
  extractFunction(wkr, 'rcQty'),
  extractFunction(wkr, 'rcInterp'),
  extractFunction(wkr, 'rcModelBase'),
  extractFunction(wkr, 'rcQuote'),
], { Array, String, Math, Object, parseInt, isNaN },
   ['rcQuote', 'rcUsePizzaKeys', 'rcUseBakedKeys']);
wkrApi.rcUsePizzaKeys(MODEL.pizzaKeys);
wkrApi.rcUseBakedKeys(MODEL.bakedKeys);

// ---------------------------------------------------------------- shared setup
// Both pages flatten the same menu into their own routing map, the way each does it.
function loadMenu(menu) {
  const posMap = {}, custMap = {};
  for (const cat in menu) for (const item in menu[cat]) {
    const def = menu[cat][item], r = def.routing || 'barista';
    posMap[item] = r; custMap[item] = r;
    if (def.hasSizes) ['Regular', 'Large'].forEach(sz => {
      posMap[item + ' (' + sz + ')'] = r; custMap[item + ' (' + sz + ')'] = r;
    });
  }
  posWin.itemRoutingMap = posMap;
  custWin.custRouting = custMap;
}
loadMenu(MENU);

// `skewed` decides whether each side reads the shared server timestamps through its own
// wrong clock or through a correct one.
function setKitchen(k, skewed) {
  posClock.err  = skewed ? DEVICE_ERR.pos  : 0;
  custClock.err = skewed ? DEVICE_ERR.cust : 0;
  posWin.etaLoad = { chef: k.chef, barista: k.barista };
  posWin.etaWork = { chef: k.workChef != null ? k.workChef : k.chef,
                     barista: k.workBar != null ? k.workBar : k.barista };
  posWin.etaLastPizzaOutMs = k.lastPizzaOut;
  posWin.etaTempo = k.tempo;
  custApi.setState({ loadChef: k.chef, loadBar: k.barista,
                     workChef: posWin.etaWork.chef, workBar: posWin.etaWork.barista,
                     lastPizzaOut: k.lastPizzaOut, kitchenTempo: k.tempo,
                     skew: -custClock.err });
}

const { check, note, done } = suite('ETA agreement — the counter, the app and the refit');

const now = NOW;
const CARTS = {
  'one latte':                 { 'Latte (Regular)': { qty: 1 } },
  'two pizzas':                { 'Margherita': { qty: 2 } },
  'garlic bread (chef-routed, not a pizza)': { 'Garlic Bread': { qty: 1 } },
  'an unmeasured chef dish':   { 'Soup of the Day': { qty: 1 } },
  'garlic bread + a latte':    { 'Garlic Bread': { qty: 1 }, 'Latte (Regular)': { qty: 1 } },
  'pizza + drinks':            { 'Pesto Burrata': { qty: 1 }, 'Cortado': { qty: 2 } },
  'a sweetened sized drink':   { 'Latte (Large) (Very sweet)': { qty: 1 } },
  'dessert only':              { 'Carrot Cake': { qty: 1 } },
  'a big mixed order':         { 'Margherita': { qty: 2 }, 'Garlic Bread': { qty: 1 },
                                 'Latte (Regular)': { qty: 3 }, 'Carrot Cake': { qty: 1 } },
  'the order that used to hit the cap': { 'Margherita': { qty: 4 } },
};

const KITCHENS = [
  { name: 'quiet, oven hot, on pace',   chef: 0, barista: 0, lastPizzaOut: now - 2*60000,  tempo: 1.0 },
  { name: 'busy, oven hot, on pace',    chef: 5, barista: 4, lastPizzaOut: now - 3*60000,  tempo: 1.0 },
  { name: 'quiet, oven cold',           chef: 0, barista: 0, lastPizzaOut: now - 40*60000, tempo: 1.0 },
  { name: 'busy, oven cold, running slow', chef: 6, barista: 5, lastPizzaOut: now - 50*60000, tempo: 1.25 },
  { name: 'running fast',               chef: 2, barista: 2, lastPizzaOut: now - 5*60000,  tempo: 0.85 },
  { name: 'no pizza out all day',       chef: 1, barista: 1, lastPizzaOut: 0,              tempo: 1.0 },
];

// ---------------------------------------------------------------- the two pages agree
for (const skewed of [false, true]) {
  let mismatches = 0, compared = 0;
  for (const k of KITCHENS) {
    setKitchen(k, skewed);
    for (const label in CARTS) {
      const a = posApi.estimateETA(CARTS[label]);
      const b = custApi.custEstimateETA(CARTS[label]);
      compared++;
      if (!a || !b) { mismatches++; console.log('    null estimate: ' + label); continue; }
      if (a.low !== b.low || a.high !== b.high || !!a.capped !== !!b.capped) {
        mismatches++;
        if (mismatches <= 4) console.log('    \x1b[31m' + k.name + ' / ' + label +
          '\x1b[0m  counter ' + a.label + '  vs  app ' + b.label);
      }
    }
  }
  check(compared + ' cart × kitchen combinations agree exactly' +
        (skewed ? ', on three different clocks' : ''), mismatches === 0,
        mismatches + ' differed');
}
note(Object.keys(CARTS).length + ' carts across ' + KITCHENS.length + ' kitchen states');
note('the skewed pass is the one that matters: the counter\u2019s own clock is ' +
     (DEVICE_ERR.pos/60000) + ' min out and the handset\u2019s ' + (DEVICE_ERR.cust/60000) + ' min');

// ---------------------------------------------------------------- and so does the refit's replay
// Single-station carts only: a completed ticket is already a per-station split, so the
// Worker has no second station to take the slower of.
{
  const SINGLE = {
    'one latte':               { cart: { 'Latte (Regular)': { qty: 1 } }, station: 'barista' },
    'two pizzas':              { cart: { 'Margherita': { qty: 2 } },      station: 'chef' },
    'four pizzas (past the cap)': { cart: { 'Margherita': { qty: 4 } },   station: 'chef' },
    'garlic bread':            { cart: { 'Garlic Bread': { qty: 1 } },    station: 'chef' },
    'an unmeasured chef dish': { cart: { 'Soup of the Day': { qty: 1 } }, station: 'chef' },
    'dessert only':            { cart: { 'Carrot Cake': { qty: 1 } },     station: 'barista' },
    'two cortados':            { cart: { 'Cortado': { qty: 2 } },         station: 'barista' },
  };
  let mismatches = 0, compared = 0;
  for (const k of KITCHENS) {
    setKitchen(k, true);
    const idleMin = k.lastPizzaOut ? Math.max(0, (now - k.lastPizzaOut)/60000) : 999;
    for (const label in SINGLE) {
      const { cart, station } = SINGLE[label];
      // tempo 1.0 both sides: the refit has no record of the live tempo at the time
      // and does not invent one, so the comparison is made where they can agree.
      setKitchen(Object.assign({}, k, { tempo: 1.0 }), true);
      const a = posApi.estimateETA(cart);
      const b = wkrApi.rcQuote(MODEL, { station: station, items: cart,
                                        ahead: station === 'chef' ? k.chef : k.barista,
                                        idle: idleMin });
      compared++;
      if (!a || !b) { mismatches++; console.log('    null estimate: ' + label); continue; }
      if (a.low !== b.low || a.high !== b.high || !!a.capped !== !!b.capped) {
        mismatches++;
        if (mismatches <= 4) console.log('    \x1b[31m' + k.name + ' / ' + label +
          '\x1b[0m  counter ' + a.low + '–' + a.high + '  vs  refit ' + b.low + '–' + b.high);
      }
    }
  }
  check(compared + ' single-station quotes match the refit’s replay', mismatches === 0,
        mismatches + ' differed');
  note('without this the refit would gate on a formula that is not the one shipping');
}

// The comparison is only meaningful if these inputs actually move the number.
{
  // A kitchen with something for tempo to scale. Tempo touches only the condition-
  // driven part of the estimate — never the base time or the cushion — so a quiet
  // station with a hot oven has almost nothing for it to move, and since the phantom
  // +7 saturation floor came out that is now genuinely true rather than hidden by it.
  const cart = { 'Margherita': { qty: 1 } };
  const at = t => { setKitchen({ chef: 6, barista: 0, lastPizzaOut: now - 20*60000, tempo: t }, false);
                    return posApi.estimateETA(cart); };
  const slowKitchen = at(1.25), onPace = at(1.0), fastKitchen = at(0.85);
  check('tempo actually moves the counter’s quote, in both directions',
        slowKitchen.high > onPace.high && fastKitchen.high < onPace.high,
        [fastKitchen.label, onPace.label, slowKitchen.label].join(' | '));
  note('running fast ' + fastKitchen.label + ' · on pace ' + onPace.label +
       ' · running slow ' + slowKitchen.label);

  setKitchen({ chef: 6, barista: 0, lastPizzaOut: now - 20*60000, tempo: 1.25 }, false);
  const appSlow = custApi.custEstimateETA(cart);
  check('and the ordering page moves with it', appSlow.high === slowKitchen.high,
        'counter ' + slowKitchen.label + ' vs app ' + appSlow.label);
}
{
  setKitchen({ chef: 4, barista: 0, lastPizzaOut: now - 2*60000, tempo: 1.0 }, false);
  const routed = custApi.custEstimateETA(CARTS['garlic bread (chef-routed, not a pizza)']);
  const saved = custWin.custRouting;
  custWin.custRouting = {};
  const guessed = custApi.custEstimateETA(CARTS['garlic bread (chef-routed, not a pizza)']);
  custWin.custRouting = saved;
  check('routing actually changes which station a non-pizza chef item lands on',
        routed.high !== guessed.high, routed.label + ' vs ' + guessed.label);
  note('with routing → ' + routed.label + ',  guessing from the name → ' + guessed.label);
}

// ---------------------------------------------------------------- the clock is load-bearing
//
// The skewed pass above can only catch a DISAGREEMENT. If all three sides read the
// wrong clock in the same way they would agree perfectly and still be wrong, so this
// asks the other question: does the skew change the answer at all? It must not.
{
  const cart = { 'Margherita': { qty: 1 } };
  const kitchen = { chef: 1, barista: 0, lastPizzaOut: now - 12*60000, tempo: 1.0 };
  setKitchen(kitchen, false); const trueQuote = posApi.estimateETA(cart);
  setKitchen(kitchen, true);  const skewQuote = posApi.estimateETA(cart);
  check('a counter with a wrong clock still quotes the true oven idle',
        trueQuote.low === skewQuote.low && trueQuote.high === skewQuote.high,
        'true ' + trueQuote.label + ' vs skewed ' + skewQuote.label);
  setKitchen(kitchen, false); const trueApp = custApi.custEstimateETA(cart);
  setKitchen(kitchen, true);  const skewApp = custApi.custEstimateETA(cart);
  check('and so does a handset with one', trueApp.low === skewApp.low && trueApp.high === skewApp.high,
        'true ' + trueApp.label + ' vs skewed ' + skewApp.label);
  note('both read .info/serverTimeOffset, so the device’s own clock leaves the question');
}

// ---------------------------------------------------------------- the quote stops promising
{
  setKitchen({ chef: 8, barista: 0, lastPizzaOut: now - 45*60000, tempo: 1.0 }, false);
  const one = posApi.estimateETA({ 'Margherita': { qty: 1 } });
  const two = posApi.estimateETA({ 'Margherita': { qty: 2 } });
  const four = posApi.estimateETA({ 'Margherita': { qty: 4 } });
  check('a kitchen this deep no longer quotes the same wait for one pizza and four',
        !(one.low === two.low && two.low === four.low),
        [one.label, two.label, four.label].join(' | '));
  check('and an estimate past the model’s range says so instead of clamping',
        four.capped === true && /\+ min$/.test(four.label), four.label);
  check('the range is still closed when the model will vouch for it',
        (() => { setKitchen(KITCHENS[0], false);
                 const q = posApi.estimateETA({ 'Cortado': { qty: 1 } });
                 return q.capped === false && /–/.test(q.label); })());
  note('one \u2192 four pizzas behind a cold oven: ' + [one.label, two.label, four.label].join(' · '));
  note('this used to read “30–35 min” for all three');
}

done();
