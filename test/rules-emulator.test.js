// What the database rules actually permit, asked of a real database.
//
// docs/database-access.md names the gap this fills. The offline rules check reads
// the file: it can see that a path has *some* rule, and that nothing is world-
// writable, but not whether a condition is the RIGHT one for a role.
// `".read": "auth != null"` and `".read": "…role.val() === 'admin'"` both pass it,
// and only one of them is right for pos/ledgerEntries. tools/probe-rules.js asks
// the live database the same question from outside — but with no credentials, so
// it can only ever ask what a stranger can READ, and only after a deploy.
//
// This runs database.rules.json in the Firebase emulator and asks every question
// the other two cannot: what each ROLE may read and write, on every pull request,
// before anything is deployed anywhere.
//
// Two halves, and they answer opposite questions:
//
//   coverage  every path the apps use is permitted to the app that uses it.
//             Derived from the access map, so it cannot drift from the code. This
//             is what makes tightening a rule safe: locking the café out of its
//             own till fails here rather than at the counter.
//
//   denials   what must NOT be permitted. Written down separately, by hand, for
//             the reason probe-rules.js gives: a list derived from the rules would
//             agree with them by construction and check nothing.
//
// Not part of `npm test` — it needs Java and the emulator. `npm run test:rules`.

const { derivePaths, deriveWorkerPaths, APPS, suite } = require('./helpers');

const BASE = process.env.RULES_EMULATOR_URL || 'http://127.0.0.1:9010';
const NS = process.env.RULES_EMULATOR_NS || 'demo-ila-default-rtdb';

// The emulator reads auth.uid and auth.token out of an unsigned JWT passed as the
// ?auth= query parameter. That is all these rules look at, so there is no Firebase
// SDK here, no service account and no network — the identities below are just claims.
//
// It has to be ?auth=. The emulator treats ANY bearer token in an Authorization
// header as the owner credential, which bypasses rules altogether: written that way
// every denial below passes without testing anything, and a database that is wide
// open reports as one that is locked down. `Bearer owner` seeds, and does nothing else.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(claims) {
  const now = Math.floor(Date.now() / 1000);
  return b64({ alg: 'none', typ: 'JWT' }) + '.' + b64(Object.assign({
    iss: 'https://securetoken.google.com/demo-ila', aud: 'demo-ila',
    iat: now, exp: now + 3600, firebase: { sign_in_provider: 'password' }
  }, claims)) + '.';
}

// The rules only ever ask two things of a role: does it exist, and is it 'admin'.
// One account per role name the access map uses, so the suite says something true
// about each app rather than about a role invented for it.
const ROLES = ['admin', 'cashier', 'barista', 'chef', 'inventory'];
const WHO = {
  nobody: null,                                                   // no credentials at all
  anon: token({ sub: 'anonUid', user_id: 'anonUid', firebase: { sign_in_provider: 'anonymous' } }),
  robot: token({ sub: 'robotUid', user_id: 'robotUid', email: 'robot@cafeila.app' }),
};
ROLES.forEach(r => { WHO[r] = token({ sub: r + 'Uid', user_id: r + 'Uid', email: r + '@ila.test' }); });

const OWNER = 'owner';   // the emulator's bypass credential, for seeding only

// The access map names roles the way the pages talk about them; WHO above names the
// identities this suite can sign as. They are not the same strings, and the coverage
// loop below used to key straight into WHO and `continue` on a miss — so
// `customer (anonymous)` matched nothing and every path the ordering page uses was
// skipped in silence. Eighteen questions, all of them about the one caller with no
// credentials at all, none of them asked.
//
// Hence a map, and hence unmapped being a failure rather than a skip. A check that
// quietly asks less than it claims is worse than one that is not there.
const AS = { 'customer (anonymous)': 'anon' };
const identityFor = (role) => AS[role] || role;

async function call(method, path, who, body) {
  let url = BASE + '/' + String(path).replace(/^\/+/, '') + '.json?ns=' + NS;
  const headers = {};
  if (who === OWNER) headers.Authorization = 'Bearer owner';       // seeding only — bypasses rules
  else if (WHO[who]) url += '&auth=' + WHO[who];
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  await res.text();
  return res.status;
}
const canRead = async (path, who) => (await call('GET', path, who)) === 200;
const canWrite = async (path, who, body) => (await call('PUT', path, who, body === undefined ? { probe: 1 } : body)) === 200;

async function seed() {
  await call('PUT', '', OWNER, null);                    // a clean database for every run
  for (const r of ROLES) await call('PUT', 'users/' + r + 'Uid', OWNER, { role: r, name: r });
  // enough of a café for a rule that reads root.child(...) to have something to read
  await call('PUT', 'menu/Coffee/Latte', OWNER, { price: 250 });
  await call('PUT', 'settings/isOpen', OWNER, true);
}

// Payloads for the paths that carry a .validate. Everything else is probed with a
// throwaway child, which tests the same permission chain without destroying the
// node. A path that gains a .validate and is not listed here fails coverage — which
// is the point: the rule and the write have to agree, and the suite is where that
// argument happens rather than at a till.
// $key stands for an id the access map could not resolve, and for most paths any id
// will do. Not for users/$key: the rule there is `auth.uid === $uid`, so the only
// child a cashier may read is their own. Probing a made-up id would report the
// sign-in every page performs as forbidden.
// Reading and writing it are different operations with different right answers: the
// only account a cashier may READ is their own, and the account an admin WRITES had
// better not be one this suite is signed in as — probing that key with a throwaway
// payload strips the role off the identity running the rest of the checks.
const KEY_FOR = {
  'users/$key': (role, op) => (op === 'read' ? role + 'Uid' : 'probeUid'),
};

