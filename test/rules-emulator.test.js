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

const { derivePaths, suite } = require('./helpers');

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
    total: 250, paymentMethod: 'UPI', upiId: null, phone: '9990001111', gated: false,
    trackId: 'tk1', createdAt: 1756200000000
  },
  'payments/incoming/$key': { amount: 250, ref: '512345678901', at: 1756200000000, bank: 'yes', acct: '8020' },
  'orders/track/$key': {
    status: 'received', items: { Latte: { qty: 1, price: 250 } }, table: 'Table 4',
    gated: false, createdAt: 1756200000000
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
      '':                  [],                                    // the root, to anyone
      'staff':             ['cashier', 'barista', 'chef', 'inventory', 'admin'],
      'users':             ['admin'],
      'pos':               ['cashier', 'barista', 'chef', 'inventory', 'admin'],
      'pos/ledgerEntries': ['cashier', 'barista', 'chef', 'inventory', 'admin', 'robot'],
      'pos/eodArchive':    ['cashier', 'barista', 'chef', 'inventory', 'admin', 'robot'],
      'orders/history':    ['admin'],
      'orders/pendingWeb': ['cashier', 'barista', 'chef', 'inventory', 'admin'],
      'payments':          ['cashier', 'barista', 'chef', 'inventory', 'admin'],
      'payments/incoming': ['cashier', 'barista', 'chef', 'inventory', 'admin'],
      'security':          ['admin'],
      'customers':         ['cashier', 'barista', 'chef', 'inventory', 'admin'],
      'inventory':         ['cashier', 'barista', 'chef', 'inventory', 'admin'],
      'reconciliation':    ['admin'],
      'monitor':           ['admin', 'robot'],
      'upiReview':         ['cashier', 'barista', 'chef', 'inventory', 'admin', 'robot'],
      'upiRouting':        ['cashier', 'barista', 'chef', 'inventory', 'admin'],
      'pushSubscriptions': ['cashier', 'barista', 'chef', 'inventory', 'admin', 'robot'],
      'ops/cronFailure':   ['admin', 'robot'],
      'ops/pushHealth':    ['cashier', 'barista', 'chef', 'inventory', 'admin', 'robot'],
      'eta/recalMeta':     ['admin', 'robot'],
      'eta/modelPrevious': ['admin', 'robot'],
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

    // The two rows above that are wider than the café needs. Named, so they are a
    // decision rather than an oversight — and so that closing one fails the table
    // above and brings someone back here.
    check('the bar and the kitchen can still read the till ledger',
          (await canRead('pos/ledgerEntries', 'barista')) && (await canRead('pos/ledgerEntries', 'chef')));
    note('pos grants .read to any role and rules cannot be revoked lower down, so the');
    note('ledger, the bills and the drawer come with it. Closing it means splitting pos');
    note('and gating the ledger on the role VALUE — which depends on what the café’s own');
    note('accounts hold, since every page except admin lets any role in.');

    check('every role can still read the staff PIN hashes',
          (await canRead('staff', 'barista')) && (await canRead('staff', 'chef')));
    note('docs/database-access.md: the salt is a literal in the page, so any staff');
    note('account recovers every PIN in under a second. Restricting the read is not the');
    note('fix — the PIN is checked in a browser — but it is the easiest attack.');

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
      ['robot', 'pos/ledgerEntries/x1', 'a ledger line, by the robot'],
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
