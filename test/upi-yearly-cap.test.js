// Yearly caps on the UPI accounts.
//
// The monthly cap was the only limit an account could be held to, and the limits
// that actually matter to a bank account run over a financial year. The routing
// weight is computed in TWO places — the till after every payment, and the admin
// screen whenever it is open — and both publish settings/upiList, which is the list
// money is actually taken on. So both copies are read out of the pages here and
// held to the same answers: one copy that forgot the yearly cap would put a capped
// account back in rotation the next time it published.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');
const { check, note, done } = suite('UPI routing — yearly caps, paced over the financial year');

const NAMES = ['upiFYStart', 'upiFYLabel', 'upiFYMonths', 'upiFYMonthsLeft', 'upiYearTotals',
               'upiComputeWeights', 'upiWeightedList'];

function load(page) {
  const src = readPage(page);
  return buildModule(NAMES.map(n => extractFunction(src, n)), {}, NAMES);
}
const admin = load('admin.html');
const pos = load('pos.html');

for (const n of NAMES) {
  check(n + ' is the same function on the till and the admin screen',
        extractFunction(readPage('admin.html'), n) === extractFunction(readPage('pos.html'), n));
}

const R = admin;
const share = (list, id) => list.filter(x => x === id).length / list.length;

// --------------------------------------------------------------- the financial year
{
  const nov = new Date(2026, 10, 26), mar = new Date(2027, 2, 31), apr = new Date(2027, 3, 1);
  check('November 2026 is in FY 2026-27', R.upiFYLabel(nov) === '2026-27');
  check('31 March 2027 is still FY 2026-27', R.upiFYLabel(mar) === '2026-27');
  check('1 April 2027 starts FY 2027-28', R.upiFYLabel(apr) === '2027-28');
  const m = R.upiFYMonths(nov);
  check('the year so far runs April to the current month',
        m[0] === '2026-04' && m[m.length - 1] === '2026-11' && m.length === 8, m.join(','));
  check('January belongs to the year that began the April before',
        R.upiFYMonths(new Date(2027, 0, 5)).join(',') ===
        '2026-04,2026-05,2026-06,2026-07,2026-08,2026-09,2026-10,2026-11,2026-12,2027-01');
  check('November leaves five months, itself included', R.upiFYMonthsLeft(nov) === 5);
  check('April leaves the whole year', R.upiFYMonthsLeft(new Date(2026, 3, 2)) === 12);
  check('March leaves only itself', R.upiFYMonthsLeft(mar) === 1);

  const byMonth = { '2026-03': { a: 999 }, '2026-04': { a: 100, b: 5 }, '2026-10': { a: 50 }, '2026-11': { a: 1 } };
  const y = R.upiYearTotals(byMonth, nov);
  check('the year is the sum of its months, and the month before April is not in it',
        y.a === 151 && y.b === 5, JSON.stringify(y));
}

// --------------------------------------------------------- nothing changes without one
{
  const cfg = { a: { id: 'a@x', monthlyCap: 100000 }, b: { id: 'b@y', monthlyCap: 50000 } };
  const tot = { a: 20000, b: 10000 };
  const before = R.upiWeightedList(cfg, tot);
  const after = R.upiWeightedList(cfg, tot, { a: 900000, b: 900000 }, 5);
  check('with no yearly caps set, the year\'s totals change nothing',
        JSON.stringify(before) === JSON.stringify(after), before.join(',') + ' vs ' + after.join(','));
  const w = R.upiComputeWeights(cfg, tot);
  check('a monthly cap still weighs by what is left of the month',
        w.find(x => x.e.key === 'a').w === 80000 && w.find(x => x.e.key === 'b').w === 40000);
}

// ------------------------------------------------------------------ a hard stop
{
  const cfg = { cur: { id: 'cur@hdfc', yearlyCap: 1000000 }, sav: { id: 'sav@axis', monthlyCap: 50000 } };
  const list = R.upiWeightedList(cfg, { cur: 1000, sav: 0 }, { cur: 1000000, sav: 0 }, 5);
  check('an account at its yearly cap is out of rotation', list.indexOf('cur@hdfc') === -1, list.join(','));
  const list2 = R.upiWeightedList(cfg, { cur: 1000, sav: 0 }, { cur: 999000, sav: 0 }, 5);
  check('and one a little short of it is still in', list2.indexOf('cur@hdfc') !== -1, list2.join(','));
}

