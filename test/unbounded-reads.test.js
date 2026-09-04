// Every node a page reads whole, and whether it can grow without limit.
//
// analytics.html already had this check, because it had already been caught by it:
// the page downloaded every bill ever recorded to render a 30-day view. But that
// check only ever looked at analytics.html, and a whole-node read on any of the
// other six was nobody's business.
//
// Sweeping all seven found the panel bug fixed alongside this, and three nodes that
// grow forever. None of them is a bug on its own — a café with two hundred customers
// will never notice — and none of them can simply be pruned, because each holds the
// only copy of something. That is exactly why they are written down here rather than
// fixed quietly or left to be rediscovered.
//
// The rule is not "never read a node whole". Most of these should be read whole and
// always will be. The rule is that every one of them has been looked at, and a new
// one has to be looked at too, rather than arriving unremarked.
//
// THE WORKER WAS NOT IN THE SWEEP, AND IT IS THE WORST PLACE FOR THIS.
//
// Seven pages were swept and the one component that is not a page was not. A browser
// reading a node whole is one device, once, with a person watching it; the Worker does
// it on a schedule, with nobody watching, inside a runtime with a hard ceiling on
// memory and time — and every one of its reads fails silently, which is the whole
// reason the rules suite checks the robot's own access separately.
//
// Two were found by adding it. The weekly digest read pos/eodArchive whole — every
// trading day the café has ever had, each carrying that day's entire bills and ledger
// — to pick seven days out of it, thirty lines below the function that goes out of its
// way to read the same node shallow for exactly this reason. And the monthly ETA refit
// read orders/completed whole, the largest node in the database and the one nothing
// removes from, to derive a 75-day window. Neither gets slower in a way anyone can
// see. They stop, and a report that stops arriving looks like a quiet week.

const fs = require('fs');
const path = require('path');
const { ROOT, readPage, suite } = require('./helpers');   // ROOT: the Worker is not a page

const { check, note, done } = suite('Whole-node reads — every one of them accounted for');

const PAGES = ['index.html', 'pos.html', 'admin.html', 'analytics.html',
               'chef.html', 'barista.html', 'inventory.html'];

// Size is set by the café, not by how long it has been open: a menu, a staff list, a
// catalogue, a status object that gets overwritten. Reading these whole is correct
// and stays correct.
const BOUNDED = {
  'menu':                   'the café’s menu — edited, not appended to',
  'settings/addons':        'a list per category, edited',
  'settings/categoryOrder': 'one entry per category',
  'settings/isOpen':        'a boolean',
  'settings/itemOrder':     'one entry per category',
  'settings/storeStatus':   'one object, overwritten',
  'settings/upiList':       'the UPI ids money can be taken on — a handful',
  'eta/live':               'one object, republished by the POS every few seconds',
  'eta/model':              'the wait-time model — one object',
  'eta/modelPrevious':      'the model before the last refit — one object',
  'eta/recalMeta':          'the refit’s own record — one object',
  'ops/cronFailure':        'one key per scheduled job, overwritten in place',
  'ops/pushHealth':         'one object, overwritten in place',
  'inventory/config/items': 'the item catalogue',
  'inventory/stock':        'one key per catalogue item',
  'staff':                  'one key per member of staff',
  'users':                  'one key per staff account',
  'upiRouting/config':      'one key per bank account',
  'pushSubscriptions':      'one key per device that accepted notifications',

  // Work queues: something puts a row in, something else takes it out again. They
  // are only ever as long as the work outstanding.
  'orders/active/chef':     'drained as tickets are marked done',
  'orders/active/barista':  'drained as tickets are marked done',
  'orders/pendingWeb':      'drained as orders are accepted or rejected',
  'orders/refundsDue':      'drained as refunds are marked paid',

  // The till’s day. promptEOD archives and clears these; the rest are single values.
  'pos/activeTables':       'cleared at EOD',
  'pos/bills':              'cleared at EOD',
  'pos/ledgerEntries':      'cleared at EOD',
  'pos/upiTotal':           'a number, reset at EOD',
  'pos/eodSummaryBackfill': 'one object, {at, days}, written once and never appended to. ' +
                            'Its whole job is to be small and to be there: analytics reads ' +
                            'it to find out whether the closing summaries have already been ' +
                            'rebuilt from the archive, which is the read that stops a 5MB ' +
                            'one happening on every open.',
  'pos/cashDrawer':         'a number',
  'pos/lastSplitHeads':     'a number',
  'pos/tips/lastHeads':     'a number',
  'pos/unverified':         'payments still owed at closing. The Worker records each one ' +
                            'into the archive for its day once a late credit matches, and ' +
                            'clears the row on the run AFTER the archive shows it — so this ' +
                            'is as long as the payments actually outstanding, not as long as ' +
                            'the café has been open. See settleLateVerifications in worker.js.',
};

