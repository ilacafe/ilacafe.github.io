// The two halves of the repeat-customer rollup, checked against each other.
//
// The panel does not read the customers node any more. It reads customers/_stats —
// two counts and the current top ten, a few hundred bytes however long the café has
// been open — and the node itself is read whole exactly once, by the first admin open
// that finds no rollup there.
//
// Which means two different pieces of code produce that record. rollupCustomers() in
// admin.html builds one from the whole node. bumpCustomerStats() in pos.html folds a
// single accepted order into the one that already exists. They are written months
// apart in different files, and nothing about either one says the other exists.
//
// If they disagree the panel does not break. It shows a number that is quietly wrong,
// for ever, and the only way anyone finds out is by counting four thousand customers
// by hand. So this suite does that counting: it replays orders through the till's
// updater and checks the answer against a rebuild from the node those same orders
// produced. The two must not be able to drift.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const { check, note, done } = suite('The customer rollup — the till and the rebuild agree');

const admin = buildModule(
  [extractFunction(readPage('admin.html'), 'rollupCustomers'),
   'const CUST_STATS_V = ' + (/const CUST_STATS_V = (\d+)/.exec(readPage('admin.html')) || [,'1'])[1] + ';'],
  { Object, Array, RegExp, parseInt, Date, Math },
  ['rollupCustomers']);

const till = buildModule(
  [extractFunction(readPage('pos.html'), 'bumpCustomerStats')],
  { Object, Array, Math },
  ['bumpCustomerStats']);

// ------------------------------------------------------------ a café's worth of orders
// Deliberately not tidy: some customers come once, some come back a lot, and they
// arrive interleaved rather than one customer at a time — which is the only order in
// which "has this phone been seen before?" can be got wrong.
function play(orders){
  const node = {};                       // customers/, as the till writes it
  let stats = null;                      // customers/_stats
  orders.forEach((ph, i) => {
    const at = 1700000000000 + i * 60000;
    const c = node[ph] || { orders: 0, lastAt: 0 };
    c.orders += 1; c.lastAt = at;                       // what the increment does
    node[ph] = c;
    if (stats === null) return;                         // no rollup yet: the till aborts
    const out = till.bumpCustomerStats(JSON.parse(JSON.stringify(stats)), ph, c.orders, at);
    if (out !== undefined) stats = out;
  });
  return { node, stats, publish: () => { stats = admin.rollupCustomers(node); } };
}

// ---------------------------------------------------------------- before any rollup
// Asked of the updater directly, not through play(). The first version of this went
// through the replay helper, which skips the till while there is no rollup — so it was
// asserting on its own scaffolding and passed whatever the till did.
//
// This is the one that matters most and shows least. admin trusts any record carrying
// the current version, so a half-built one written here is never rebuilt: the panel
// would count from whenever the till first wrote instead of from the café's history,
// and be wrong for ever without ever looking broken.
{
  check('the till aborts rather than starting a rollup of its own',
        till.bumpCustomerStats(undefined, '9000000001', 1, 1700000000000) === undefined);
  check('and does the same for one that has been deleted',
        till.bumpCustomerStats(null, '9000000001', 3, 1700000000000) === undefined);
  note('admin builds the first one from the node; a partial record here outranks it for ever');

  const run = play(['9000000001', '9000000002', '9000000001']);
  check('so nothing is published while the café trades without one', run.stats === null);
}