// -------------------------------------------------------------------- paced
{
  // ₹12 lakh a year against ₹1 lakh a month, at the start of April: the yearly one
  // has a twelfth of its year this month, which is the same size as the other.
  const cfg = { y: { id: 'y@hdfc', yearlyCap: 1200000 }, m: { id: 'm@axis', monthlyCap: 100000 } };
  const w = R.upiComputeWeights(cfg, { y: 0, m: 0 }, { y: 0, m: 0 }, 12);
  const wy = w.find(x => x.e.key === 'y').w, wm = w.find(x => x.e.key === 'm').w;
  check('a yearly cap gets its share of the year, not the whole year, as this month\'s headroom',
        wy === 100000 && wm === 100000, 'y ' + wy + ' m ' + wm);
  const list = R.upiWeightedList(cfg, { y: 0, m: 0 }, { y: 0, m: 0 }, 12);
  check('so the two split the money evenly', Math.abs(share(list, 'y@hdfc') - 0.5) < 0.01, list.join(','));

  // Under-used early in the year: the remaining pace is larger.
  const w2 = R.upiComputeWeights(cfg, { y: 0, m: 0 }, { y: 200000, m: 0 }, 5);
  check('what is left of the year is spread over the months left of it',
        w2.find(x => x.e.key === 'y').w === 200000, String(w2.find(x => x.e.key === 'y').w));

  // Ahead of pace: still open, but last in line.
  const w3 = R.upiComputeWeights(cfg, { y: 150000, m: 0 }, { y: 150000, m: 0 }, 12);
  const y3 = w3.find(x => x.e.key === 'y');
  check('an account ahead of its pace stays in rotation', !!y3);
  check('but at the back of the queue', y3 && y3.w < 10000, y3 && String(y3.w));

  // Both caps: the tighter one decides.
  const both = { z: { id: 'z@sbi', monthlyCap: 30000, yearlyCap: 1200000 } };
  const w4 = R.upiComputeWeights(both, { z: 0 }, { z: 0 }, 12);
  check('with both caps the tighter one is the headroom', w4[0].w === 30000, String(w4[0].w));
  const w5 = R.upiComputeWeights(both, { z: 30000 }, { z: 30000 }, 12);
  check('and the monthly cap still stops it for the month', w5.length === 1 && w5[0].w === 1);
  note('a lone account at its cap is still the fallback, as before — money is never refused');
}

// ------------------------------------------------------------ everyone at a cap
{
  const cfg = { a: { id: 'a@x', yearlyCap: 100 }, b: { id: 'b@y', monthlyCap: 100 } };
  const w = R.upiComputeWeights(cfg, { a: 10, b: 150 }, { a: 120, b: 150 }, 3);
  check('when every account is capped, the least over is the one used',
        w.length === 1 && w[0].e.key === 'a', w.map(x => x.e.key).join(','));
}

// ---------------------------------------------------------- the till uses the year
{
  const src = readPage('pos.html');
  const body = extractFunction(src.replace('window.upiRecordPayment = async function', 'async function upiRecordPayment'), 'upiRecordPayment');
  check('the till passes the year into the list it publishes',
        /upiWeightedList\(config, totals, yearTotals, upiFYMonthsLeft\(\)\)/.test(body));
  check('and only reads the year when some account has a yearly cap',
        /some\(k => parseFloat\(\(config\[k\] \|\| \{\}\)\.yearlyCap\) > 0\)/.test(body));
  check('and says so when one is reached', /UPI yearly cap hit/.test(body));
  const asrc = readPage('admin.html');
  check('the admin screen does not publish until the year is added up',
        /if \(upiHasYearCaps\(\) && !upiAllLoaded\) return;/.test(asrc));
  check('and passes the year into the list it publishes',
        /upiWeightedList\(upiCfg, upiTot, upiYearNow\(\), upiFYMonthsLeft\(\)\)/.test(asrc));
}

void pos;
done();
