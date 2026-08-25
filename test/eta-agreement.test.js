// The counter and the ordering page must quote the same wait for the same cart in
// the same kitchen. They did not.
//
// Two reasons, both fixed and both asserted here:
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
// This runs both real estimators over the same carts and kitchen state and requires
// the answers to be identical.

const { readPage, extractFunction, extractAssignedFunction, buildModule, suite } = require('./helpers');

const pos = readPage('pos.html');
const idx = readPage('index.html');

// One menu, shaped as admin writes it, driving both sides.
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
  'Kitchen': { 'Garlic Bread': { price: 260, routing: 'chef' } },
  'Bakery':  { 'Carrot Cake':  { price: 220, routing: 'barista' } },
};

const MODEL = JSON.parse(JSON.stringify(
  eval('(' + idx.slice(idx.indexOf('const ETA_DEF = {') + 'const ETA_DEF = '.length,
                        idx.indexOf('};', idx.indexOf('const ETA_DEF = {')) + 1) + ')')));

// ---------------------------------------------------------------- the POS estimator
const posWin = { etaModel: MODEL, etaLoad: { chef: 0, barista: 0 }, etaLastPizzaOutMs: 0,
                 etaTempo: 1.0, itemRoutingMap: {}, cart: {} };
const posApi = buildModule([
  'function lc(s){ return (s||"").toLowerCase(); }',
  'function serverNowSafe(){ return Date.now(); }',
  extractFunction(pos, 'interp'),
  extractFunction(pos, 'isPizza'),
  extractFunction(pos, 'isBaked'),
  extractFunction(pos, 'itemBaseTime'),
  extractAssignedFunction(pos, 'estimateETA'),
], { window: posWin, Math, Date, Object, parseInt, parseFloat }, ['estimateETA']);

// ---------------------------------------------------------------- the ordering page estimator
const custWin = { custRouting: {} };
const custState = { loadChef: 0, loadBar: 0, lastPizzaOut: 0, kitchenTempo: 1.0 };
const custApi = buildModule([
  'let loadChef = 0, loadBar = 0, lastPizzaOut = 0, kitchenTempo = 1.0;',
  'function setState(s){ loadChef = s.loadChef; loadBar = s.loadBar; lastPizzaOut = s.lastPizzaOut; kitchenTempo = s.kitchenTempo; }',
  'function lc(s){return(s||"").toLowerCase();}',
  extractFunction(idx, 'interp'),
  extractFunction(idx, 'isPizza'),
  extractFunction(idx, 'isBaked'),
  extractFunction(idx, 'itemBase'),
  extractFunction(idx, 'custRouteFor'),
  extractAssignedFunction(idx, 'custEstimateETA'),
], { window: custWin, MODEL, Math, Date, Object, parseInt, parseFloat },
   ['custEstimateETA', 'setState']);

// ---------------------------------------------------------------- shared setup
// Both sides flatten the same menu into their own routing map, the way each page does.
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

function setKitchen(k) {
  posWin.etaLoad = { chef: k.chef, barista: k.barista };
  posWin.etaLastPizzaOutMs = k.lastPizzaOut;
  posWin.etaTempo = k.tempo;
  custApi.setState({ loadChef: k.chef, loadBar: k.barista,
                     lastPizzaOut: k.lastPizzaOut, kitchenTempo: k.tempo });
}

const { check, note, done } = suite('ETA agreement — the counter and the ordering page');

const now = Date.now();
const CARTS = {
  'one latte':                 { 'Latte (Regular)': { qty: 1 } },
  'two pizzas':                { 'Margherita': { qty: 2 } },
  'garlic bread (chef-routed, not a pizza)': { 'Garlic Bread': { qty: 1 } },
  'garlic bread + a latte':    { 'Garlic Bread': { qty: 1 }, 'Latte (Regular)': { qty: 1 } },
  'pizza + drinks':            { 'Pesto Burrata': { qty: 1 }, 'Cortado': { qty: 2 } },
  'a sweetened sized drink':   { 'Latte (Large) (Very sweet)': { qty: 1 } },
  'dessert only':              { 'Carrot Cake': { qty: 1 } },
  'a big mixed order':         { 'Margherita': { qty: 2 }, 'Garlic Bread': { qty: 1 },
                                 'Latte (Regular)': { qty: 3 }, 'Carrot Cake': { qty: 1 } },
};

