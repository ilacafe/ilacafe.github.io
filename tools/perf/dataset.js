// A café's database, at whatever size you want to ask about.
//
// Every record here is the shape the app actually writes — a bill is what pos.html
// pushes to pos/bills, an order is the archivePacket it puts in orders/history, a
// closing is what promptEOD stores. That matters more than it sounds: the first
// version of the eodArchive measurement invented plausible-looking bills and came out
// 26% low, because the real ones carry per-item `base` and `mods` for add-ons.
//
// The knobs are the CAFÉ's, not the test's — how busy it is and how long it has been
// open — because those are the questions worth asking. "Is analytics slow?" has no
// answer; "is analytics slow after eighteen months at a hundred bills a day?" does.
//
//   DAYS_OPEN=550 BILLS_DAY=100 CUSTOMERS=4000   (the defaults)
//
// Nothing here is written anywhere. It is handed to a page through the stub beside
// this file, which answers queries out of it the way Firebase would.

const DAYS_OPEN = Number(process.env.DAYS_OPEN || 550);      // ~18 months
const BILLS_DAY = Number(process.env.BILLS_DAY || 100);
const CUSTOMERS = Number(process.env.CUSTOMERS || 4000);
const EOD_DAYS  = 120;                                       // what analytics and admin ask for

// A REAL MENU'S WORTH, BECAUSE THE ROLLUP'S SIZE DEPENDS ON IT
//
// A day's rollup carries one entry per distinct item sold that day, so a fixture with
// six items makes orders/daily look far smaller than it is. Six reported it 69× smaller
// than the history; a menu-sized list is the honest comparison. The café's menu below
// is 112 items and a day sells a good spread of them.
const ITEMS = (() => {
  const names = ['Latte', 'Cappuccino', 'Flat White', 'Americano', 'Espresso', 'Mocha',
                 'Masala Chai', 'Green Tea', 'Lemon Iced Tea', 'Cold Brew', 'Frappe',
                 'Pizza Margherita', 'Pizza Pepperoni', 'Garlic Bread', 'Toastie',
                 'Club Sandwich', 'Pasta Alfredo', 'Pasta Arrabiata', 'Caesar Salad',
                 'Greek Salad', 'Brownie', 'Cheesecake', 'Banana Bread', 'Croissant',
                 'Muffin', 'Cookie', 'Chocolate Shake', 'Vanilla Shake', 'Oreo Shake',
                 'Mango Smoothie', 'Fries', 'Wedges', 'Nachos', 'Soup of the Day',
                 'Quiche', 'Bagel', 'Focaccia', 'Tiramisu', 'Affogato', 'Hot Chocolate'];
  return names;
})();
const CATS  = ['Coffee', 'Tea', 'Food', 'Bakery', 'Cold', 'Shakes', 'Desserts', 'Extras'];
const now = Date.now(), DAY = 86400000;

// `base` and `mods` ride along on every line so add-ons stay countable in pos/bills
// and orders/history — see the comment at that push in pos.html.
const itemsBlock = (n, i) => {
  const o = {};
  for (let k = 0; k < n; k++) {
    const nm = ITEMS[(i * 7 + k * 13) % ITEMS.length];
    o[nm] = { qty: 1 + (k % 2), price: 100 + (k * 17) % 150, base: 100, mods: [] };
  }
  return o;
};

const bill = i => ({                                   // pos.html localBill
  id: now - i * 1000, table: i % 9 ? 'Table ' + (i % 9) : 'Takeaway',
  date: '14:32 - 03/09/2026', items: itemsBlock(2, i), total: 200 + (i % 700),
  notes: '', phone: i % 4 ? null : '90000000' + (i % 90) });

const ledgerRow = i => ({                              // pos.html entry, plus the
  date: '14:32', type: i % 2 ? 'upi_income' : 'cash_income',   // verifyState EOD folds in
  amount: 200 + (i % 700), reason: 'Table ' + (i % 9), ts: now - i * 1000,
  payId: 'p' + i, state: 'verified', ref: 'UPI' + i + 'REF00', bankTag: 'yes 8020',
  verifyState: 'verified-bank' });

const historyRow = i => ({                             // pos.html archivePacket
  timestamp: '3 Sep 2026, 14:32', source: 'POS',
  orderType: ['Dine-in', 'Takeaway', 'Delivery/Web'][i % 3],
  tableOrAddress: 'Table ' + (i % 9), notes: '',
  phone: i % 4 ? null : '90000000' + (i % 90),
  payment: { method: i % 2 ? 'UPI' : 'Cash', total: 200 + (i % 700), verified: true,
             ref: i % 2 ? 'UPI' + i + 'REF00' : null },
  items: itemsBlock(2, i) });

