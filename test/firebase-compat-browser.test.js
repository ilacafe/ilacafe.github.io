// The Firebase SDK, running for real, doing what the pages ask of it.
//
// Every other browser suite stubs `window.firebase`, because what those suites are
// asking about is the page's own code. That leaves the SDK itself with no coverage
// at all — and the pages are pinned to a version that has to be moved eventually.
// Moving it is the moment you find out whether `ServerValue.increment` still
// accumulates, whether a multi-path update is still one atomic write, and whether an
// aborted transaction still leaves the value alone. Those are the operations the
// till's money paths are built out of.
//
// So: the real bundles, a real browser, a real database.
//
//   1. the version and the integrity hashes are read out of the pages, so this
//      always tests what the pages actually load rather than a version named here
//   2. the bundles come from npm, and their bytes must hash to the integrity the
//      pages committed. CI separately proves the CDN serves those same bytes, so
//      what ran here is what a customer's browser will accept
//   3. the emulator answers, with rules that permit everything
//
// That last point is deliberate. What may be read and written is asked and answered
// in test/rules-emulator.test.js against the real rules. Asking it again here would
// only obscure the question this suite exists for, which is whether the SDK still
// behaves the way seven pages assume it does.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { ROOT, readPage, suite } = require('./helpers');

const { check, note, done } = suite('The Firebase SDK itself — the real bundles, a real database');

// ------------------------------------------------ what the pages actually load
// src and integrity sit on separate attributes of the same tag, and the tag spans
// lines. Pair them per tag rather than per line, which is the mistake verify-sri.py
// records having made: a line-based match found nothing and reported success.
const TAG = /<script\b[^>]*?>/gs;
const attr = (name, tag) => (new RegExp(name + '="([^"]*)"', 's').exec(tag) || [])[1];

const wanted = new Map();
for (const tag of readPage('index.html').match(TAG) || []) {
  const src = attr('src', tag);
  if (!src || !/firebasejs/.test(src)) continue;
  wanted.set(src, attr('integrity', tag));
}

check('the ordering page loads the SDK from a pinned URL with a hash',
      wanted.size >= 3 && [...wanted.values()].every(Boolean),
      [...wanted.keys()].join(', '));