const SAMPLES = {
  // The five numbers the till writes beside the archive when it closes the day, so
  // analytics can render a closing without downloading that day's whole bills and
  // ledger. closedAt goes in as the server's own clock, the way the archive's does.
  'pos/eodSummary/$key': {
    cash: 8000, upi: 12000, bills: 42, closedBy: 'Tara', closedAt: { '.sv': 'timestamp' }
  },
  // Written once, by whichever analytics open rebuilt the summaries for closings made
  // before they existed. Its presence is what stops that read repeating.
  'pos/eodSummaryBackfill': { at: 1756200000000, days: 120 },

  // What the ordering page actually pushes for a takeaway. upiId and billedAt are in
  // here because they go in on CREATE: the customer's phone picks the VPA and stamps
  // the moment it drew the code, and under these rules an anonymous browser may
  // create an order and never touch it again — so if either field were refused, the
  // whole write would be, and no web order could be placed at all.
  'orders/pendingWeb/$key': {
    orderType: 'Takeaway', tableOrAddress: 'Takeaway', notes: '', items: { Latte: { qty: 1, price: 250 } },
    total: 250, paymentMethod: 'UPI', phone: '9990001111', gated: false,
    upiId: 'ila@okaxis', billedAt: { '.sv': 'timestamp' },
    trackId: 'tk1', createdAt: { '.sv': 'timestamp' }
  },
  'payments/incoming/$key': { amount: 250, ref: '512345678901', at: 1756200000000, bank: 'yes', acct: '8020' },
  'orders/tableIndex/$key/$key': 1756200000000,
  // Fields inside a record that carries a .validate. A throwaway child would be
  // refused for being the wrong shape, which says nothing about who may write it.
  'orders/track/$key/paymentVerified': true,
  'orders/pendingWeb/$key/payment': { ref: '512345678901', amount: 250, at: 1756200000000,
                                      payId: 'web_tk1', bankTag: 'yes 8020' },
  // Somebody at the counter, or the owner on their phone, saying they have SEEN the
  // money for an order the bank has not confirmed yet. It is what lets the kitchen
  // start, so it has to be writable by staff — and it carries a name, so it has to
  // be refused to everyone else.
  'orders/pendingWeb/$key/manualPaid': { by: 'Priya', at: 1756200000000, via: 'pos' },
  'orders/track/$key': {
    status: 'received', items: { Latte: { qty: 1, price: 250 } }, table: 'Table 4',
    gated: false, createdAt: { '.sv': 'timestamp' }
  },
};

