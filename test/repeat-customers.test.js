// The owner's "repeat customers" panel: how many people come back, and which ten
// come back most.
//
// The second half of that was not what it rendered. rows is filtered into repeat,
// and then rows is sorted — but Array.prototype.filter returns a NEW array, and
// sorting the one it came from does not reorder it. So the ten names on screen were
// the first ten repeat customers in whatever order Firebase handed the node over,
// which is by phone number. A customer who had been in nine times sat below one who
// had been in twice, or did not appear at all.
//
// It reads as a sort because a sort is right there on the line above.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const { check, note, done } = suite('Repeat customers — the ten it shows are the top ten');

const src = readPage('admin.html');

// The panel writes into two elements; hand it something that records what it wrote.
const boxes = {};
const document = {
  getElementById: (id) => (boxes[id] = boxes[id] || { innerHTML: '' }),
};

// renderRepeat is a thin thing now — it rolls the node up and hands the rollup to the
// renderer — so all three come in together. The assertions below are unchanged and
// still go through renderRepeat, because what the panel DRAWS is what they are about.
const api = buildModule(
  [extractFunction(src, 'escapeHTML'), extractFunction(src, 'rollupCustomers'),
   extractFunction(src, 'renderRepeatStats'), extractFunction(src, 'renderRepeat'),
   'const CUST_STATS_V = ' + (/const CUST_STATS_V = (\d+)/.exec(src) || [,'1'])[1] + ';'],
  { document, Date, Math, parseInt, String, Object, Array, RegExp },
  ['renderRepeat', 'rollupCustomers', 'renderRepeatStats']);

// Phone keys deliberately ascending, so insertion order and order-count order
// disagree — which is the only arrangement in which the bug is visible.
const DAY = 86400000, now = Date.now();
const customers = {};
for (let i = 1; i <= 14; i++) {
  customers['90000000' + String(i).padStart(2, '0')] = { orders: i + 1, lastAt: now - i * DAY };
}
customers['9000000099'] = { orders: 1, lastAt: now };          // not a repeat customer
customers['9000000098'] = { orders: 1, lastAt: now };

api.renderRepeat(customers);
const listed = [...boxes['repeat-list'].innerHTML.matchAll(/>(\d+) orders</g)].map(m => Number(m[1]));

// ---------------------------------------------------------------- the KPIs
{
  const kpis = boxes['repeat-kpis'].innerHTML;
  check('it counts everyone with a phone number', /<div class="val">16<\/div>/.test(kpis));
  check('and what share of them came back', /<div class="val">88%<\/div>/.test(kpis),
        '14 of 16 have ordered more than once');
}

// ---------------------------------------------------------------- the ten
{
  check('it lists ten', listed.length === 10, 'listed ' + listed.length);

  const descending = listed.every((n, i) => i === 0 || listed[i - 1] >= n);
  check('and they are in descending order of orders', descending, listed.join(', '));

  const top10 = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6];
  check('and they are the ten who came back most',
        listed.join(',') === top10.join(','), listed.join(', '));
  note('sorted by order count, then by who was in most recently');
  note('the customer with 15 orders must not be missing while one with 2 is shown');
}

// ------------------------------------------------------- nobody has come back yet
{
  api.renderRepeat({ '9000000001': { orders: 1, lastAt: now } });
  check('one-time customers alone say so rather than showing an empty table',
        /No repeat orders yet/.test(boxes['repeat-list'].innerHTML));
  api.renderRepeat({});
  check('and an empty node is not an error', /Identified customers/.test(boxes['repeat-kpis'].innerHTML));
}

// ------------------------------------------------------------------- the rollup
// The panel does not read the customers node any more. It reads customers/_stats, a
// few hundred bytes the till keeps up to date, and the node itself is read once ever
// to build the first one. So there are two things that produce a rollup — this
// function and the transaction in pos.html — and the panel is only as right as they
// agree. This half is the one that can be checked here.
{
  const built = api.rollupCustomers(customers);
  check('the rollup counts everyone with a phone number', built.total === 16, String(built.total));
  check('and how many of them came back', built.repeat === 14, String(built.repeat));
  check('and carries ten rows, not the node', built.top.length === 10, String(built.top.length));
  check('which are the ten who came back most',
        built.top.map(r => r.n).join(',') === [15,14,13,12,11,10,9,8,7,6].join(','),
        built.top.map(r => r.n).join(', '));

  // _stats lives inside customers/, so anything walking the node has to step over it.
  // Counted as a customer it would inflate the total by one for ever, and the rebuild
  // that publishes it would then be the thing that corrupts it.
  const withStats = Object.assign({}, customers, {
    _stats: { v: 1, total: 999, repeat: 999, top: [], at: now } });
  const again = api.rollupCustomers(withStats);
  check('and the rollup itself is not counted as a customer', again.total === 16, String(again.total));
  check('nor listed among the ten',
        !JSON.stringify(again.top).includes('_stats'), JSON.stringify(again.top));

  // Anything that is not a ten-digit phone gets the same treatment, so a stray key
  // cannot quietly become a customer.
  const junk = api.rollupCustomers({ 'notaphone': { orders: 40 }, '12345': { orders: 40 } });
  check('and neither is any other key that is not a phone number', junk.total === 0, String(junk.total));
}

// ------------------------------------------------- what the panel draws from a rollup
// The live path never calls renderRepeat at all: it gets the small record off the
// database and draws that. Same numbers, or the rollup is not doing its job.
{
  api.renderRepeatStats(api.rollupCustomers(customers));
  check('drawing from the rollup gives the same count',
        /<div class="val">16<\/div>/.test(boxes['repeat-kpis'].innerHTML));
  check('and the same share', /<div class="val">88%<\/div>/.test(boxes['repeat-kpis'].innerHTML));
  const fromStats = [...boxes['repeat-list'].innerHTML.matchAll(/>(\d+) orders</g)].map(m => Number(m[1]));
  check('and the same ten', fromStats.join(',') === [15,14,13,12,11,10,9,8,7,6].join(','),
        fromStats.join(', '));

  api.renderRepeatStats({ v: 1, total: 3, repeat: 0, top: [], at: now });
  check('a rollup with no repeats says so rather than showing an empty table',
        /No repeat orders yet/.test(boxes['repeat-list'].innerHTML));
  api.renderRepeatStats(null);
  check('and a missing rollup is not an error',
        /Identified customers/.test(boxes['repeat-kpis'].innerHTML));
}

done();