function build() {
  const db = {};

  // orders/history — every order the café has ever taken
  const history = {};
  const nOrders = DAYS_OPEN * Math.round(BILLS_DAY * 0.75);
  for (let i = 0; i < nOrders; i++) {
    const ts = now - Math.floor((i / nOrders) * DAYS_OPEN * DAY);
    history[ts + '-' + i.toString(36)] = historyRow(i);
  }
  db['orders/history'] = history;

  // orders/daily — the per-day sums analytics draws a long range from, built here the
  // way the page builds them, so `payload` measures the read that actually happens.
  // ROLLUPS=0 leaves them out, which is what a café looks like the first time it opens
  // analytics after this shipped.
  if (process.env.ROLLUPS !== '0') {
    const daily = {};
    for (const id in history) {
      const ts = parseInt(id, 10);
      const d = new Date(ts);
      const dk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
                 String(d.getDate()).padStart(2, '0');
      const o = history[id];
      const r = daily[dk] || (daily[dk] = { rev: 0, orders: 0, pay: {},
                                            type: { 'Dine-in': 0, Takeaway: 0, Delivery: 0 },
                                            hour: new Array(24).fill(0), item: {} });
      const amt = Number(o.payment.total) || 0;
      r.rev += amt; r.orders++;
      r.pay[o.payment.method] = (r.pay[o.payment.method] || 0) + amt;
      const t = o.orderType || '';
      if (/Delivery|Web/i.test(t)) r.type.Delivery++;
      else if (/Takeaway/i.test(t)) r.type.Takeaway++;
      else r.type['Dine-in']++;
      r.hour[d.getHours()]++;
      // o is orders-an-item-appeared-in, which the item drill-down reads. A rollup
      // without it is one the page treats as an older shape and REBUILDS — so a
      // fixture missing it makes every payload run measure the rebuild rather than
      // the steady state, and reports the whole order history being read on an open
      // that should not touch it.
      const seen = {};
      for (const nm in o.items) {
        const base = String(nm).split(' (')[0];
        const it = r.item[base] || (r.item[base] = { q: 0, r: 0, o: 0 });
        if (!seen[base]) { seen[base] = 1; it.o++; }
        it.q += o.items[nm].qty; it.r += o.items[nm].price * o.items[nm].qty;
      }
    }
    db['orders/daily'] = daily;
  }

  // pos/eodArchive — one per trading day, each carrying that day's whole bills and
  // ledger. pos/eodSummary is the index analytics reads instead; both are built so a
  // run can compare them.
  const arch = {}, summary = {};
  for (let d = 0; d < EOD_DAYS; d++) {
    const bills = {}, led = {};
    for (let i = 0; i < BILLS_DAY; i++) { bills['b' + i] = bill(i); led['l' + i] = ledgerRow(i); }
    const key = '2026-05-' + String(d).padStart(3, '0') + '-' + (now - d * DAY);
    arch[key] = { report: 'ILA — END OF DAY\n'.padEnd(1400, 'line of the day report\n'),
                  upi: 12000, cash: 8000, bills, ledger: led,
                  closedBy: 'Tara', closedAt: now - d * DAY };
    summary[key] = { cash: 8000, upi: 12000, bills: BILLS_DAY,
                     closedBy: 'Tara', closedAt: now - d * DAY };
  }
  db['pos/eodArchive'] = arch;
  db['pos/eodSummary'] = summary;
  db['pos/eodSummaryBackfill'] = { at: now, days: EOD_DAYS };

  const cust = {};
  for (let i = 0; i < CUSTOMERS; i++)
    cust['9' + String(100000000 + i)] =
      { orders: 1 + (i % 9), lastAt: now - i * 3600000, lastSpend: 200 + i % 700 };
  db['customers'] = cust;

  // the day in progress
  const bills = {}, led = {};
  for (let i = 0; i < BILLS_DAY; i++) { bills['b' + i] = bill(i); led['l' + i] = ledgerRow(i); }
  db['pos/bills'] = bills;
  db['pos/ledgerEntries'] = led;

  const voids = {}, unpaid = {};
  for (let i = 0; i < 400; i++) {
    voids['v' + i]  = { at: now - i * DAY, by: 'Tara', amount: 200, reason: 'mis-tap', table: 'Table 3' };
    unpaid['u' + i] = { at: now - i * DAY, by: 'Tara', amount: 350, table: 'Table 5' };
  }
  db['security/voids'] = voids;
  db['security/unpaid'] = unpaid;

  const track = {};
  for (let i = 0; i < 400; i++) track['t' + i] = { at: now - i * 60000, state: 'ready', items: itemsBlock(2, i) };
  db['orders/track'] = track;

  const active = {};
  for (let i = 0; i < 6; i++)
    active['a' + i] = { items: itemsBlock(2, i), timestamp: now - i * 60000, table: 'Table ' + i };
  db['orders/active/chef'] = active;
  db['orders/active/barista'] = active;

  const ready = {};
  for (let i = 0; i < 40; i++) ready['r' + i] = { items: itemsBlock(2, i), timestamp: now - i * 60000 };
  db['orders/ready'] = ready;
  db['orders/completed/chef'] = ready;
  db['orders/completed/barista'] = ready;

  const menu = {};
  CATS.forEach((c, ci) => {
    menu[c] = {};
    for (let i = 0; i < 14; i++)
      menu[c]['Item ' + ci + '-' + i] = { price: 100 + i, inStock: true, routing: i % 2 ? 'barista' : 'chef' };
  });
  db['menu'] = menu;
  db['settings/categoryOrder'] = CATS;
  db['settings/itemOrder'] = {};
  db['settings/isOpen'] = true;
  // An ARRAY, and the weighted one admin derives — each VPA repeated in proportion to
  // its remaining headroom. Seeded as an object first time round, which made admin
  // throw "object is not iterable" during a payload run: a fixture that produces page
  // errors is an instrument nobody can trust, so shapes here are checked against how
  // the pages read them, not how they look.
  db['settings/upiList'] = ['ila@okaxis', 'ila@okaxis', 'ila@ybl'];
  db['upiRouting/config'] = {
    ila_okaxis: { id: 'ila@okaxis', label: 'Axis', monthlyCap: 100000, active: true },
    ila_ybl:    { id: 'ila@ybl',    label: 'Yes',  monthlyCap: 100000, active: true } };
  db['upiRouting/totals'] = { [new Date().getFullYear() + '-' +
    String(new Date().getMonth() + 1).padStart(2, '0')]: { ila_okaxis: 40000, ila_ybl: 12000 } };
  db['staff'] = Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['s' + i, { name: 'Staff ' + i, pin: '0000', role: 'cashier' }]));
  db['users'] = Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['u' + i, { name: 'Staff ' + i, role: 'cashier' }]));

  const pw = {};
  for (let i = 0; i < 8; i++) pw['w' + i] = { items: itemsBlock(2, i), total: 300, phone: '9000000000', orderType: 'Delivery/Web' };
  db['orders/pendingWeb'] = pw;

  db['pos/activeTables'] = Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [String(i + 1), { total: 300 + i, paid: 0, items: itemsBlock(2, i) }]));
  db['payments/incoming'] = Object.fromEntries(
    Array.from({ length: 120 }, (_, i) => ['p' + i, { at: now - i * 60000, amount: 200 + i, ref: 'UPI' + i, vpa: 'x@y' }]));

  return db;
}

