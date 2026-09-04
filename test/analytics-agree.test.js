// Two ways to the same numbers, and they had better be the same numbers.
//
// "All time" dropped the key filter and pulled every order the café had ever taken —
// 13.3MB at 41,000 orders, about a minute on café wifi, to draw totals. Everything on
// that page except the transactions table is a SUM over orders, and sums compose, so a
// day added up once and stored answers as well as the day's orders do.
//
// That is only true if it IS the same answer. A dashboard that loads faster and reports
// different money is not an improvement, it is a lie that arrives sooner — and the
// failure would be silent, because nobody has the old number to compare against.
//
// So both paths are run over one fixture and every figure is compared exactly. Not
// approximately: these are integers and rupees, and a rounding difference would mean
// one of them is wrong.
//
// The fixture is built to make the comparison capable of failing:
//   several days, so folding has something to fold;
//   several hours within a day, so the hour histogram can disagree;
//   items with option suffixes, so base-name collapsing can disagree;
//   more than one payment method and order type;
//   a day with no orders at all;
//   an order carrying a name that is in no category, so catOf's fallback is exercised.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const { check, note, done } = suite('Both paths, one answer — rollups against raw orders');

const src = readPage('analytics.html');

// The real functions, lifted out of the page rather than copied.
const api = buildModule(
  [ extractFunction(src, 'aggregate'), extractFunction(src, 'rollupDay'),
    extractFunction(src, 'foldDailyInto'), extractFunction(src, 'bucketKey'),
    extractFunction(src, 'genBuckets'), extractFunction(src, 'bucketUnit') ],
  { // catOf comes from the live menu on the page; a fixed map here keeps the two paths
    // honest without dragging the menu listener in.
    catOf: (nm) => ({ 'Latte':'Coffee', 'Cappuccino':'Coffee', 'Toastie':'Food',
                      'Pizza Margherita':'Food' })[String(nm).split(' (')[0]] || 'Other',
    dayKeyOf: ts => { const d = new Date(ts);
      return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' +
             String(d.getDate()).padStart(2,'0'); },
    dayStartMs: key => { const [y,m,d] = String(key).split('-').map(Number);
      return new Date(y, m-1, d, 0, 0, 0, 0).getTime(); }
  },
  ['aggregate', 'rollupDay', 'foldDailyInto', 'bucketKey', 'genBuckets', 'bucketUnit']);

const dayKeyOf = ts => { const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' +
         String(d.getDate()).padStart(2,'0'); };

// ---------------------------------------------------------------- the fixture
const DAY = 86400000;
const at = (daysAgo, hour, min) => {
  const d = new Date(); d.setHours(0,0,0,0);
  return d.getTime() - daysAgo * DAY + hour * 3600000 + (min || 0) * 60000;
};
const ORDERS = {};
let n = 0;
const put = (ts, o) => { ORDERS[String(ts) + '-' + (n++).toString(36)] = o; };

// day 5 — two orders, two hours, two methods, an option suffix
put(at(5, 9, 15),  { payment:{ total: 300, method:'Cash' }, orderType:'Dine-in',
                     items:{ 'Latte (Regular)': { qty:2, price:150 } },
                     timestamp:'x', tableOrAddress:'T1', notes:'' });
put(at(5, 17, 40), { payment:{ total: 480, method:'UPI' }, orderType:'Takeaway',
                     items:{ 'Toastie': { qty:1, price:180 }, 'Latte (Large)': { qty:2, price:150 } },
                     timestamp:'x', tableOrAddress:'T2', notes:'no chilli' });
// day 4 — nothing at all
// day 3 — a web order, and an item in no category
put(at(3, 12, 0),  { payment:{ total: 700, method:'UPI' }, orderType:'Delivery/Web',
                     items:{ 'Pizza Margherita': { qty:1, price:450 }, 'Mystery Special': { qty:1, price:250 } },
                     timestamp:'x', tableOrAddress:'somewhere', notes:'' });
// day 1 — three orders, one with no payment method at all
put(at(1, 8, 5),   { payment:{ total: 150, method:'Cash' }, orderType:'Dine-in',
                     items:{ 'Latte': { qty:1, price:150 } }, timestamp:'x', tableOrAddress:'T3', notes:'' });