// These grow with the café's history and nothing removes from them. Each entry says
// what is accepted and, more importantly, why it cannot just be pruned — every one
// of them is the only copy of something.
const GROWS = {
  // These are all AUDIT records, and the café has said so: they are kept because
  // somebody may need to answer a question about them later. Nothing here is pruned,
  // and the reason is worth stating plainly rather than leaving as an omission —
  // a few hundred kilobytes over several years is a much better trade than deleting
  // the answer to a question nobody has asked yet.
  //
  // The cost is per page LOAD, not per bill: a value listener downloads its subtree
  // once and takes deltas after. So this grows with the café's history rather than
  // with its traffic, and slowly.

  'customers':
    'one key per phone number. This is the repeat-customer record — the thing the ' +
    'panel exists to show — so it is kept, and the panel needs a count of ALL of ' +
    'them, which no bounded query answers. A busy decade is a few thousand keys.',

  'upiReview':
    'one key per admin verify-or-ignore, with who decided and why. EOD folds each ' +
    'state into the archived ledger, so the archive carries the decision — but the ' +
    'note and the decider are worth keeping addressable, and a review written in ' +
    'the window between the archive and the reset is in no archive at all. A ' +
    'handful a day.',

  'upiRouting/totals':
    'one key per month. Twelve a year, and the per-account totals a tax question ' +
    'would start from.',

  'orders/daily':
    'one small record per CLOSED day — the sums analytics draws a long range from. ' +
    'This is the node that stopped the page reading orders/history whole: every ' +
    'figure on it except the transactions table is a sum over orders, and sums ' +
    'compose, so a day added up once answers as well as its orders do. It grows with ' +
    'days traded rather than with orders — a few hundred bytes a day against the ' +
    'hundred kilobytes of orders behind them, and a decade of trading is a few ' +
    'megabytes. Reading it whole IS the bounded thing to do here.',

  'orders/history':
    'the café’s whole order history, and the one read on this page that is NOT made ' +
    'on a page load. It happens when somebody presses "Load them all" on the ' +
    'transactions card, because a rollup cannot answer "find the order with this ' +
    'note in it" and search and export have to be able to. Everything else that used ' +
    'to need it now comes from orders/daily. See loadAllTxns in analytics.html.',
};


// ---------------------------------------------------------------- the Worker
// Its reads are plain fetches of the REST API rather than db.ref(), so they are
// swept separately — but against the same two tables above plus these, which are
// nodes only the robot ever reads.
const WORKER_BOUNDED = {
  'monitor':      'the monitor’s own memory: which payIds it has already alerted on, ' +
                  'which banks are alarming, which cash-outs it has reported. Every one ' +
                  'of those maps is pruned in the same run that writes it — a key whose ' +
                  'ledger entry is gone is deleted — so it is as long as the day is.',
  'orders/tableIndex': 'the public table lookup. This is the node the prune job exists ' +
                  'for: it is read whole so that entries older than six hours can be ' +
                  'removed, which is what keeps it short. Reading it whole IS the ' +
                  'bounded thing to do, and it is bounded BY this read.',
};