// THE TIMING PROBES GET A SMALL ONE, AND THAT IS NOT A COMPROMISE
//
// The full fixture is 18MB, and the stub hands it to a page by inlining it in an init
// script — so the browser parses all of it before the page runs. Measured with the full
// one, every page reported a first paint around 1200ms; with this one, 130ms. The
// difference was entirely this file being parsed, and it made `boot` an instrument for
// measuring its own fixture.
//
// First paint happens before any listener has answered, by definition. What a page
// costs to put on screen is a question about the page; how much it then pulls down is a
// question about the data, and `payload` is the probe that asks it — with the full
// fixture, where the bytes are the measurement and the parse cost does not distort them.
function lite() {
  const db = build();
  const keep = ['menu', 'settings/categoryOrder', 'settings/itemOrder', 'settings/isOpen',
                'settings/upiList', 'upiRouting/config', 'upiRouting/totals', 'staff', 'users',
                'orders/active/chef', 'orders/active/barista', 'orders/ready',
                'orders/pendingWeb', 'pos/activeTables'];
  const out = {};
  for (const k of keep) if (db[k] !== undefined) out[k] = db[k];
  return out;
}

const describe = () => DAYS_OPEN + ' days open, ' + BILLS_DAY + ' bills/day, ' +
                       CUSTOMERS.toLocaleString('en-IN') + ' customers';

module.exports = { build, lite, describe, DAYS_OPEN, BILLS_DAY, CUSTOMERS, EOD_DAYS, MENU: (() => {
  const m = {}; CATS.forEach((c, ci) => { m[c] = {};
    for (let i = 0; i < 14; i++) m[c]['Item ' + ci + '-' + i] = { price: 100 + i, inStock: true, routing: i % 2 ? 'barista' : 'chef' }; });
  return m; })() };