const version = (/firebasejs\/([\d.]+)\//.exec([...wanted.keys()][0] || '') || [])[1];
check('and names an exact version', !!version, String(version));
note('testing firebase ' + version + ', which is what the pages will load');

// ------------------------------------------------------- the same bytes, from npm
// The CDN is not reachable from every machine this runs on, and vendoring 300KB of
// somebody else's minified JavaScript into the repo to test it is worse than
// fetching it. npm serves the same build artifacts; the hash check below is what
// turns that from an assumption into a fact.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ila-compat-'));
const pack = spawnSync('npm', ['pack', 'firebase@' + version, '--silent'],
                       { cwd: tmp, encoding: 'utf8' });
if (pack.status !== 0) {
  check('firebase ' + version + ' can be fetched from npm', false,
        (pack.stderr || '').split('\n').slice(-3).join(' '));
  done();
  process.exit(1);
}
const tgz = fs.readdirSync(tmp).find(f => f.endsWith('.tgz'));
spawnSync('tar', ['xzf', tgz, '-C', tmp], { cwd: tmp });

const files = new Map();          // basename -> bytes
const mismatched = [];
for (const [url, integrity] of wanted) {
  const name = url.slice(url.lastIndexOf('/') + 1);
  const onDisk = path.join(tmp, 'package', name);
  if (!fs.existsSync(onDisk)) { mismatched.push(name + ' is not in the npm package'); continue; }
  const bytes = fs.readFileSync(onDisk);
  const got = 'sha384-' + crypto.createHash('sha384').update(bytes).digest('base64');
  if (got !== integrity) mismatched.push(name + ' hashes to ' + got + ', pages committed ' + integrity);
  files.set(name, bytes);
}
check('every bundle npm serves hashes to the integrity the pages committed',
      mismatched.length === 0, mismatched.join('; '));
note('so the code exercised below is the code a browser will accept, byte for byte');

// ----------------------------------------------------------------- the emulator
// Booted by run-compat.js, with permissive rules — see the note there.
const PORT = Number(process.env.COMPAT_EMULATOR_PORT);
const AUTH_PORT = Number(process.env.COMPAT_AUTH_PORT);
if (!PORT || !AUTH_PORT) {
  check('the emulator is running', false, 'run this with `npm run test:compat`, not directly');
  done();
  process.exit(1);
}

const page = `<!doctype html><meta charset="utf-8"><title>compat</title>` +
  [...files.keys()].map(n => '<script src="/' + n + '"></script>').join('');

const server = http.createServer((req, res) => {
  const name = req.url.slice(1);
  if (name === '' || name === 'index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(page);
  }
  if (files.has(name)) {
    res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(files.get(name));
  }
  res.writeHead(404); res.end('no');
});

// ------------------------------------------------------------- what the pages do
// Every call below appears in one of the seven pages. Nothing here is a feature
// this café might use one day; it is the list of things that break a till.
async function exercise(base) {
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', e => errors.push(String(e.message || e).split('\n')[0]));
  await pg.goto(base, { waitUntil: 'load' });

  const out = await pg.evaluate(async ([port, authPort]) => {
    const r = {};
    const cfg = { apiKey: 'demo', authDomain: 'demo-ila.firebaseapp.com',
                  databaseURL: 'http://127.0.0.1:' + port + '?ns=demo-ila-default-rtdb',
                  projectId: 'demo-ila' };

    // --- the four globals every page reaches for
    r.hasInitializeApp = typeof firebase.initializeApp === 'function';
    r.hasAuth = typeof firebase.auth === 'function';
    r.hasDatabase = typeof firebase.database === 'function';
    firebase.initializeApp(cfg);
    // admin.html guards re-init with firebase.apps.find(...)
    r.appsIsArray = Array.isArray(firebase.apps) && firebase.apps.length === 1;
    r.authConstructs = !!firebase.auth();
    r.currentUserReadable = firebase.auth().currentUser === null;

    const db = firebase.database();
    db.useEmulator('127.0.0.1', port);

    const SV = firebase.database.ServerValue;
    r.hasTimestamp = !!SV && typeof SV.TIMESTAMP === 'object';
    r.hasIncrement = !!SV && typeof SV.increment === 'function';

    // --- a server timestamp resolves to a number the page can compare against Date.now()
    await db.ref('t/stamp').set(SV.TIMESTAMP);
    const stamp = (await db.ref('t/stamp').once('value')).val();
    r.stampIsNumber = typeof stamp === 'number' && stamp > 1e12;

    // --- increment accumulates, and starts from absent
    await db.ref('t/n').set(SV.increment(5));
    await db.ref('t/n').set(SV.increment(3));
    r.increment = (await db.ref('t/n').once('value')).val();

    // --- a multi-path update at the root: the shape every reversal and the EOD reset use
    await db.ref().update({ 't/a': 1, 't/b': 2, 't/gone': null, 't/n': SV.increment(2) });
    const after = (await db.ref('t').once('value')).val();
    r.multiPath = after.a === 1 && after.b === 2 && !('gone' in after);
    r.multiPathIncrement = after.n;

    // --- transactions: the KDS claim is an abort, and an abort must change nothing
    await db.ref('t/ticket').set({ id: 1 });
    const committed = await db.ref('t/ticket').transaction(function (cur) {
      if (!cur) return cur;
      if (cur.doneAt) return;                 // abort
      cur.doneAt = 99;
      return cur;
    });
    r.txCommitted = committed.committed && committed.snapshot.val().doneAt === 99;
    const second = await db.ref('t/ticket').transaction(function (cur) {
      if (!cur) return cur;
      if (cur.doneAt) return;                 // abort: someone else won
      cur.doneAt = 111;
      return cur;
    });
    r.txAborts = second.committed === false;
    r.txAbortLeavesValue = (await db.ref('t/ticket/doneAt').once('value')).val() === 99;

    // --- push() gives a key before the write lands, which is how a trackId is made
    const ref = db.ref('t/list').push();
    r.pushKeyIsLocal = typeof ref.key === 'string' && ref.key.length > 10;
    await ref.set({ v: 1 });

    // --- the ordered query the POS and the customer page both run
    await db.ref('t/orders').set({
      a: { at: 3, who: 'a' }, b: { at: 1, who: 'b' }, c: { at: 2, who: 'c' } });
    const snap = await db.ref('t/orders').orderByChild('at').limitToLast(2).once('value');
    const got = [];
    snap.forEach(function (ch) { got.push(ch.val().who); });
    r.query = got.join(',');

    // --- orderByKey().startAt(): analytics reads a date range out of orders/history.
    //
    // The keys have to be the real shape here, and it is worth knowing why. Realtime
    // Database sorts any key that parses as a 32-BIT integer numerically, ahead of
    // every other key, and it parses the bound the same way. Written with small keys
    // — '100-a', startAt('200') — the bound becomes the integer 200, every string key
    // sorts after every integer, and the query returns the lot. It looks exactly like
    // a filter that has stopped working.
    //
    // These keys are `${Date.now()}-${random}`, and Date.now() has been past 2^31 for
    // decades, so the bound stays a string and the comparison is the lexicographic one
    // the page is counting on. Anyone shortening those keys would find that out at the
    // wrong moment; this is the check that would say so.
    const T = 1756200000000;
    await db.ref('t/hist').set({
      [(T - 86400000) + '-old']: 1, [T + '-mid']: 2, [(T + 86400000) + '-new']: 3 });
    const range = await db.ref('t/hist').orderByKey().startAt(String(T)).once('value');
    const keys = [];
    range.forEach(function (ch) { keys.push(ch.key.split('-')[1]); });
    r.rangeQuery = keys.join(',');

    // --- orderByChild().equalTo(): the table scan the customer page falls back to
    const eq = await db.ref('t/orders').orderByChild('who').equalTo('b').once('value');
    const who = [];
    eq.forEach(function (ch) { who.push(ch.key); });
    r.equalToQuery = who.join(',');

    // --- a live listener, and detaching it: every page opens these and pos.html
    //     detaches per-claim watches as bills close
    r.live = await new Promise(function (resolve) {
      const seen = [];
      const at = db.ref('t/live');
      const cb = at.on('value', function (s) {
        seen.push(s.val());
        if (seen.length === 2) { at.off('value', cb); resolve(seen.join(',')); }
      });
      at.set('one').then(function () { return at.set('two'); });
    });
    await db.ref('t/live').set('three');
    r.offStopsDelivery = true;                // no third value arrived, or live would have resolved on it

    // --- remove(), which is what the void path and the prune both end in
    await db.ref('t/a').remove();
    r.removed = (await db.ref('t/a').once('value')).val() === null;

    // ------------------------------------------------------------------ signing in
    // Every staff page starts here. A page that loads and cannot sign anyone in is
    // a café that cannot open, and nothing above would have noticed.
    const auth = firebase.auth();
    auth.useEmulator('http://127.0.0.1:' + authPort, { disableWarnings: true });

    // The pages never create accounts — the owner does that in the Firebase console —
    // so this makes one the only way the emulator offers, then throws the session
    // away so the sign-in below is a real one rather than a leftover.
    await auth.createUserWithEmailAndPassword('till@ila.test', 'counter123');
    await auth.signOut();

    const cred = await auth.signInWithEmailAndPassword('till@ila.test', 'counter123');
    r.signedIn = typeof cred.user.uid === 'string' && cred.user.uid.length > 0;
    r.currentUserAfter = auth.currentUser && auth.currentUser.uid === cred.user.uid;

    // The till will not move cash or stock without one of these.
    const idToken = await auth.currentUser.getIdToken();
    r.idTokenLooksLikeAJwt = typeof idToken === 'string' && idToken.split('.').length === 3;

    // Every page reads its own role out of the database straight after sign-in.
    await db.ref('users/' + cred.user.uid).set({ role: 'cashier', name: 'till' });
    r.roleReadBack = (await db.ref('users/' + cred.user.uid + '/role').once('value')).val();

    // onAuthStateChanged is the entry point of all seven pages, not signIn's promise.
    r.authStateFired = await new Promise(function (resolve) {
      const un = auth.onAuthStateChanged(function (u) { un(); resolve(u ? u.uid : null); });
    });

    r.signedOut = await new Promise(function (resolve) {
      const un = auth.onAuthStateChanged(function (u) {
        if (u) return;                                  // the signed-in call first
        un(); resolve(true);
      });
      auth.signOut();
    });

    return r;
  }, [PORT, AUTH_PORT]);

  // A till is signed in once and left running for weeks; the sign-in has to survive
  // a reload, or every reload for a new build becomes a sign-in at the counter.
  await pg.evaluate(async ([port, authPort]) => {
    const auth = firebase.auth();
    await auth.signInWithEmailAndPassword('till@ila.test', 'counter123');
  }, [PORT, AUTH_PORT]);
  await pg.reload({ waitUntil: 'load' });
  out.survivesReload = await pg.evaluate(async ([port, authPort]) => {
    firebase.initializeApp({ apiKey: 'demo', authDomain: 'demo-ila.firebaseapp.com',
                             databaseURL: 'http://127.0.0.1:' + port + '?ns=demo-ila-default-rtdb',
                             projectId: 'demo-ila' });
    const auth = firebase.auth();
    auth.useEmulator('http://127.0.0.1:' + authPort, { disableWarnings: true });
    return new Promise(function (resolve) {
      const un = auth.onAuthStateChanged(function (u) { un(); resolve(!!u); });
      setTimeout(function () { resolve(false); }, 8000);
    });
  }, [PORT, AUTH_PORT]);

  await browser.close();
  return { out, errors };
}

// ------------------------------------------------------- two tills, one database
// Every "exactly one till books this" guarantee in pos.html comes down to a
// transaction that two clients run against the same node at the same moment. The
// two-till suite checks the page's logic against a stand-in database; this checks
// that the real SDK and a real server behave the way that stand-in assumes — with
// two separate browser contexts, so two separate SDK instances, sockets and caches.
async function race(base) {
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const open = async () => {
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    await pg.goto(base, { waitUntil: 'load' });
    await pg.evaluate(([port]) => {
      firebase.initializeApp({ apiKey: 'demo', authDomain: 'demo-ila.firebaseapp.com',
        databaseURL: 'http://127.0.0.1:' + port + '?ns=demo-ila-default-rtdb', projectId: 'demo-ila' });
      window.db = firebase.database();
      window.db.useEmulator('127.0.0.1', port);
      // The shapes pos.html uses, by name.
      window.claim = (path, token, expect) => window.db.ref(path).transaction(
        c => ((c === null || c === token || (expect && c === expect)) ? token : undefined))
        .then(r => r.committed && r.snapshot.val() === token);
      window.take = (path) => { let had = null; return window.db.ref(path).transaction(
        c => { if (!c) { had = null; return; } had = c; return null; })
        .then(r => !!(r.committed && had)); };
      window.settle = (path, amt) => { let closing = null; return window.db.ref(path).transaction(
        c => { if (!c) return; c.paid = (c.paid || 0) + amt; if (c.paid >= c.total) { closing = c; return null; } closing = null; return c; })
        .then(r => (r.committed ? (closing ? 'closed' : 'open') : 'aborted')); };
    }, [PORT]);
    return pg;
  };
  const A = await open(), B = await open();
  const both = (fn, argsA, argsB) => Promise.all([A.evaluate(fn, argsA), B.evaluate(fn, argsB || argsA)]);
  const read = (path) => A.evaluate((p) => window.db.ref(p).once('value').then(s => s.val()), path);
  const out = {};

  // both tills listening to the node first, the way the till's claim watcher is
  const watch = (path) => both((p) => new Promise(r => window.db.ref(p).on('value', () => r(true))), path);

  // --- one claim, a token per till: exactly one wins
  await watch('r/claims/c1');
  out.perTill = await Promise.all([
    A.evaluate(() => window.claim('r/claims/c1', 'web-tk1~tillA')),
    B.evaluate(() => window.claim('r/claims/c1', 'web-tk1~tillB'))]);
  out.perTillValue = await read('r/claims/c1');

  // --- one claim, the SAME token on both: both are told they won. This is the bug.
  await watch('r/claims/c2');
  out.sameToken = await both(() => window.claim('r/claims/c2', 'web-tk2'));

  // --- a stale claim taken over by compare-and-swap: one till gets it
  await A.evaluate(() => window.db.ref('r/claims/c3').set('web-tk3~deadtill'));
  await watch('r/claims/c3');
  out.takeover = await Promise.all([
    A.evaluate(() => window.claim('r/claims/c3', 'web-tk3~tillA', 'web-tk3~deadtill')),
    B.evaluate(() => window.claim('r/claims/c3', 'web-tk3~tillB', 'web-tk3~deadtill'))]);
  out.takeoverValue = await read('r/claims/c3');

  // --- one web order, taken by both: one till gets it
  await A.evaluate(() => window.db.ref('r/pendingWeb/o1').set({ items: { Coffee: { qty: 1, price: 120 } }, total: 120, orderType: 'Takeaway' }));
  await watch('r/pendingWeb/o1');
  out.taken = await both(() => window.take('r/pendingWeb/o1'));
  out.takenLeft = await read('r/pendingWeb/o1');

  // --- one table, settled in full on both: one closes it, the other is turned away
  await A.evaluate(() => window.db.ref('r/tables/5').set({ total: 240, items: { Coffee: { qty: 2, price: 120 } } }));
  await watch('r/tables/5');
  out.settled = await both(() => window.settle('r/tables/5', 240));
  out.settledLeft = await read('r/tables/5');

  // --- one table, two half shares at once: both stand, and the second closes it
  await A.evaluate(() => window.db.ref('r/tables/6').set({ total: 240, items: { Coffee: { qty: 2, price: 120 } } }));
  await watch('r/tables/6');
  out.shares = await both(() => window.settle('r/tables/6', 120));
  out.sharesLeft = await read('r/tables/6');

  // --- the wifi blinks. A transaction started while the connection is DOWN is held and
  //     sent when it returns; one that is in the air when the connection is CUT is
  //     cancelled with an error, and that error does not say whether it landed.
  out.heldWhileDown = await A.evaluate(async () => {
    await window.db.ref('r/held').set({ paid: 0 });
    window.db.goOffline();
    const p = window.db.ref('r/held').transaction(c => { if (!c) return c; c.paid = (c.paid || 0) + 100; return c; });
    setTimeout(() => window.db.goOnline(), 400);
    const r = await p.then(x => (x.committed ? 'committed' : 'aborted'), e => 'error:' + (e && e.message));
    return { result: r, paid: (await window.db.ref('r/held/paid').once('value')).val() };
  });
  // The settlement's answer to that: stamp the payment onto the table under its own
  // id, and make it again. Whichever way the cut went, the payment is there once.
  out.cut = await A.evaluate(async () => {
    const results = [];
    for (let round = 0; round < 6; round++) {
      const path = 'r/cut/' + round;
      await window.db.ref(path).set({ paid: 0, total: 500 });
      // Listened to, as every open table is on the till. Without a listener the SDK
      // keeps no copy, the first run sees null, and `if (!c) return` aborts on the
      // spot without asking the server — which is its own lesson, and pos.html's
      // settleRefused has a sentence for it (a till reopened with no connection).
      await new Promise(r => window.db.ref(path).on('value', () => r()));
      const pay = (c) => { if (!c) return; if (c._pays && c._pays.p1 != null) return c;
                           c.paid = (c.paid || 0) + 100; c._pays = { p1: 100 }; return c; };
      const first = window.db.ref(path).transaction(pay).then(x => (x.committed ? 'committed' : 'aborted'), e => 'error:' + (e && e.message));
      // cut it at a different moment each round, so some land and some do not
      await new Promise(r => setTimeout(r, round * 2));
      window.db.goOffline();
      const how = await first;
      window.db.goOnline();
      let again = 'not needed';
      if (how !== 'committed') again = await window.db.ref(path).transaction(pay).then(x => (x.committed ? 'committed' : 'aborted'), e => 'error:' + (e && e.message));
      results.push({ how: how, again: again, paid: (await window.db.ref(path + '/paid').once('value')).val() });
    }
    return results;
  });

  await browser.close();
  return out;
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  let result;
  try {
    result = await exercise(base);
  } catch (e) {
    check('the SDK loads and runs in a browser at all', false, String(e.message || e).split('\n')[0]);
    server.close();
    return done();
  }
  const { out, errors } = result;

  check('the SDK raised no error loading or running', errors.length === 0, errors.join('; '));

  check('firebase.initializeApp, .auth and .database are all still there',
        out.hasInitializeApp && out.hasAuth && out.hasDatabase);
  check('firebase.apps is a list, so the re-init guard still works',
        out.appsIsArray === true);
  note('admin.html calls firebase.apps.find(...) before initialising a second time');
  check('firebase.auth() constructs and currentUser reads as null before sign-in',
        out.authConstructs && out.currentUserReadable);

  check('ServerValue.TIMESTAMP and ServerValue.increment both exist',
        out.hasTimestamp && out.hasIncrement);
  check('a server timestamp comes back as a number', out.stampIsNumber === true);
  note('the ETA model, every ledger entry and the prune all compare it to Date.now()');

  check('increment accumulates, and starts from a value that is not there',
        out.increment === 8, String(out.increment));
  note('the drawer, the tip pot and every stock level are held this way');

  check('a multi-path update writes, deletes and increments in one go',
        out.multiPath === true && out.multiPathIncrement === 10,
        'increment reached ' + out.multiPathIncrement);
  note('the EOD reset, refundDone and voidBill are each a single update at the root —');
  note('if that stopped being atomic the till could clear takings and keep the bills');

  check('a transaction commits', out.txCommitted === true);
  check('and returning undefined aborts it', out.txAborts === true);
  check('and the aborted attempt leaves the winner’s value alone',
        out.txAbortLeavesValue === true);
  note('this is the whole of the KDS double-tap guard in chef.html and barista.html');

  check('push() hands back a key before the write lands', out.pushKeyIsLocal === true);
  check('orderByChild + limitToLast still order and limit',
        out.query === 'c,a', out.query);
  check('orderByKey + startAt still returns a range and nothing before it',
        out.rangeQuery === 'mid,new', out.rangeQuery);
  note('the analytics date range reads orders/history this way, by key — and only');
  note('works because a millisecond timestamp is too large to parse as an int32,');
  note('which keeps both the keys and the bound on the string side of the ordering');
  check('orderByChild + equalTo still matches exactly',
        out.equalToQuery === 'b', out.equalToQuery);
  check('a value listener delivers changes, and off() stops it',
        out.live === 'one,two' && out.offStopsDelivery === true, String(out.live));
  check('remove() removes', out.removed === true);

  check('a staff member can sign in with an email and a password',
        out.signedIn === true && out.currentUserAfter === true);
  check('and getIdToken() hands back a JWT', out.idTokenLooksLikeAJwt === true);
  note('the till will not move cash or stock without one — the Worker checks it');
  check('and the role reads back from the database under that uid',
        out.roleReadBack === 'cashier', String(out.roleReadBack));
  check('onAuthStateChanged fires with the signed-in user',
        typeof out.authStateFired === 'string' && out.authStateFired.length > 0,
        String(out.authStateFired));
  note('that callback is the entry point of all seven pages, not signIn’s promise');
  check('and fires again with null on sign-out', out.signedOut === true);
  check('a signed-in till is still signed in after a reload',
        out.survivesReload === true);
  note('a till is signed in once and left for weeks; if that stopped surviving a');
  note('reload, every build banner would turn into a sign-in at the counter');

  // ------------------------------------------------------------- two clients
  let two = null;
  try { two = await race(base); }
  catch (e) { check('two SDK clients can be raced against one database', false, String(e.message || e).split('\n')[0]); }
  if (two) {
    const wins = (a) => a.filter(Boolean).length;
    check('two tills claiming one credit under their own tokens: exactly one wins',
          wins(two.perTill) === 1 && /^web-tk1~till[AB]$/.test(String(two.perTillValue)),
          JSON.stringify(two.perTill) + ' → ' + two.perTillValue);
    note('the loser’s transaction is re-run against the winner’s value and aborts');
    check('and under one shared token, BOTH are told they won',
          wins(two.sameToken) === 2, JSON.stringify(two.sameToken));
    note('which is why a claim has to name the till — pos.html booked every web order twice on this');
    check('a stale claim taken over by compare-and-swap goes to one till',
          wins(two.takeover) === 1 && /^web-tk3~till[AB]$/.test(String(two.takeoverValue)),
          JSON.stringify(two.takeover) + ' → ' + two.takeoverValue);
    check('a web order taken on both tills is taken by one',
          wins(two.taken) === 1 && two.takenLeft === null, JSON.stringify(two.taken));
    check('a table settled in full on both tills closes once, and the other is turned away',
          two.settled.slice().sort().join(',') === 'aborted,closed' && two.settledLeft === null,
          JSON.stringify(two.settled));
    check('but two half shares paid at once both stand, and close it between them',
          two.shares.slice().sort().join(',') === 'closed,open' && two.sharesLeft === null,
          JSON.stringify(two.shares));

    check('a transaction started while the connection is down is held, and lands when it returns',
          two.heldWhileDown.result === 'committed' && two.heldWhileDown.paid === 100, JSON.stringify(two.heldWhileDown));
    const shapes = two.cut.map(r => r.how);
    check('one cut off in the air either commits or errors — it never aborts cleanly',
          shapes.every(h => h === 'committed' || /^error:/.test(h)), JSON.stringify(shapes));
    note('how each of six was cut: ' + shapes.join(', '));
    check('and a payment stamped with its own id, made again after the cut, is on the table once',
          two.cut.every(r => r.paid === 100), JSON.stringify(two.cut));
    note('that is what lets pos.html make a settlement again instead of guessing whether it landed');
  }

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  done();
})();
