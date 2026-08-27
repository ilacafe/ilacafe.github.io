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
  'pos/cashDrawer':         'a number',
  'pos/lastSplitHeads':     'a number',
  'pos/tips/lastHeads':     'a number',
};

// These grow with the café's history and nothing removes from them. Each entry says
// what is accepted and, more importantly, why it cannot just be pruned — every one
// of them is the only copy of something.
const GROWS = {
  'customers':
    'one key per phone number, forever. The panel needs a count of ALL of them and ' +
    'the share who came back, which a bounded query cannot answer — so bounding this ' +
    'means keeping a counter or showing an approximate KPI. Read once per page load; ' +
    'updates after that are deltas, so the cost is per open, not per bill.',

  'upiReview':
    'one key per admin verify-or-ignore, forever. EOD folds each state into the ' +
    'archived ledger and clears pos/ledgerEntries, but never clears this — the keys ' +
    'orphan, by the till’s own admission. Pruning the orphans would be right except ' +
    'for the window between the EOD archive being written and the reset landing: a ' +
    'review written in it is in no archive, and deleting it loses an admin’s note.',

  'pos/unverified':
    'one key per payment still unverified at closing, forever. When a late credit ' +
    'finally matches, the reconciler sets state=verified here rather than removing ' +
    'the row — and it has to, because the archive was written BEFORE the payment was ' +
    'parked, so this node is the only record that the money ever arrived. Nothing can ' +
    'be pruned until a late verification has somewhere permanent to live.',

  'upiRouting/totals':
    'one key per month — twelve a year. Named rather than called bounded, because ' +
    'nothing removes them; it is just slow enough never to matter.',
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
  note('the four that grow: ' + Object.keys(GROWS).join(', '));
  note('none is a bug today. all three of the real ones hold the only copy of');
  note('something, which is why none of them has been pruned on a guess');
}

done();
