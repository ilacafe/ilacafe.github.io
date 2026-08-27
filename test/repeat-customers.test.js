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

const api = buildModule(
  [extractFunction(src, 'escapeHTML'), extractFunction(src, 'renderRepeat')],
  { document, Date, Math, parseInt, String, Object },
  ['renderRepeat']);

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

done();