// Nothing the Worker reads whole grows without limit, which is the point of the list
// above having only two entries in it. orders/completed — the largest node here, one
// record per ticket, and the only evidence the ETA model is refit from — is the node
// that would have belonged here, and does not, because the refit takes the recent end
// of it by key rather than the node itself.

{
  const src = fs.readFileSync(path.join(ROOT, 'worker', 'worker.js'), 'utf8');
  const wfound = new Map();

  // fetch(DB_URL + '/some/path.json?...') — a read unless it carries a method, which
  // is on the options object rather than in the URL, so the whole call is examined.
  //
  // A path assembled from a literal head and a variable is SKIPPED, and that is not an
  // oversight: almost all of them are one record addressed by its id — a user's role, a
  // recipe, one cron-failure record — which is bounded by construction, and sweeping
  // them in would bury the question this file asks under two dozen answers of "yes,
  // obviously". Nothing generic can tell those from the one case where the variable
  // names a NODE rather than a record, which is orders/completed/{station}: two
  // stations, each a node of every ticket ever cooked. So that one is held by name
  // below rather than by the sweep, because the sweep cannot see it.
  for (const m of src.matchAll(/fetch\(\s*DB_URL\s*\+\s*'([^']+)'([\s\S]{0,220})/g)) {
    const raw = m[1], tail = m[2];
    const q = raw.indexOf('.json');
    if (q < 0) continue;                                   // a path built from a variable
    const query = raw.slice(q);
    const p2 = raw.slice(0, q).replace(/^\/+|\/+$/g, '');
    if (!p2) continue;                                     // the root, which is only ever PATCHed
    if (/method\s*:\s*'(PUT|PATCH|POST|DELETE)'/.test(tail.split(');')[0] || '')) continue;
    if (/shallow=true|limitTo|orderBy|startAt|endAt|equalTo/.test(query)) continue;   // bounded
    if (!wfound.has(p2)) wfound.set(p2, true);
  }
  // monLoad(token, '/path') is the same read with the .json bolted on inside it.
  for (const m of src.matchAll(/monLoad\(\s*token\s*,\s*'([^']+)'/g)) {
    const p2 = m[1].replace(/^\/+|\/+$/g, '');
    if (p2) wfound.set(p2, true);
  }

  check('the sweep found the Worker’s whole-node reads', wfound.size >= 4,
        wfound.size + ' found: ' + [...wfound.keys()].join(', '));

  const known = Object.assign({}, BOUNDED, GROWS, WORKER_BOUNDED);
  // A path with a {id} in it is one record, not a node — those are written as
  // concatenations and never match the literal sweep above, so anything that DOES
  // match is a node read whole.
  const unclassified = [...wfound.keys()].filter(p2 => !(p2 in known));
  check('every node the Worker reads whole is one somebody has thought about',
        unclassified.length === 0, unclassified.join('; '));
  unclassified.forEach(p2 => note('classify ' + p2 + ': is it bounded, or does it grow?'));

  // The two that were found by adding this sweep, held by name: a limit removed from
  // either is not a performance regression, it is a job that eventually stops.
  check('the weekly digest does not read every day the café has ever traded',
        !wfound.has('pos/eodArchive'),
        'pos/eodArchive is read whole by the Worker');
  note('it wants seven days, and the archive carries every bill of every one of them');
  check('and the ETA refit does not read every ticket ever cooked',
        /orders\/completed\/'\s*\+\s*station\s*\+\s*'\.json\?orderBy/.test(src) ||
        /limitToLast/.test(src.slice(src.indexOf('async function rcLoadCompleted'),
                                    src.indexOf('async function rcLoadCompleted') + 1400)),
        'rcLoadCompleted reads orders/completed with no limit');
  note('one record per ticket, kept forever, for a window 75 days wide');

  const stale = Object.keys(WORKER_BOUNDED).filter(p2 => !wfound.has(p2));
  check('and nothing is listed for the Worker that it no longer reads',
        stale.length === 0, stale.join(', ') + ' — drop it from this file');
}