(async () => {
  const { check, note, done } = suite('Database rules — run in the emulator');

  try {
    await fetch(BASE + '/.json?ns=' + NS);
  } catch (e) {
    console.log('  the emulator is not running at ' + BASE + ' — start it with `npm run test:rules`');
    process.exitCode = 1;
    return;
  }

  await seed();

  // Some derived paths are children of a record that carries a .validate — writing
  // orders/track/probeKey/paymentVerified means creating probeKey, and the creation
  // shape rightly refuses a lone flag. The parents are seeded so the probe asks the
  // question it means to: may this role write THIS FIELD of an order that exists.
  await call('PUT', 'orders/track/probeKey', OWNER, SAMPLES['orders/track/$key']);
  await call('PUT', 'orders/pendingWeb/probeKey', OWNER, SAMPLES['orders/pendingWeb/$key']);

  // ---------------------------------------------------------------- coverage
  {
    const used = derivePaths();
    const denied = [];
    let asked = 0;
    let probe = 0;

    const unplaceable = new Set();

    for (const [path, use] of used) {
      if (path.includes('${')) continue;                 // a template segment; its literal sibling covers it
      // Two probes want opposite things from the same key. A child-field probe
      // (orders/track/$key/paymentVerified) needs the record above it to EXIST, which
      // is why the seed writes probeKey. A creation probe (orders/track/$key) needs it
      // NOT to — `!data.exists()` is the whole of what lets a customer place an order.
      // Sharing one key made the second question unanswerable: the seed had already
      // created the record, so the rule fell through to the role check and reported
      // that a customer cannot place an order, which is the opposite of the truth.
      //
      // So a write that creates a record gets a key of its own, per role. Reads keep
      // the seeded one, where there is something to read.
      const at = (role, op) => {
        if (KEY_FOR[path]) return path.replace(/\$key/g, KEY_FOR[path](role, op));
        if (op === 'write' && path.endsWith('$key')) {
          return path.slice(0, -'$key'.length).replace(/\$key/g, 'probeKey') + 'probeKey-' + role;
        }
        return path.replace(/\$key/g, 'probeKey');
      };
      for (const named of use.read) {
        const role = identityFor(named);
        if (!(role in WHO)) { unplaceable.add(named); continue; }
        asked++;
        if (!(await canRead(at(role, 'read'), role))) denied.push(named + ' cannot READ ' + path);
      }
      for (const named of use.write) {
        const role = identityFor(named);
        if (!(role in WHO)) { unplaceable.add(named); continue; }
        asked++;
        const sample = SAMPLES[path];
        // A path with a .validate is written with a real payload; anything else gets a
        // throwaway child, which walks the same permission chain without clobbering the node.
        const ok = sample
          ? await canWrite(at(role, 'write'), role, sample)
          : await canWrite(path.endsWith('$key') ? at(role, 'write')
                                                 : at(role, 'write') + '/__probe' + (++probe), role);
        if (!ok) denied.push(named + ' cannot WRITE ' + path);
      }
    }

    check('every role the access map names is one this suite can sign in as',
          unplaceable.size === 0, [...unplaceable].join(', ') + ' — add it to AS');
    note('an unmapped role used to be skipped, which made the coverage below a smaller');
    note('claim than it read as, and said nothing about it');

    check('every path an app uses is permitted to the app that uses it',
          denied.length === 0, denied.join('\n        '));
    note(asked + ' role-and-path questions, derived from the access map');
    note('this is the half that makes tightening a rule safe — a locked-out till fails here');
  }

  // ------------------------------------------- and to whoever actually opened it
  //
  // The coverage above asks whether the role the access map ASSIGNS to a page can use
  // it: pos.html is mapped to cashier, so it asks about a cashier. Nobody told the
  // café that. Any member of staff can open the till, and a barista who does gets a
  // page that loads, works, and shows an empty cash-up — because a denied read in
  // Realtime Database is an empty snapshot, not an error.
  //
  // That is how pos/ledgerEntries went unnoticed: every check in this file passed,
  // because every check asked about a cashier.
  //
  // The rule is not that everything must be open to everybody. The café wants the
  // cash-up held to the counter and the owner, and NARROWED is listed below with what
  // the page does about it — because a restriction nobody can see is the part that
  // actually hurt. Anything narrowed that is not on this list fails, so the next one
  // is a decision rather than a discovery.
  {
    const SHARED = ['pos.html', 'chef.html', 'barista.html', 'inventory.html'];
    const sharedRoles = new Set(SHARED.map(f => APPS[f]).filter(Boolean));

    const NARROWED = {
      'pos/ledgerEntries':
        'the cash-up: the counter and the owner. pos.html catches the denial and says ' +
        'so rather than drawing "No logs."',
      'pos/unverified':
        'last night\'s carried-over payments, same gate as the ledger. Nothing renders ' +
        'them directly; the reconciler treats a denial as nothing to carry.',
    };

    const surprises = [], stale = new Set(Object.keys(NARROWED));
    for (const [path, use] of derivePaths()) {
      if (path.includes('${')) continue;
      // A shared page reads it: that is the whole test. It does not matter that an
      // owner page reads it too — pos/ledgerEntries is read by admin.html as well, and
      // excluding anything the owner also looks at skipped exactly the path this check
      // exists for. It passed against the broken rules until that line came out.
      if (![...use.read].some(r => sharedRoles.has(r))) continue;

      const shut = [];
      for (const role of ROLES) {
        const at = path.replace(/\$key/g, KEY_FOR[path] ? KEY_FOR[path](role, 'read') : 'probeKey');
        if (!(await canRead(at, role))) shut.push(role);
      }
      if (!shut.length) { stale.delete(path); continue; }
      stale.delete(path);
      if (!(path in NARROWED)) surprises.push(path + ' is shut to ' + shut.join(', '));
    }

    check('anything a shared page reads that not all staff can is written down here',
          surprises.length === 0, surprises.join('; '));
    note('a denied read is an empty snapshot, not an error — the till does not complain,');
    note('it just shows nothing, and only the person holding it ever finds out');

    check('and nothing is listed that every staff role can now read',
          stale.size === 0, [...stale].join(', ') + ' — drop it from NARROWED');
  }

  // ---------------------------------------------------------- the Worker's half
  //
  // derivePaths only sees the pages, so the coverage above says nothing about the one
  // component that is not a browser. That matters more here than anywhere: monLoad
  // returns null on a denied read without saying why, so a rule that shuts the robot
  // out does not fail — the hourly report simply stops finding anything, the monthly
  // refit reads no completions, and nothing anywhere says so.
  {
    const worker = deriveWorkerPaths();
    // The robot looks up the SENDER of a push by uid, so the key it reads is somebody
    // else's; everything else takes a throwaway one.
    const KEYS = { 'users/$key': 'cashierUid' };
    const shut = [];
    let asked = 0;
    for (const [path, use] of worker) {
      const concrete = path.replace(/\$key/g, KEYS[path] || 'probeKey');
      if (use.read) {
        asked++;
        if (!(await canRead(concrete, 'robot'))) shut.push('robot cannot READ ' + path);
      }
      if (use.write) {
        asked++;
        const sample = SAMPLES[path];
        const ok = sample ? await canWrite(concrete, 'robot', sample)
                          : await canWrite(path.endsWith('$key') ? concrete : concrete + '/__wprobe', 'robot');
        if (!ok) shut.push('robot cannot WRITE ' + path);
      }
    }
    check('the Worker can still reach everything it touches', shut.length === 0,
          shut.slice(0, 5).join('; '));
    note(asked + ' questions, derived from worker.js — a denied read there is a silent one');
  }

  await seed();   // coverage wrote probes; start the denials from a known café

  // ---------------------------------------------------------------- denials
  //
  // Written by hand, not derived. Each line is a sentence about the café that
  // happens to be checkable, and the rules are what has to make it true.
  {
    // Who can read the sensitive nodes, stated as a table rather than a pass/fail
    // list — because two of these rows are wider than they ought to be, and a bare
    // FAIL would only say so once. Written down as what IS true, so that closing a
    // row fails here and asks for this table to be updated with the good news.
    const READERS = ['nobody', 'anon', 'cashier', 'barista', 'chef', 'inventory', 'admin', 'robot'];
    const EXPECTED_READERS = {
      '':                    [],                                    // the root, to anyone
      'staff':               ['cashier', 'barista', 'chef', 'inventory', 'admin', 'robot'],
      'users':               ['admin'],
      'pos':                 [],
      'pos/activeTables':    ['cashier', 'barista', 'chef', 'inventory', 'admin'],
      'pos/ledgerEntries':   ['cashier', 'admin', 'robot'],
      'pos/unverified':      ['cashier', 'admin', 'robot'],   // the robot settles late credits into the archive
      'pos/eodArchive':      ['admin', 'robot'],
      'pos/eodSummary':      ['admin', 'robot'],          // an index over the archive, same readers
      'pos/eodSummaryBackfill': ['admin', 'robot'],
      'orders/history':      ['admin'],
      'orders/pendingWeb':   ['cashier', 'barista', 'chef', 'inventory', 'admin'],
      'payments':            ['cashier', 'barista', 'chef', 'inventory', 'admin'],
      'payments/incoming':   ['cashier', 'barista', 'chef', 'inventory', 'admin'],
      'security':            ['admin'],
      'customers':           ['admin'],                                    // the LIST; one customer is readable below
      'inventory':           ['cashier', 'barista', 'chef', 'inventory', 'admin'],
      'inventory/recipes':   ['cashier', 'barista', 'chef', 'inventory', 'admin', 'robot'],
      'reconciliation':      ['admin'],
      'monitor':             ['admin', 'robot'],
      'upiReview':           ['cashier', 'barista', 'chef', 'inventory', 'admin', 'robot'],
      'upiRouting':          [],
      'upiRouting/config':   ['cashier', 'barista', 'chef', 'inventory', 'admin'],
      'upiRouting/totals':   ['admin'],
      'pushSubscriptions':   ['admin', 'robot'],
      'ops/cronFailure':     ['admin', 'robot'],
      'ops/pushHealth':      ['admin', 'robot'],
      'eta/recalMeta':       ['admin', 'robot'],
      'eta/modelPrevious':   ['admin', 'robot'],
    };
    const wrong = [];
    for (const [path, expected] of Object.entries(EXPECTED_READERS)) {
      const actual = [];
      for (const who of READERS) if (await canRead(path, who)) actual.push(who);
      if (actual.join(',') !== expected.join(',')) {
        wrong.push((path || '/') + ': ' + (actual.join(' ') || 'nobody') + ' (expected ' + (expected.join(' ') || 'nobody') + ')');
      }
    }
    check('every sensitive node is readable by exactly who this table says',
          wrong.length === 0, wrong.slice(0, 4).join(' | '));
    note('nothing here is world-readable, and nothing but the robot reaches in from outside a role');

    // The till, and only the till and the owner.
    //
    // pos used to grant .read to any role, and a rule cannot be revoked lower down,
    // so the ledger, the bills, the drawer and the cash-up archive all came with it —
    // to the bar and the kitchen as much as to the counter. Each child is granted on
    // its own now, and the ones carrying money are named by role.
    // Three tiers, deliberately: the owner, the counter, and everyone else on shift.
    //
    // This is the one place in the rules where 'cashier' means anything — every other
    // condition asks only whether you are the owner — and it stays because the café
    // wants it. Somebody who needs the cash-up is given cashier access; not everybody
    // needs it.
    //
    // What it cost the first time was not the rule but the silence: a barista opened
    // the POS, the page worked, and the cash-up drew "No logs." A refused read in
    // Realtime Database arrives as nothing at all rather than as an error, so it looks
    // exactly like a quiet morning. The till says which it is now — see ledgerDenied
    // in pos.html, and the check for it in test/ledger-denied.test.js.
    check('the bar and the kitchen cannot read the till ledger',
          !(await canRead('pos/ledgerEntries', 'barista')) && !(await canRead('pos/ledgerEntries', 'chef')));
    check('nor the payments carried over from last night',
          !(await canRead('pos/unverified', 'barista')) && !(await canRead('pos/unverified', 'chef')));
    check('but the counter still can, and so does the owner',
          (await canRead('pos/ledgerEntries', 'cashier')) && (await canRead('pos/ledgerEntries', 'admin')));
    note('the Worker reads it too — that is the hourly report of cash leaving the drawer');

    // The customer list, and one customer.
    //
    // The till looks up customers/<phone> for a number the cashier has just typed in;
    // admin.html reads the whole node for the repeat-customer panel. The read was
    // granted at the parent for any staff role, and a read cascades — so every phone
    // number, order count and last spend the café holds came back in one request to
    // anybody on shift, on a node no staff page displays.
    //
    // Same shape as orders/track before #38: the parent read is the one that
    // enumerates, and the child read is all the app ever needed.
    check('a cashier cannot list every customer the café has',
          !(await canRead('customers', 'cashier')) && !(await canRead('customers', 'barista')));
    check('but can still look up the one whose number they were given',
          await canRead('customers/9990001111', 'cashier'));
    check('and the owner still has the list', await canRead('customers', 'admin'));
    check('the till can still count a repeat visit',
          await canWrite('customers/9990001111/orders', 'cashier', 3));

    check('a cashier cannot read the cash-up archive',
          !(await canRead('pos/eodArchive', 'cashier')));
    check('but can still write the day into it',
          await canWrite('pos/eodArchive/2026-08-26-1', 'cashier'));
    note('the till closes the day; reading the archive back is analytics, which is the owner’s');

    // The correction the Worker writes when a parked payment is finally paid.
    //
    // EOD archives the day and THEN parks the stragglers, so the archived ledger
    // says unverified — true at closing, wrong forever after. The robot appends the
    // late credit as a child of that day. What it must not be able to do is edit
    // what was archived: the ledger line is the record of what was true when the
    // till closed, and an audit that can be rewritten is not one.
    const ARCH = 'pos/eodArchive/2026-08-27-1756200000000';
    await call('PUT', ARCH, OWNER, { report: 'x', upi: 1000, cash: 500, ledger: { 0: { type: 'upi_income', payId: 'p1' } } });

    check('the robot can read what was carried over', await canRead('pos/unverified', 'robot'));
    check('and record that one of them was paid after the day closed',
          await canWrite(ARCH + '/lateVerified/p1', 'robot',
                         { ref: '512345678901', at: 1756290000000, amount: 450, bankTag: 'yes 8020' }));
    check('and then drop the parked row',
          (await call('DELETE', 'pos/unverified/p1', 'robot')) === 200);

    check('but it cannot rewrite the ledger that was archived',
          !(await canWrite(ARCH + '/ledger/0', 'robot', { type: 'upi_income', payId: 'p1' })));
    check('nor the day around it',
          !(await canWrite(ARCH + '/upi', 'robot', 999999)));
    note('the correction sits beside what was archived, never on top of it');

    check('and a correction of the wrong shape is refused',
          !(await canWrite(ARCH + '/lateVerified/p2', 'robot', { note: 'paid, trust me' })));
    check('the owner can still read the whole day', await canRead(ARCH, 'admin'));

    // Cash leaving the drawer.
    //
    // Three ledger types hand real money to a real person, and each sat behind a PIN
    // prompt in pos.html. The prompt was advice: pos is writable by any staff role, so
    // the entry could be pushed with any name on it and no PIN at all. The check moved
    // into the Worker, and this is the half that makes the move mean something — the
    // till cannot write one from here whoever is holding it.
    const CASHOUT = ['expense', 'withdrawal', 'tip_payout'];
    const wroteCashout = [];
    for (const type of CASHOUT) {
      for (const who of ['cashier', 'admin', 'barista', 'anon']) {
        const entry = { date: '03:04 pm', type: type, amount: 450, reason: 'milk (Priya)', ts: 1756200000000 };
        if (await canWrite('pos/ledgerEntries/c-' + type + '-' + who, who, entry)) {
          wroteCashout.push(who + ' wrote a ' + type);
        }
      }
    }
    check('no browser can record cash leaving the drawer, not even the owner’s',
          wroteCashout.length === 0, wroteCashout.join('; '));
    note('the PIN in front of it is a gate now rather than a prompt, because this is');
    note('the half a browser cannot skip — the Worker is the only writer left');

    check('but the robot can, which is the whole point',
          await canWrite('pos/ledgerEntries/c-robot', 'robot',
            { date: '03:04 pm', type: 'expense', amount: 450, reason: 'milk (Priya)',
              ts: 1756200000000, by: 'Priya', byUid: 'cashierUid' }));
    // Every grant the robot has under `pos` sits on the exact child it needs, never on
    // pos itself — which still says "has a staff role", and the robot has none. Three
    // children, three jobs: the cash-out it writes, the drawer that cash-out moves, and
    // the parked payments it clears once the archive has recorded them.
    //
    // pos/eodArchive/x1 is in this list rather than exempted: the robot may append to
    // ONE child of an archive, and must not be able to write an archive itself.
    const robotReach = [];
    for (const p of ['pos/bills/x1', 'pos/activeTables/x1', 'pos/eodArchive/x1',
                     'pos/upiTotal', 'pos/tips/x1']) {
      if (await canWrite(p, 'robot')) robotReach.push(p);
    }
    check('and the rest of the till is still closed to it',
          robotReach.length === 0, robotReach.join(', '));

    check('and it can read the staff map to resolve the PIN that authorised it',
          await canRead('staff', 'robot'));

    // Everything else in the ledger is still the till's to write. A sale has to be
    // recordable when the Worker is unreachable, and routing every payment through it
    // would put a network hop in front of the counter.
    const blocked = [];
    for (const type of ['cash_income', 'upi_income', 'unpaid_writeoff', 'refund_upi', 'void_cash']) {
      const entry = { date: '03:04 pm', type: type, amount: 450, reason: 'Table 4', ts: 1756200000000 };
      if (!(await canWrite('pos/ledgerEntries/k-' + type, 'cashier', entry))) blocked.push(type);
    }
    check('the till still records everything else in the ledger itself',
          blocked.length === 0, 'refused: ' + blocked.join(', '));
    note('a sale must be recordable when the Worker is unreachable');

    // Stock on and off the shelf, for the same reason.
    //
    // The PIN in front of a prep or a delivery was advice twice over: the prompt ran
    // in a browser, and inventory was writable by any staff role so the write did not
    // need the prompt at all. Someone covering shrinkage could adjust stock directly
    // and leave nothing explaining it. Unlike the till, these two nodes are written by
    // exactly one page — nothing has to keep working when the Worker is unreachable,
    // which is what makes the robot being the only writer possible at all.
    const movedStock = [];
    for (const who of ['cashier', 'admin', 'barista', 'anon']) {
      if (await canWrite('inventory/stock/Coffee Beans', who, 5)) movedStock.push(who + ' moved stock');
      if (await canWrite('inventory/logs/l-' + who, who, { action: 'Delivery Received', item: 'x', staff: 'Priya' })) {
        movedStock.push(who + ' wrote a log line');
      }
    }
    check('no browser can move stock or write its log', movedStock.length === 0, movedStock.join('; '));
    check('the robot can, and reads the recipe it deducts by',
          (await canWrite('inventory/stock/Coffee Beans', 'robot', 5)) &&
          (await canWrite('inventory/logs/l-robot', 'robot', { action: 'Prepped Batch', item: 'x', staff: 'Priya' })) &&
          (await canRead('inventory/recipes', 'robot')));
    check('and the owner still keeps the recipes and the item list',
          (await canWrite('inventory/recipes/Cold Brew', 'admin', { Beans: 0.2 })) &&
          (await canWrite('inventory/config/items/Beans', 'admin', { unit: 'kg' })) &&
          !(await canWrite('inventory/recipes/Cold Brew', 'cashier', { Beans: 0.2 })));
    check('everyone who needs to see the shelf still can',
          (await canRead('inventory/stock', 'cashier')) && (await canRead('inventory/logs', 'cashier')));
    note('the tablet reads the stock and the log; it just cannot write either any more');

    // What admin.html and analytics.html show, and nobody else needs.
    const OWNERS_ALONE = ['pos/eodArchive', 'orders/history', 'security/voids', 'security/unpaid',
                          'reconciliation', 'monitor', 'ops/cronFailure', 'ops/pushHealth',
                          'eta/recalMeta', 'eta/modelPrevious', 'pushSubscriptions',
                          'upiRouting/totals', 'users'];
    const reachable = [];
    for (const p of OWNERS_ALONE) {
      for (const who of ['cashier', 'barista', 'chef', 'inventory']) {
        if (await canRead(p, who)) reachable.push(who + ' → ' + p);
      }
    }
    check('nothing the owner’s two pages show is readable by anyone else',
          reachable.length === 0, reachable.slice(0, 5).join('; '));
    note('admin.html and analytics.html check the role themselves, in a browser the');
    note('holder controls — so it is advice until the rules say the same thing');

    check('every role can still read the staff PIN hashes',
          (await canRead('staff', 'barista')) && (await canRead('staff', 'chef')));
    note('docs/database-access.md: the salt is a literal in the page, so any staff');
    note('account recovers every PIN in under a second. Restricting the read is not the');
    note('fix — the PIN is checked in a browser — and pos and inventory both need it.');

    const MUST_NOT_WRITE = [
      ['nobody', 'menu/Coffee/Latte', 'the menu, by a stranger'],
      ['nobody', 'orders/pendingWeb/x1', 'an order, by a stranger'],
      ['nobody', 'eta/model', 'the wait-time model, by a stranger'],
      ['anon', 'menu/Coffee/Latte', 'the menu, by a customer'],
      ['anon', 'settings/isOpen', 'whether the café is open, by a customer'],
      ['anon', 'eta/model', 'the wait-time model, by a customer'],
      ['anon', 'eta/live', 'the live kitchen tempo, by a customer'],
      ['anon', 'payments/incoming/x1', 'a bank credit, by a customer'],
      ['anon', 'pos/ledgerEntries/x1', 'a ledger line, by a customer'],
      ['anon', 'staff/x1', 'a staff PIN, by a customer'],
      ['anon', 'users/anonUid', 'their own role, by a customer'],
      ['anon', 'orders/history/x1', 'the sales archive, by a customer'],
      ['cashier', 'menu/Coffee/Latte', 'the menu, by a cashier'],
      ['cashier', 'staff/x1', 'a staff PIN, by a cashier'],
      ['cashier', 'users/cashierUid', 'their own role, by a cashier'],
      ['cashier', 'payments/incoming/x1', 'a bank credit, by a cashier'],
      ['cashier', 'ops/cronFailure/x1', 'the Worker’s failure record, by a cashier'],
      ['barista', 'staff/x1', 'a staff PIN, by the bar'],
      ['chef', 'menu/Coffee/Latte', 'the menu, by the kitchen'],
      ['robot', 'menu/Coffee/Latte', 'the menu, by the robot'],
    ];
    const wrote = [];
    for (const [who, path, what] of MUST_NOT_WRITE) {
      if (await canWrite(path, who)) wrote.push(who + ' CAN write ' + path + ' — ' + what);
    }
    check('nothing writes what it has no business writing', wrote.length === 0,
          wrote.slice(0, 5).join('; '));
    note('the pages check all of this too, in a browser the customer controls');

    // The one identity that is named by email rather than by role.
    check('only the robot may record a bank credit',
          (await canWrite('payments/incoming/r1', 'robot', SAMPLES['payments/incoming/$key'])) &&
          !(await canWrite('payments/incoming/r2', 'cashier', SAMPLES['payments/incoming/$key'])) &&
          !(await canWrite('payments/incoming/r3', 'barista', SAMPLES['payments/incoming/$key'])));
    check('and only the robot may say a scheduled job is failing',
          (await canWrite('ops/cronFailure/monitor', 'robot')) &&
          !(await canWrite('ops/cronFailure/other', 'admin')));
    note('no browser holds that credential, and nothing in a page can obtain it');

    // A trackId is the only thing between one customer's order and another's.
    await call('PUT', 'orders/track/someoneElse', OWNER, SAMPLES['orders/track/$key']);
    check('a customer cannot overwrite somebody else’s order tracking',
          !(await canWrite('orders/track/someoneElse', 'anon', SAMPLES['orders/track/$key'])));
    check('but can still create their own',
          await canWrite('orders/track/mine', 'anon', SAMPLES['orders/track/$key']));
    check('and the counter can still advance one that exists',
          await canWrite('orders/track/someoneElse/status', 'cashier', 'ready'));

    // Same shape, on the node a stranger's order arrives in.
    await call('PUT', 'orders/pendingWeb/someoneElse', OWNER, SAMPLES['orders/pendingWeb/$key']);
    check('a customer cannot alter an order already placed',
          !(await canWrite('orders/pendingWeb/someoneElse', 'anon', SAMPLES['orders/pendingWeb/$key'])));
    check('nor delete one', (await call('DELETE', 'orders/pendingWeb/someoneElse', 'anon')) !== 200);
  }

  // --------------------------------------- what a stranger may put in those nodes
  //
  // orders/track and orders/pendingWeb are the only two nodes an anonymous visitor
  // can write, and the ordering page signs everyone in anonymously, so "anonymous"
  // is anyone at all. orders/track is world-readable as well: for a while it took
  // any JSON of any shape and served it back to the internet.
  //
  // Both let a stranger CREATE and never modify, so the shape is checked on
  // creation. That is where the whole exposure is, and it means no record already
  // in the database has to satisfy anything it was not written to satisfy.
  {
    const TRACK = () => JSON.parse(JSON.stringify(SAMPLES['orders/track/$key']));
    const WEB = () => JSON.parse(JSON.stringify(SAMPLES['orders/pendingWeb/$key']));
    let n = 0;
    const asAnon = async (node, mutate) => {
      const body = node === 'track' ? TRACK() : WEB();
      mutate(body);
      const path = (node === 'track' ? 'orders/track/t' : 'orders/pendingWeb/w') + (++n);
      return canWrite(path, 'anon', body);
    };

    check('a customer can still place an order and track it',
          (await asAnon('web', () => {})) && (await asAnon('track', () => {})));
    note('everything below has to stay false without this ever becoming false');

    // The order has to arrive carrying the VPA it is billed to and the moment the
    // customer was shown a code, or the till's matcher will not tie any bank credit
    // to it — and it has to arrive with them in the SAME write, because the next
    // line is the rule that stops the same browser adding them afterwards.
    check('and it arrives billed: the VPA, and when the customer was asked',
          (await asAnon('web', (o) => { o.upiId = 'cafe.ila.blr@okaxis'; o.billedAt = { '.sv': 'timestamp' }; })));
    await call('PUT', 'orders/pendingWeb/billed', OWNER, WEB());
    check('but cannot be re-billed to somewhere else afterwards',
          !(await canWrite('orders/pendingWeb/billed/upiId', 'anon', 'attacker@ybl')) &&
          !(await canWrite('orders/pendingWeb/billed/billedAt', 'anon', Date.now())));

    const rejected = [];
    const must = async (what, node, mutate) => {
      if (await asAnon(node, mutate)) rejected.push(what);
    };
    await must('a field nobody wrote', 'track', (o) => { o.payload = 'x'; });
    await must('a field nobody wrote, on an order', 'web', (o) => { o.payload = 'x'; });
    // payLinkSentAt was billedAt's old name. It is no longer a field: nothing writes
    // it and the rules no longer name it, so it falls to the $other catch-all like
    // any other key nobody wrote. This is the line that says the retirement is real.
    await must('the field name that was retired', 'web',
               (o) => { delete o.billedAt; o.payLinkSentAt = { '.sv': 'timestamp' }; });
    await must('a field nobody wrote, nested in a cart line', 'track',
               (o) => { o.items.Latte.payload = 'x'.repeat(4000); });
    await must('a status longer than a status', 'track', (o) => { o.status = 'x'.repeat(500); });
    await must('a table label longer than a table label', 'track', (o) => { o.table = 'x'.repeat(500); });
    await must('an order note longer than a note', 'web', (o) => { o.notes = 'x'.repeat(5000); });
    await must('an address longer than an address', 'web', (o) => { o.tableOrAddress = 'x'.repeat(5000); });
    await must('a backdated order', 'track', (o) => { o.createdAt = 1; });
    await must('an order dated next year', 'web', (o) => { o.createdAt = 2000000000000; });
    await must('a cart line with no quantity', 'track', (o) => { delete o.items.Latte.qty; });
    await must('a cart line priced as a string', 'web', (o) => { o.items.Latte.price = '250'; });
    await must('a thousand of something', 'track', (o) => { o.items.Latte.qty = 1000; });
    await must('a total that is not a number', 'web', (o) => { o.total = 'lots'; });
    // The order that a person has vouched for is the one the kitchen starts on. A
    // browser that could write this into its own order at creation would be telling
    // the till the money had been seen — by a name it made up.
    await must('an order that vouches for its own payment', 'web',
               (o) => { o.manualPaid = { by: 'Priya', at: 1756200000000, via: 'pos' }; });
    // And the older way of claiming the same thing. `payment.ref` is the till's record
    // that a BANK CREDIT matched this order — it is what turns the badge green and,
    // now, what lets the kitchen start. An order that arrives already carrying one has
    // written the answer to the only question the counter asks about it.
    await must('an order carrying a bank credit it wrote itself', 'web',
               (o) => { o.payment = { ref: '512345678901', amount: 250, at: 1756200000000,
                                      payId: 'web_tk1', bankTag: 'yes 8020' }; });
    await must('an order with no items at all', 'web', (o) => { delete o.items; });
    await must('a tracking record with no status', 'track', (o) => { delete o.status; });
    await must('items that are not items', 'track', (o) => { o.items = 'a string'; });

    check('and a stranger can write nothing else into either of them',
          rejected.length === 0, 'accepted: ' + rejected.join('; '));
    note('the node used to take any JSON of any shape, and serve it back world-readable');

    // A POS-entered order creates its own tracking record, and it is a different
    // shape from the customer's: no createdAt, and it carries the wait-time
    // prediction the accuracy report later joins against.
    check('the till can create a tracking record of its own shape',
          await canWrite('orders/track/posmade', 'cashier', {
            status: 'preparing', items: { Margherita: { qty: 1, price: 400, base: 'Margherita', mods: null } },
            table: 'Table 6', stations: 2, stationsDone: 0,
            acceptedAt: { '.sv': 'timestamp' },
            predLow: 9, predHigh: 17, predPoint: 13, predOvenIdleMin: 4,
            predLoadChef: 3, predLoadBarista: 1, predModelVersion: '2026-06'
          }));

    // The counter still has to be able to work on what it accepted.
    await call('PUT', 'orders/track/staffside', OWNER, TRACK());
    check('and the counter can still advance, price and finish an order',
          (await canWrite('orders/track/staffside/status', 'cashier', 'preparing')) &&
          (await canWrite('orders/track/staffside/stationsDone', 'chef', 1)) &&
          (await canWrite('orders/track/staffside/paymentVerified', 'cashier', true)) &&
          (await canWrite('orders/track/staffside/predPoint', 'cashier', 12.5)));
    await call('PUT', 'orders/pendingWeb/staffside', OWNER, WEB());
    check('and can still re-bill an order and book the payment against it',
          (await canWrite('orders/pendingWeb/staffside/billedAt', 'cashier', Date.now())) &&
          (await canWrite('orders/pendingWeb/staffside/upiId', 'cashier', 'ila@okyesbank')) &&
          (await canWrite('orders/pendingWeb/staffside/payment', 'cashier',
                          { ref: '512345678901', amount: 250, at: Date.now(), payId: 'web_tk1', bankTag: 'yes 8020' })));
    note('the shape is checked on creation, so nothing already recorded has to satisfy it');

    // A prepaid order is not made until its money is confirmed, and when the bank is
    // slow the only thing that releases it is a person saying they can see it. Both
    // screens that can say so have to be able to write it — the counter, and the
    // owner's phone — or the kitchen stops with no way to start it again.
    check('and either screen can record that the money was seen by hand',
          (await canWrite('orders/pendingWeb/staffside/manualPaid', 'cashier',
                          { by: 'Priya', at: Date.now(), via: 'pos' })) &&
          (await canWrite('orders/pendingWeb/staffside/manualPaid', 'admin',
                          { by: 'Sraveen', at: Date.now(), via: 'admin' })));
    check('but not without saying who, which is the whole of what it records',
          !(await canWrite('orders/pendingWeb/staffside/manualPaid', 'cashier', { at: Date.now(), via: 'pos' })) &&
          !(await canWrite('orders/pendingWeb/staffside/manualPaid', 'cashier', { by: '', at: Date.now() })) &&
          !(await canWrite('orders/pendingWeb/staffside/manualPaid', 'cashier', true)));
  }

  // ------------------------------------------- one order, not the whole history
  //
  // orders/track was world-readable as a NODE, because a customer scanning a table QR
  // queried it by `table` and a query needs read on what it queries. That handed
  // anyone the café's entire order history in one request — items, table and time,
  // going back as far as the café does, on a node nothing prunes.
  //
  // The lookup moved to orders/tableIndex: trackIds and timestamps, readable one
  // table at a time. A stranger can still ask what is on table four and read those
  // orders — which is what someone standing in the café can see — and the Worker
  // prunes the index hourly so that is all they can ask for. What they cannot do any
  // more is take the lot.
  {
    await call('PUT', 'orders/track/pub1', OWNER, SAMPLES['orders/track/$key']);
    await call('PUT', 'orders/tableIndex/Table 4/pub1', OWNER, 1756200000000);

    check('a customer can read their own order by its id',
          await canRead('orders/track/pub1', 'nobody'));
    check('and find it from the table they are sitting at',
          await canRead('orders/tableIndex/Table 4', 'nobody'));
    check('but cannot list every order the café has taken',
          !(await canRead('orders/track', 'nobody')) && !(await canRead('orders/track', 'anon')),
          'the node itself is no longer readable');
    note('that read was one request for every order ever, on a node nothing prunes');
    check('nor take every trackId at once from the index',
          !(await canRead('orders/tableIndex', 'nobody')) && !(await canRead('orders/tableIndex', 'anon')),
          'a trackId is what reads the record behind it');
    note('public at the top would be the same leak rebuilt one level up');

    check('the owner can still read the node whole for the accuracy report',
          await canRead('orders/track', 'admin'));
    check('and the Worker can read the index whole to prune it, and delete from it',
          (await canRead('orders/tableIndex', 'robot')) &&
          (await call('DELETE', 'orders/tableIndex/Table 4/pub1', 'robot')) === 200);
    check('a customer can add their own order to the index but not touch another',
          (await canWrite('orders/tableIndex/Table 4/mine', 'anon', 1756200000000)) &&
          !(await canWrite('orders/tableIndex/Table 4/mine', 'anon', 1756200000001)));
    check('and cannot put anything but a timestamp in it',
          !(await canWrite('orders/tableIndex/Table 4/junk', 'anon', { items: 'lots' })));
  }

  // ------------------------------------------------------- the public surface
  //
  // README names this list and the offline suite holds it. Here it is the database
  // answering, which is a different question from what the file says.
  {
    const PUBLIC = ['menu', 'settings', 'eta/model', 'eta/live',
                    'orders/track/someoneElse', 'orders/tableIndex/Table 4'];
    const shut = [];
    for (const p of PUBLIC) if (!(await canRead(p, 'nobody'))) shut.push(p);
    check('exactly the documented public surface is readable by a stranger',
          shut.length === 0, 'closed: ' + shut.join(', '));

    // and nothing above or beside it
    const NOT_PUBLIC = ['eta', 'orders', 'eta/recalMeta', 'eta/modelPrevious', 'ops', 'payments',
                        'orders/track', 'orders/tableIndex'];
    const open = [];
    for (const p of NOT_PUBLIC) if (await canRead(p, 'nobody')) open.push(p);
    check('and nothing above or beside it is', open.length === 0, 'open: ' + open.join(', '));
    note('rules cascade: a .read on a parent grants everything beneath it');
  }

  // ------------------------------------------ the requests the deploy probe makes
  //
  // The section above asks the right questions with paths written by hand here.
  // tools/probe-rules.js asks them again after a deploy, against the live database
  // — but with paths it derives from the rules file itself, and nothing anywhere
  // ran those. So a rules change that was entirely correct could still hand the
  // probe a request it could not make, and the first place that showed up was
  // production: `orders/track/$trackId` went out verbatim, `$` is not a character
  // Firebase accepts in a key, and the 400 rolled back a good deploy.
  //
  // These are the probe's exact requests, answered by a real database before one
  // is deployed anywhere.
  {
    const probe = require('../tools/probe-rules.js');
    const open = probe.publicPaths(probe.readRules());
    const denied = probe.MUST_BE_DENIED.concat(
      probe.ancestorsOf(open).filter(x => !probe.MUST_BE_DENIED.includes(x))
    );

    const wrong = [];
    for (const p of open) {
      const code = await call('GET', probe.toDbPath(p), 'nobody');
      if (code !== 200) wrong.push(p + ' -> ' + probe.toDbPath(p) + ' answered ' + code);
    }
    check('every path the deploy probe calls public answers 200 to a stranger',
          wrong.length === 0, wrong.join('; '));
    note('a 400 here is not a denial — it is a question Firebase could not read,');
    note('and the probe rightly refuses to score it either way');

    const leaked = [], unclear = [];
    for (const p of denied) {
      const code = await call('GET', probe.toDbPath(p), 'nobody');
      if (code === 200) leaked.push(p || '(root)');
      else if (code !== 401 && code !== 403) unclear.push((p || '(root)') + ' answered ' + code);
    }
    check('and every path it calls private is refused', leaked.length === 0, leaked.join(', '));
    check('with a status the probe reads as a refusal', unclear.length === 0, unclear.join('; '));
    note('the probe accepts 401 and 403 and nothing else; anything else it reports');
  }

  done();
})();
