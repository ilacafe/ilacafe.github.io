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

const { derivePaths, deriveWorkerPaths, suite } = require('./helpers');

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
  'orders/pendingWeb/$key': {
    orderType: 'Takeaway', tableOrAddress: 'Takeaway', notes: '', items: { Latte: { qty: 1, price: 250 } },
    total: 250, paymentMethod: 'UPI', phone: '9990001111', gated: false,
    trackId: 'tk1', createdAt: { '.sv': 'timestamp' }
  },
  'payments/incoming/$key': { amount: 250, ref: '512345678901', at: 1756200000000, bank: 'yes', acct: '8020' },
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

  // ---------------------------------------------------------------- coverage
  {
    const used = derivePaths();
    const denied = [];
    let asked = 0;
    let probe = 0;

    for (const [path, use] of used) {
      if (path.includes('${')) continue;                 // a template segment; its literal sibling covers it
      const at = (role, op) => path.replace(/\$key/g, KEY_FOR[path] ? KEY_FOR[path](role, op) : 'probeKey');
      for (const role of use.read) {
        if (!WHO[role]) continue;
        asked++;
        if (!(await canRead(at(role, 'read'), role))) denied.push(role + ' cannot READ ' + path);
      }
      for (const role of use.write) {
        if (!WHO[role]) continue;
        asked++;
        const sample = SAMPLES[path];
        // A path with a .validate is written with a real payload; anything else gets a
        // throwaway child, which walks the same permission chain without clobbering the node.
        const ok = sample
          ? await canWrite(at(role, 'write'), role, sample)
          : await canWrite(path.endsWith('$key') ? at(role, 'write')
                                                 : at(role, 'write') + '/__probe' + (++probe), role);
        if (!ok) denied.push(role + ' cannot WRITE ' + path);
      }
    }

    check('every path an app uses is permitted to the app that uses it',
          denied.length === 0, denied.slice(0, 6).join('; '));
    note(asked + ' role-and-path questions, derived from the access map');
    note('this is the half that makes tightening a rule safe — a locked-out till fails here');
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
      'pos/unverified':      ['cashier', 'admin'],
      'pos/eodArchive':      ['admin', 'robot'],
      'orders/history':      ['admin'],
      'orders/pendingWeb':   ['cashier', 'barista', 'chef', 'inventory', 'admin'],
      'payments':            ['cashier', 'barista', 'chef', 'inventory', 'admin'],
      'payments/incoming':   ['cashier', 'barista', 'chef', 'inventory', 'admin'],
      'security':            ['admin'],
      'customers':           ['cashier', 'barista', 'chef', 'inventory', 'admin'],
      'inventory':           ['cashier', 'barista', 'chef', 'inventory', 'admin'],
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
    check('the bar and the kitchen cannot read the till ledger',
          !(await canRead('pos/ledgerEntries', 'barista')) && !(await canRead('pos/ledgerEntries', 'chef')));
    check('but the counter still can, and so does the owner',
          (await canRead('pos/ledgerEntries', 'cashier')) && (await canRead('pos/ledgerEntries', 'admin')));
    note('the Worker reads it too — that is the hourly report of cash leaving the drawer');

    check('a cashier cannot read the cash-up archive',
          !(await canRead('pos/eodArchive', 'cashier')));
    check('but can still write the day into it',
          await canWrite('pos/eodArchive/2026-08-26-1', 'cashier'));
    note('the till closes the day; reading the archive back is analytics, which is the owner’s');

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
    // It is the only writer of a cash-out, and that is all it may reach in here: the
    // grant sits on the two children it needs, not on pos, which still says "has a
    // staff role" — and the robot has none.
    const robotReach = [];
    for (const p of ['pos/bills/x1', 'pos/activeTables/x1', 'pos/eodArchive/x1',
                     'pos/unverified/x1', 'pos/upiTotal', 'pos/tips/x1']) {
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

    const rejected = [];
    const must = async (what, node, mutate) => {
      if (await asAnon(node, mutate)) rejected.push(what);
    };
    await must('a field nobody wrote', 'track', (o) => { o.payload = 'x'; });
    await must('a field nobody wrote, on an order', 'web', (o) => { o.payload = 'x'; });
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
    check('and can send a pay link and book the payment against the order',
          (await canWrite('orders/pendingWeb/staffside/payLinkSentAt', 'cashier', Date.now())) &&
          (await canWrite('orders/pendingWeb/staffside/upiId', 'cashier', 'ila@okyesbank')) &&
          (await canWrite('orders/pendingWeb/staffside/payment', 'cashier',
                          { ref: '512345678901', amount: 250, at: Date.now(), payId: 'web_tk1', bankTag: 'yes 8020' })));
    note('the shape is checked on creation, so nothing already recorded has to satisfy it');
  }

  // ------------------------------------------------------- the public surface
  //
  // README names this list and the offline suite holds it. Here it is the database
  // answering, which is a different question from what the file says.
  {
    const PUBLIC = ['menu', 'settings', 'eta/model', 'eta/live', 'orders/track'];
    const shut = [];
    for (const p of PUBLIC) if (!(await canRead(p, 'nobody'))) shut.push(p);
    check('exactly the documented public surface is readable by a stranger',
          shut.length === 0, 'closed: ' + shut.join(', '));

    // and nothing above or beside it
    const NOT_PUBLIC = ['eta', 'orders', 'eta/recalMeta', 'eta/modelPrevious', 'ops', 'payments'];
    const open = [];
    for (const p of NOT_PUBLIC) if (await canRead(p, 'nobody')) open.push(p);
    check('and nothing above or beside it is', open.length === 0, 'open: ' + open.join(', '));
    note('rules cascade: a .read on a parent grants everything beneath it');
  }

  done();
})();