// ---------------------------------------------------------------- the sweep
const found = new Map();
for (const page of PAGES) {
  const src = readPage(page);
  for (const m of src.matchAll(/db\.ref\((['"][^'"]*['"])\)((?:\s*\.\w+\([^)]*\))*)/g)) {
    const path = m[1].replace(/['"]/g, '');
    const chain = (m[2] || '').replace(/\s+/g, '');
    if (!/\.(once|on)\(/.test(chain)) continue;                        // not a read
    if (/limitTo|orderBy|startAt|endAt|equalTo/.test(chain)) continue;  // bounded at the query
    if (!path || path.startsWith('.info')) continue;                    // Firebase's own metadata
    if (!found.has(path)) found.set(path, new Set());
    found.get(path).add(page);
  }

  // A READ THROUGH A VARIABLE IS STILL A READ
  //
  // The sweep above only sees db.ref(P).on(...) written as one expression. A page
  // that keeps the ref so it can detach it later — which every long-lived listener
  // here does — writes `q = db.ref(P); ... q.on(...)`, and that was invisible: the
  // chain captured is empty, so it did not look like a read at all.
  //
  // loadAllTxns fell into exactly that hole. It changed from a once() to a kept
  // listener, for a reason that had nothing to do with this file, and orders/history
  // silently stopped being a whole-node read as far as this guard was concerned.
  for (const m of src.matchAll(/(\w+)\s*=\s*db\.ref\((['"][^'"]*['"])\)((?:\s*\.\w+\([^)]*\))*)\s*;/g)) {
    const name = m[1];
    const path = m[2].replace(/['"]/g, '');
    const chain = (m[3] || '').replace(/\s+/g, '');
    if (/limitTo|orderBy|startAt|endAt|equalTo/.test(chain)) continue;   // bounded at the query
    if (!path || path.startsWith('.info')) continue;
    // Is it ever read through that name?
    const used = new RegExp('\\b' + name + '\\s*\\.(once|on)\\(').test(src);
    if (!used) continue;
    if (!found.has(path)) found.set(path, new Set());
    found.get(path).add(page);
  }
}

check('the sweep found the whole-node reads', found.size > 20, found.size + ' found');
note(found.size + ' nodes are read whole across the ' + PAGES.length + ' pages');

{
  const unclassified = [...found.keys()].filter(p => !(p in BOUNDED) && !(p in GROWS));
  check('every node read whole is one somebody has thought about',
        unclassified.length === 0,
        unclassified.map(p => p + ' (' + [...found.get(p)].join(', ') + ')').join('; '));
  unclassified.forEach(p => note('classify ' + p + ': is it bounded, or does it grow?'));
  note('a node read whole is the café’s whole history on a phone, or it is not —');
  note('and which of those it is has to be decided, not discovered later');
}

{
  const both = Object.keys(BOUNDED).filter(p => p in GROWS);
  check('nothing is called bounded and unbounded at once', both.length === 0, both.join(', '));

  // A list that outlives what it describes stops being read. If a node is no longer
  // read whole anywhere, its entry should go with it.
  const stale = [...Object.keys(BOUNDED), ...Object.keys(GROWS)].filter(p => !found.has(p));
  check('and nothing is listed here that no page reads any more',
        stale.length === 0, stale.join(', ') + ' — drop it from this file');
}

{
  const thin = Object.entries(GROWS).filter(([, why]) => String(why).length < 80).map(([p]) => p);
  check('every growing node says what is being accepted', thin.length === 0, thin.join(', '));
  note('kept on purpose: ' + Object.keys(GROWS).join(', '));
  note('every one of them is an audit record. pos/unverified used to be here too,');
  note('and left when the Worker started settling it into the archive for its day');
}

done();
