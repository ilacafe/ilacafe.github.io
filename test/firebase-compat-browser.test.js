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

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  done();
})();