const KITCHENS = [
  { name: 'quiet, oven hot, on pace',   chef: 0, barista: 0, lastPizzaOut: now - 2*60000,  tempo: 1.0 },
  { name: 'busy, oven hot, on pace',    chef: 5, barista: 4, lastPizzaOut: now - 3*60000,  tempo: 1.0 },
  { name: 'quiet, oven cold',           chef: 0, barista: 0, lastPizzaOut: now - 40*60000, tempo: 1.0 },
  { name: 'busy, oven cold, running slow', chef: 6, barista: 5, lastPizzaOut: now - 50*60000, tempo: 1.25 },
  { name: 'running fast',               chef: 2, barista: 2, lastPizzaOut: now - 5*60000,  tempo: 0.85 },
  { name: 'no pizza out all day',       chef: 1, barista: 1, lastPizzaOut: 0,              tempo: 1.0 },
];

let mismatches = 0, compared = 0, moved = 0;
for (const k of KITCHENS) {
  setKitchen(k);
  for (const label in CARTS) {
    const a = posApi.estimateETA(CARTS[label]);
    const b = custApi.custEstimateETA(CARTS[label]);
    compared++;
    if (!a || !b) { mismatches++; console.log('    null estimate: ' + label); continue; }
    if (a.low !== b.low || a.high !== b.high) {
      mismatches++;
      if (mismatches <= 4) console.log('    \x1b[31m' + k.name + ' / ' + label +
        '\x1b[0m  counter ' + a.label + '  vs  app ' + b.label);
    }
    if (k.tempo !== 1.0 || /Garlic/.test(label)) moved++;
  }
}
check(compared + ' cart × kitchen combinations agree exactly', mismatches === 0,
      mismatches + ' differed');
note(Object.keys(CARTS).length + ' carts across ' + KITCHENS.length + ' kitchen states');

// The comparison is only meaningful if these inputs actually move the number.
{
  // Kept below MODEL.maxQuote (32 min) on purpose: a busy cold-oven double pizza
  // already quotes at the cap, so tempo has nowhere to show and the check would
  // pass or fail for the wrong reason.
  const cart = { 'Margherita': { qty: 1 } };
  const at = t => { setKitchen({ chef: 3, barista: 0, lastPizzaOut: now - 2*60000, tempo: t });
                    return posApi.estimateETA(cart); };
  const slowKitchen = at(1.25), onPace = at(1.0), fastKitchen = at(0.85);
  check('tempo actually moves the counter’s quote, in both directions',
        slowKitchen.high > onPace.high && fastKitchen.high < onPace.high,
        [fastKitchen.label, onPace.label, slowKitchen.label].join(' | '));
  note('running fast ' + fastKitchen.label + ' · on pace ' + onPace.label +
       ' · running slow ' + slowKitchen.label);

  // and the ordering page moves with it, by the same amount
  setKitchen({ chef: 3, barista: 0, lastPizzaOut: now - 2*60000, tempo: 1.25 });
  const appSlow = custApi.custEstimateETA(cart);
  check('and the ordering page moves with it', appSlow.high === slowKitchen.high,
        'counter ' + slowKitchen.label + ' vs app ' + appSlow.label);
}
{
  setKitchen({ chef: 4, barista: 0, lastPizzaOut: now - 2*60000, tempo: 1.0 });
  const routed = custApi.custEstimateETA(CARTS['garlic bread (chef-routed, not a pizza)']);
  // strip the routing and the ordering page falls back to the name heuristic
  const saved = custWin.custRouting;
  custWin.custRouting = {};
  const guessed = custApi.custEstimateETA(CARTS['garlic bread (chef-routed, not a pizza)']);
  custWin.custRouting = saved;
  check('routing actually changes which station a non-pizza chef item lands on',
        routed.high !== guessed.high, routed.label + ' vs ' + guessed.label);
  note('with routing → ' + routed.label + ',  guessing from the name → ' + guessed.label);
}

done();
