// A web order's prices come from the customer's browser and must never be
// trusted. Every line is re-priced against the live menu before the POS books
// anything, and any disagreement is put in front of staff rather than applied
// silently in either direction.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const src = readPage('pos.html');
const win = {};
const API = buildModule([
  extractFunction(src, 'menuPriceFor'),
  extractFunction(src, 'repriceWebOrder'),
], { window: win, Object, Math, String, parseFloat, parseInt },
   ['menuPriceFor', 'repriceWebOrder']);

// the menu, flattened the way the live listener flattens it
win.itemPriceMap = {
  'Latte (Regular)': 250,
  'Latte (Large)': 320,
  'Croissant': 180,
  'Truffle Pizza': 640,
  'Cold Brew (Regular)': 260,
};

const { check, note, done } = suite('Web order re-pricing');

// ---- an honest order passes through untouched
{
  const rp = API.repriceWebOrder({
    total: 680,
    items: { 'Latte (Regular)': { price: 250, qty: 2 }, 'Croissant': { price: 180, qty: 1 } }
  });
  check('honest order: nothing flagged', rp.mismatch === false);
  check('honest order: total preserved', rp.total === 680, 'total=' + rp.total);
  check('honest order: prices preserved', rp.items['Latte (Regular)'].price === 250);
  check('honest order: no lines listed as moved', rp.moved.length === 0 && rp.unknown.length === 0);
}

// ---- THE EXPLOIT: prices rewritten in the browser
{
  const rp = API.repriceWebOrder({
    total: 40,
    items: { 'Truffle Pizza': { price: 20, qty: 2 } }        // really ₹640 each
  });
  check('tampered prices are caught', rp.mismatch === true);
  check('the line is re-priced from the menu', rp.items['Truffle Pizza'].price === 640,
        'price=' + rp.items['Truffle Pizza'].price);
  check('the total is recomputed to ₹1280', rp.total === 1280, 'total=' + rp.total);
  check('the submitted total is kept, for the warning', rp.sentTotal === 40);
  check('the moved line is named for staff', rp.moved.length === 1 && /Truffle Pizza/.test(rp.moved[0]),
        JSON.stringify(rp.moved));
  note('₹40 for ₹1280 of pizza: this was bookable, and it matched a ₹40 credit as VERIFIED');
}

// ---- only the total is tampered, the lines are honest
{
  const rp = API.repriceWebOrder({ total: 1, items: { 'Latte (Regular)': { price: 250, qty: 1 } } });
  check('a tampered total alone is caught', rp.mismatch === true);
  check('the total is corrected', rp.total === 250, 'total=' + rp.total);
  check('no line is blamed', rp.moved.length === 0);
}

// ---- a tampered quantity cannot inflate or deflate the money
{
  const rp = API.repriceWebOrder({ total: 250, items: { 'Latte (Regular)': { price: 250, qty: 10 } } });
  check('quantity × menu price drives the total', rp.total === 2500, 'total=' + rp.total);
  check('the quantity mismatch is caught', rp.mismatch === true);
}

// ---- sweetness is a suffix the customer app appends and never charges for
{
  check('plain item + sweetness', API.menuPriceFor('Croissant (Medium sweet)') === 180);
  check('sized item + sweetness', API.menuPriceFor('Latte (Large) (No sweetness)') === 320);
  check('sized item on its own', API.menuPriceFor('Latte (Large)') === 320);
  const rp = API.repriceWebOrder({
    total: 430,
    items: { 'Latte (Regular) (Very sweet)': { price: 250, qty: 1 }, 'Croissant (Less sweet)': { price: 180, qty: 1 } }
  });
  check('a sweetened order re-prices cleanly and is not flagged',
        rp.mismatch === false && rp.total === 430, 'total=' + rp.total + ' mismatch=' + rp.mismatch);
}

// ---- an item that is not on the menu at all
{
  const rp = API.repriceWebOrder({ total: 5, items: { 'Free Gold Bar': { price: 5, qty: 1 } } });
  check('an unknown item is flagged', rp.unknown.length === 1, JSON.stringify(rp.unknown));
  check('an unknown item forces the confirmation', rp.mismatch === true);
  check('an unknown item keeps its submitted price', rp.items['Free Gold Bar'].price === 5);
  check('the confirmation names it, with quantity and price',
        /Free Gold Bar/.test(rp.unknown[0]) && /5/.test(rp.unknown[0]));
}

// ---- a legitimately retired item alongside live ones
{
  const rp = API.repriceWebOrder({
    total: 430, items: { 'Croissant': { price: 180, qty: 1 }, 'Retired Cake': { price: 250, qty: 1 } }
  });
  check('the live line is still priced from the menu', rp.items['Croissant'].price === 180);
  check('the retired line is carried at its submitted price', rp.items['Retired Cake'].price === 250);
  check('both are counted in the total', rp.total === 430, 'total=' + rp.total);
  check('staff still have to decide', rp.mismatch === true);
  note('a renamed menu item must not block a real, paid order — it goes to staff instead');
}

// ---- quantities are sanitised
{
  const rp = API.repriceWebOrder({
    total: 0, items: {
      'Croissant': { price: 180, qty: -5 },          // negative → dropped
      'Latte (Regular)': { price: 250, qty: '3' },   // string → 3
      'Latte (Large)': { price: 320, qty: 0 },       // zero → dropped
    }
  });
  check('a negative quantity is dropped', !rp.items['Croissant']);
  check('a zero quantity is dropped', !rp.items['Latte (Large)']);
  check('a string quantity is coerced', rp.items['Latte (Regular)'].qty === 3);
  check('no negative money can be created', rp.total === 750, 'total=' + rp.total);
}

// ---- a non-numeric price
{
  const rp = API.repriceWebOrder({ total: 0, items: { 'Croissant': { price: 'free', qty: 1 } } });
  check('a non-numeric price is replaced from the menu', rp.items['Croissant'].price === 180);
  check('the total stays a real number', rp.total === 180, 'total=' + rp.total);
}

// ---- the submitted order is never mutated
{
  const order = { total: 40, items: { 'Truffle Pizza': { price: 20, qty: 1 } } };
  API.repriceWebOrder(order);
  check('the submitted order is left untouched',
        order.total === 40 && order.items['Truffle Pizza'].price === 20);
}

// ---- line metadata survives re-pricing
{
  const rp = API.repriceWebOrder({
    total: 250, items: { 'Latte (Regular)': { price: 250, qty: 1, base: 'Latte', mods: ['Oat milk'] } }
  });
  check('base name carried through', rp.items['Latte (Regular)'].base === 'Latte');
  check('modifiers carried through', rp.items['Latte (Regular)'].mods[0] === 'Oat milk');
}

// ---- paise-level arithmetic
{
  win.itemPriceMap['Chai'] = 111.11;
  const rp = API.repriceWebOrder({ total: 333.33, items: { 'Chai': { price: 111.11, qty: 3 } } });
  check('no float dust in the total', rp.total === 333.33, 'total=' + rp.total);
  check('an exact match is not flagged', rp.mismatch === false);
  delete win.itemPriceMap['Chai'];
}

// ---- malformed input must not throw on the counter
{
  check('an empty order', API.repriceWebOrder({ total: 0, items: {} }).total === 0);
  check('an order with no items key', API.repriceWebOrder({ total: 0 }).total === 0);
  check('a null order', API.repriceWebOrder(null).total === 0);
}

done();