put(at(1, 8, 45),  { payment:{ total: 360 }, orderType:'Dine-in',
                     items:{ 'Cappuccino': { qty:2, price:180 } }, timestamp:'x', tableOrAddress:'T4', notes:'' });
put(at(1, 20, 30), { payment:{ total: 180, method:'Card' }, orderType:'Takeaway',
                     items:{ 'Toastie': { qty:1, price:180 } }, timestamp:'x', tableOrAddress:'T5', notes:'' });

check('the fixture spans several days with a gap in the middle',
      new Set(Object.keys(ORDERS).map(k => dayKeyOf(parseInt(k)))).size === 3,
      [...new Set(Object.keys(ORDERS).map(k => dayKeyOf(parseInt(k))))].join(', '));
note('a day with no orders is the one that catches a fold that assumes every day is present');

// ---------------------------------------------------------------- both paths
const start = at(7, 0, 0), end = Date.now();
const ctx = { start, end, prevStart: null, prevEnd: start,
              unit: api.bucketUnit(end - start), bucketStart: start };

const raw = api.aggregate(ORDERS, ctx);

// the rollup path: every order here is a whole day before now, so nothing is partial
const byDay = {};
for (const id in ORDERS) {
  const dk = dayKeyOf(parseInt(id));
  (byDay[dk] = byDay[dk] || {})[id] = ORDERS[id];
}
const rollups = {};
for (const dk in byDay) rollups[dk] = api.rollupDay(byDay[dk]);

const empty = api.aggregate({}, ctx);          // an accumulator with nothing raw in it
const folded = api.foldDailyInto(empty, rollups, ctx);

// ---------------------------------------------------------------- compare, exactly
const same = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b),
                                   'raw ' + JSON.stringify(a) + '  vs folded ' + JSON.stringify(b));

check('the raw path found the orders at all', raw.orders === 6 && raw.rev === 2170,
      raw.orders + ' orders, ' + raw.rev + ' revenue');
note('without this the comparison could pass on two empty results');

same('revenue', raw.rev, folded.rev);
same('order count', raw.orders, folded.orders);
same('items sold', raw.items, folded.items);
same('revenue by payment method', raw.payRev, folded.payRev);
same('orders by type', raw.typeCnt, folded.typeCnt);
same('the hour histogram', raw.hourCnt, folded.hourCnt);
same('the weekday histogram', raw.wdayCnt, folded.wdayCnt);
same('the revenue trend, bucket for bucket', raw.trend, folded.trend);
same('revenue by category', raw.catRev, folded.catRev);
same('every item’s quantity and revenue', raw.itemAgg, folded.itemAgg);

note('itemAgg carries the category too, so a mis-derived one fails here rather than on screen');

// ---------------------------------------------------------------- what a rollup drops
{
  const day = api.rollupDay(byDay[dayKeyOf(at(5, 9, 15))]);
  check('a day rolls up to a few hundred bytes, not its orders',
        JSON.stringify(day).length < 400, JSON.stringify(day).length + ' bytes');
  check('and carries no order rows', day.txns === undefined && day.items === undefined,
        Object.keys(day).join(', '));
  note('which is why the transactions table keeps its own raw fetch — a rollup cannot');
  note('answer "find the order with this note in it"');
}

// ---------------------------------------------------------------- the edge that would lie
{
  // A range starting mid-morning. Whole-day folding cannot answer it: include the day
  // and the orders before the start are counted that should not be; exclude it and the
  // ones after the start are lost. Which way it goes depends on where the orders sit —
  // in this fixture the day is excluded and 480 goes missing. Either way it disagrees,
  // which is why only whole days are folded and the partial edge stays raw.
  const midday = at(5, 12, 0);
  const c2 = { start: midday, end, prevStart: null, prevEnd: midday,
               unit: api.bucketUnit(end - midday), bucketStart: midday };
  const rawPart = api.aggregate(ORDERS, c2);
  const foldedAll = api.foldDailyInto(api.aggregate({}, c2), rollups, c2);
  check('folding a part-day does not match, which is why the edge stays raw',
        rawPart.rev !== foldedAll.rev,
        'both gave ' + rawPart.rev + ' — the fixture cannot tell the two apart here');
  note('raw from ' + new Date(midday).getHours() + ':00 gives ' + rawPart.rev +
       '; folding whole days only gives ' + foldedAll.rev + ' — the edge day is dropped entirely');
}

done();
