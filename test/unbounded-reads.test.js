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

const { readPage, suite } = require('./helpers');

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