// ------------------------------------------- the rebuild, then the till keeps it true
{
  // 30 orders across 12 phones, interleaved, before anyone opens admin.
  const early = [];
  for (let i = 0; i < 30; i++) early.push('90000000' + String((i % 12) + 10));
  const run = play(early);

  // Somebody opens admin: the node is read once and the rollup published.
  const node = run.node;
  let stats = admin.rollupCustomers(node);

  // Trading continues, and now the till maintains it.
  const later = [];
  for (let i = 0; i < 40; i++) later.push('90000000' + String((i * 7 % 18) + 10));  // 6 phones never seen before
  later.forEach((ph, i) => {
    const at = 1800000000000 + i * 60000;
    const c = node[ph] || { orders: 0, lastAt: 0 };
    c.orders += 1; c.lastAt = at;
    node[ph] = c;
    const out = till.bumpCustomerStats(JSON.parse(JSON.stringify(stats)), ph, c.orders, at);
    if (out !== undefined) stats = out;
  });

  // And the answer the till arrived at has to be the answer a rebuild gives.
  const rebuilt = admin.rollupCustomers(node);
  check('the count of identified customers has not drifted',
        stats.total === rebuilt.total, 'till ' + stats.total + ', rebuild ' + rebuilt.total);
  note('the till only knows a phone is new because its count came back as 1');
  check('nor has the count of those who came back',
        stats.repeat === rebuilt.repeat, 'till ' + stats.repeat + ', rebuild ' + rebuilt.repeat);
  check('and the ten it lists are the ten a rebuild lists',
        stats.top.map(r => r.ph).join(',') === rebuilt.top.map(r => r.ph).join(','),
        'till ' + stats.top.map(r => r.ph + ':' + r.n).join(' ') +
        ' / rebuild ' + rebuilt.top.map(r => r.ph + ':' + r.n).join(' '));
  check('with the same counts against them',
        stats.top.map(r => r.n).join(',') === rebuilt.top.map(r => r.n).join(','),
        stats.top.map(r => r.n).join(', '));
  note('30 orders before the rollup existed, 40 after it, 18 phones, six of them new');
}

// ------------------------------------------------- climbing into the ten from outside
// The till only ever sees one customer at a time, so the top ten has to be maintained
// by comparison rather than by sorting something it does not hold. A customer who was
// nowhere near the list and then comes in every day has to be able to get onto it.
{
  const node = {};
  const orders = [];
  for (let p = 1; p <= 14; p++) for (let k = 0; k < 16 - p; k++) orders.push('91000000' + String(p).padStart(2,'0'));
  orders.forEach((ph, i) => { const c = node[ph] || { orders:0, lastAt:0 }; c.orders++; c.lastAt = 1700000000000 + i*1000; node[ph] = c; });
  let stats = admin.rollupCustomers(node);
  const outsider = '9100000099';
  check('the outsider starts off the list', !stats.top.some(r => r.ph === outsider));

  for (let k = 1; k <= 20; k++){
    const at = 1900000000000 + k * 60000;
    const c = node[outsider] || { orders: 0, lastAt: 0 };
    c.orders += 1; c.lastAt = at; node[outsider] = c;
    const out = till.bumpCustomerStats(JSON.parse(JSON.stringify(stats)), outsider, c.orders, at);
    if (out !== undefined) stats = out;
  }
  const rebuilt = admin.rollupCustomers(node);
  check('and climbs onto it as they keep coming back',
        stats.top[0] && stats.top[0].ph === outsider, JSON.stringify(stats.top.slice(0,2)));
  check('exactly where a rebuild would put them',
        JSON.stringify(stats.top) === JSON.stringify(rebuilt.top));
  check('counted once, not once per visit',
        stats.total === rebuilt.total, 'till ' + stats.total + ', rebuild ' + rebuilt.total);
  note('the same phone arriving twenty times must update its row, not add twenty of them');
}

// ------------------------------------------------------------------ the list stays ten
{
  const node = {};
  let stats = admin.rollupCustomers({ '9200000001': { orders: 2, lastAt: 1 } });
  node['9200000001'] = { orders: 2, lastAt: 1 };
  for (let p = 1; p <= 40; p++){
    const ph = '92000001' + String(p).padStart(2, '0');
    for (let k = 0; k < 3; k++){
      const at = 1700000000000 + p * 1000 + k;
      const c = node[ph] || { orders: 0, lastAt: 0 };
      c.orders += 1; c.lastAt = at; node[ph] = c;
      const out = till.bumpCustomerStats(JSON.parse(JSON.stringify(stats)), ph, c.orders, at);
      if (out !== undefined) stats = out;
    }
  }
  check('forty new repeat customers do not make the rollup forty rows long',
        stats.top.length === 10, String(stats.top.length));
  note('the record has to stay small — that is the entire reason it exists');
  check('and the totals still match a rebuild',
        stats.total === admin.rollupCustomers(node).total &&
        stats.repeat === admin.rollupCustomers(node).repeat,
        stats.total + '/' + stats.repeat);
}

done();
