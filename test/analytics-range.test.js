// analytics.html defaulted to a 30-day view and downloaded every bill ever recorded
// to render it, then filtered in the browser. That is invisible while the café is
// young and terminal once it isn't: the node is never pruned, so the page gets
// slower every month, and it is the one page most likely to be opened on a phone.
//
// The fetch is now driven by the range the user picked. The risk that introduces is
// a stale window — asking for less data than the view needs shows an empty chart
// rather than an error — so the refetch decision is tested in both directions.

const { readPage, extractFunction, buildModule, suite } = require('./helpers');

const idx = readPage('analytics.html');
const { check, note, done } = suite('Analytics — fetch the range that is actually shown');

const api = buildModule([extractFunction(idx, 'historyNeedsRefetch')], {}, ['historyNeedsRefetch']);

const DAY = 86400000;
const now = Date.now();
const ago = d => now - d * DAY;

// ---------------------------------------------------------------- the decision
{
  check('the first range always fetches', api.historyNeedsRefetch(null, ago(30)) === true);

  check('widening the range fetches again',
        api.historyNeedsRefetch(ago(30), ago(90)) === true,
        '90 days of view against 30 days of data is an empty chart, not an error');

  check('narrowing the range does not refetch',
        api.historyNeedsRefetch(ago(90), ago(7)) === false,
        'the data is already here — refetching would be a download per click');

  check('reselecting the same range does not refetch',
        api.historyNeedsRefetch(ago(30), ago(30)) === false);

  check('going to All time fetches',
        api.historyNeedsRefetch(ago(90), 0) === true,
        'All time must reach further back than anything already held');

  check('nothing refetches once All time is held',
        api.historyNeedsRefetch(0, ago(365)) === false);
  note('0 means unfiltered, so it satisfies every narrower range');
}

// ---------------------------------------------------------------- the query it builds
{
  const src = idx.slice(idx.indexOf('function ensureHistory'), idx.indexOf('function setRange'));

  check('a bounded range is asked for by key, which needs no index',
        /orderByKey\(\)\.startAt\(String\(Math\.floor\(start\)\)\)/.test(src), src.slice(0, 200));

  check('All time drops the filter rather than starting at zero',
        /start > 0[\s\S]*?db\.ref\('orders\/history'\)\.orderByKey[\s\S]*?:\s*db\.ref\('orders\/history'\)/.test(src),
        'a startAt("0") would exclude any legacy key that is not timestamp-shaped');

  check('the previous listener is detached before a new one is attached',
        /historyQuery\.off\(\)/.test(src),
        'otherwise every widening leaves a live listener behind, and DATA races between them');
}

// ---------------------------------------------------------------- nothing left unbounded
{
  // Only append-only nodes matter here. `menu` and `settings` are the café's
  // current configuration — a few dozen keys that get edited, not appended to — so
  // reading them whole is correct and always will be. The nodes that bite are the
  // ones a service adds a row to and nothing ever removes.
  const CONFIG_NODES = ['menu', 'settings', 'eta'];
  const unbounded = [];
  for (const m of idx.matchAll(/db\.ref\((['"][^'"]+['"]|CFG\.paths\.\w+)\)((?:\.\w+\([^)]*\))*)/g)) {
    const path = m[1].replace(/['"]/g, ''), chain = m[2] || '';
    if (/limitTo|orderBy|startAt|endAt/.test(chain)) continue;
    if (/^users\//.test(path)) continue;                     // a single record by uid
    if (CONFIG_NODES.includes(path.split('/')[0])) continue;  // config, not a log
    if (path === 'orders/history') continue;                  // the All-time branch, checked above
    if (!/once|on/.test(chain)) continue;                     // not a read
    unbounded.push(path + chain);
  }
  check('no page-level read pulls an append-only node whole',
        unbounded.length === 0, unbounded.join(', '));
  note('history is range-driven, completed is capped per station, voids are capped');

  // Named rather than left to the sweep above, because both are security logs that
  // only ever grow and both are read on a phone. The sweep would catch an unbounded
  // read; this says out loud that these two are meant to be capped.
  for (const node of ['security/voids', 'security/unpaid']) {
    const read = new RegExp("db\\.ref\\('" + node + "'\\)((?:\\.\\w+\\([^)]*\\))*)").exec(idx);
    check(node + ' is read with a cap', !!read && /limitToLast\(\d+\)/.test(read[1]),
          read ? read[1] : 'not read at all');
  }
}

// ---------------------------------------------------------------- the demand-map cap is justified
{
  const cfg = /maxPerStation:\s*(\d+)/.exec(idx);
  const hl = /halfLifeDays:\s*(\d+)/.exec(idx);
  check('the demand map caps how far back it reads', !!cfg, 'unbounded again');
  check('the model still declares its half-life', !!hl);

  if (cfg && hl) {
    const n = +cfg[1], halfLife = +hl[1];
    const days = n / 30;                                     // ≈30 completions/day/station
    const weight = Math.pow(2, -days / halfLife);
    check('the oldest record still read carries under 1% of a fresh one',
          weight < 0.01, (weight * 100).toFixed(2) + '%');
    note(n + ' records ≈ ' + Math.round(days) + ' days; at a ' + halfLife +
         '-day half-life the oldest is worth ' + (weight * 100).toFixed(1) + '% of today');
    check('and it reads far enough back to fit a model at all',
          n >= 200 * 5, 'minLiveRecords is 200; a cap near that would fall back to the seed');
  }
}

done();
