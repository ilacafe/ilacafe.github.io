// The Worker is the one component that runs somewhere a customer's browser cannot
// reach, and the only holder of the credential that can write eta/model and
// payments/incoming. It lived solely in the Cloudflare dashboard — no diff, no
// review, no rollback — until it was committed here.
//
// Committing it creates a new hazard: GitHub Pages serves this repo raw
// (.nojekyll), so worker/worker.js is fetchable at https://ila.cafe/worker/worker.js.
// The first two checks below are what make that safe, and they have to keep being
// true, so they run on every push rather than being a thing someone remembers.

const fs = require('fs');
const path = require('path');
const { ROOT, readPage, extractFunction, buildModule, suite, stripComments } = require('./helpers');

const src  = readPage('worker/worker.js');
const toml = fs.readFileSync(path.join(ROOT, 'worker', 'wrangler.toml'), 'utf8');
const doc  = fs.readFileSync(path.join(ROOT, 'worker', 'README.md'), 'utf8');

const { check, note, done } = suite('Worker — secrets, auth routing and the recalibration gate');

main();
async function main() {

// ---------------------------------------------------------------- no secrets in source
// Deliberately pattern-based, never value-based: writing the real secrets into this
// file to compare against would commit the very thing it is checking for.
{
  // Matches any identifier CONTAINING a secret word, not just the exact names — a
  // \b-anchored list misses ROBOT_PASSWORD_OLD, which is exactly how a secret comes
  // back: pasted beside the real one while someone is rotating it.
  const SECRETISH = /\b([A-Z0-9_]*(?:PASSWORD|SECRET|PRIVATE|TOKEN|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*['"][^'"]{8,}['"]/g;
  const hits = src.match(SECRETISH) || [];
  check('no secret-named constant is assigned a literal in worker.js',
        hits.length === 0, hits.join(' | '));

  // Broader net: any string literal that simply looks like a credential — long,
  // no spaces, mixed case, digits. Catches a pasted key under an innocent name.
  const creds = [];
  for (const m of src.matchAll(/'([^'\\\n]{20,})'|"([^"\\\n]{20,})"/g)) {
    const v = m[1] || m[2];
    // A credential is an opaque token: base64url/hex and nothing else. Requiring the
    // whole value to be that charset also sidesteps a naive lexer's classic failure —
    // the text BETWEEN two literals ('a '+x+' b') otherwise scans as a literal itself.
    if (!/^[A-Za-z0-9_\-+/=]+$/.test(v)) continue;
    if (!/[a-z]/.test(v) || !/[A-Z]/.test(v) || !/[0-9]/.test(v)) continue;
    if (/^https?:/.test(v)) continue;
    creds.push(v.slice(0, 24) + (v.length > 24 ? '…' : ''));
  }
  check('no credential-shaped string literal anywhere in worker.js',
        creds.length === 0, creds.join(' | '));
  note('worker.js is world-readable at ila.cafe/worker/worker.js — this is what keeps that safe');

  // wrangler.toml is committed, so its [vars] must stay to values the site already publishes.
  const PUBLIC_OK = ['VAPID_PUBLIC', 'FIREBASE_API_KEY', 'FIREBASE_PROJECT', 'DB_URL'];
  const varsBlock = (toml.split('[vars]')[1] || '').split(/^\[/m)[0];
  const declared = [...varsBlock.matchAll(/^\s*([A-Z_]+)\s*=/gm)].map(m => m[1]);
  const unexpected = declared.filter(n => !PUBLIC_OK.includes(n));
  check('wrangler.toml declares only values the site already publishes',
        unexpected.length === 0, 'unexpected: ' + unexpected.join(', '));
  note('committed vars: ' + declared.join(', '));
}

// ---------------------------------------------------------------- every binding is accounted for
{
  const used = [...new Set([...src.matchAll(/env\.([A-Z_]+)/g)].map(m => m[1]))].sort();
  const undocumented = used.filter(n => !toml.includes(n) && !doc.includes('`' + n + '`'));
  check('every env binding the Worker reads is a committed var or a documented secret',
        undocumented.length === 0, 'undocumented: ' + undocumented.join(', '));
  note(used.length + ' bindings: ' + used.join(', '));
}

// ---------------------------------------------------------------- auth routing
{
  // The two recalibration routes must not be gated by the push secret, which is a
  // literal in four public pages and therefore known to anyone who views source.
  const recalLines = src.split('\n').filter(l => /recalibrate-(now|dryrun)/.test(l) && /authOk|secret/.test(l));
  check('both recalibration routes are gated by RECAL_SECRET',
        recalLines.length === 2 && recalLines.every(l => /authOk\(data\.secret,\s*RECAL_SECRET\)/.test(l)),
        recalLines.map(l => l.trim()).join(' || '));
  check('neither recalibration route accepts SHARED_SECRET',
        !recalLines.some(l => /SHARED_SECRET/.test(l)));

  for (const page of ['pos.html', 'admin.html', 'barista.html', 'chef.html', 'index.html']) {
    const p = readPage(page);
    if (!/RECAL_SECRET|recalibrate-/.test(p)) continue;
    check('RECAL_SECRET does not appear in ' + page, false, 'a page references the recalibration route');
  }
  check('no page references RECAL_SECRET or a recalibration route', true);
  note('the whole point: this secret must not be reachable by view-source');
}

// ---------------------------------------------------------------- authOk fails closed
{
  const api = buildModule([extractFunction(src, 'authOk')], {}, ['authOk']);
  const real = 'a'.repeat(24);
  check('authOk accepts the configured secret', api.authOk(real, real) === true);
  check('authOk rejects a wrong secret', api.authOk('nope', real) === false);

  // The one that matters: a forgotten `wrangler secret put` leaves the binding
  // undefined, and a request that omits the field also sends undefined. Plain
  // === would make that pair MATCH and publish the route.
  check('an unset binding cannot be satisfied by an absent field',
        api.authOk(undefined, undefined) === false, 'undefined === undefined would have passed');
  check('an unset binding rejects every provided value',
        api.authOk('', undefined) === false && api.authOk('anything', undefined) === false);
  check('an empty-string binding is refused too', api.authOk('', '') === false);
  check('a too-short binding is refused', api.authOk('short', 'short') === false);
  note('this is the difference between a 401 and a wide-open authenticated route');
}

// ---------------------------------------------------------------- the volume gate
{
  const api = buildModule([extractFunction(src, 'rcCountFresh')], { Number }, ['rcCountFresh']);
  const day = 86400000, now = Date.now();
  // 75-day window holding plenty of orders, but only a handful since the last run
  const orders = [];
  for (let i = 0; i < 4000; i++) orders.push({ done: now - 40*day - i });   // long before the last run
  for (let i = 0; i < 120;  i++) orders.push({ done: now - i*1000 });        // since the last run
  const lastRun = now - 10*day;

  check('the gate counts only completions newer than the last run',
        api.rcCountFresh(orders, lastRun) === 120, String(api.rcCountFresh(orders, lastRun)));
  check('and that is far below the whole window, which is what used to be counted',
        api.rcCountFresh(orders, 0) === 4120);
  note('4,120 in the window vs 120 new — the old gate compared 1,500 against 4,120 and always passed');

  check('a first run, with no recorded lastRunAt, counts everything',
        api.rcCountFresh(orders, undefined) === 4120 && api.rcCountFresh(orders, null) === 4120);

  // and the call site must actually feed it lastRunAt rather than reading meta and dropping it
  check('runRecalibration gates on the fresh count, not on orders.length',
        /rcCountFresh\(orders,\s*meta\.lastRunAt\)/.test(src) &&
        /fresh\s*<\s*RECAL_MIN_NEW_ORDERS/.test(src) &&
        !/orders\.length\s*<\s*RECAL_MIN_NEW_ORDERS/.test(src));
  check('a dry run still skips the gate, so it can always report what a refit would do',
        /if\(!dryRun && fresh < RECAL_MIN_NEW_ORDERS\)/.test(src));
}

// ---------------------------------------------------------------- scheduled notifications reach a device
{
  const api = buildModule([extractFunction(src, 'unwrapSubs')], { Object }, ['unwrapSubs']);
  const sub = { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } };

  // exactly the shape admin.html writes: db.ref('pushSubscriptions/'+key).set({subscription, uid, name, at})
  const stored = { dev1: { subscription: sub, uid: 'u1', name: 'Admin', at: 1 },
                   dev2: { subscription: sub, uid: 'u2', name: 'Phone', at: 2 } };
  check('the wrapper admin.html actually writes is unwrapped to a real subscription',
        api.unwrapSubs(stored).length === 2 && api.unwrapSubs(stored)[0].endpoint === sub.endpoint,
        JSON.stringify(api.unwrapSubs(stored)));
  note('passing the wrapper straight through made sendOne throw into a swallowed catch,');
  note('so recal results, payment alerts, the bank alarm and the digest all sent nothing');

  check('a bare subscription still works', api.unwrapSubs({ d: sub }).length === 1);
  check('a device with no subscription is dropped rather than thrown',
        api.unwrapSubs({ a: { uid: 'u' }, b: null, c: sub }).length === 1);
  check('nothing stored yields nothing', api.unwrapSubs(null).length === 0);
}

// ---------------------------------------------------------------- cron wiring
{
  // only the crons array — the file's warning comments quote a schedule too
  const cronBlock = /crons\s*=\s*\[([\s\S]*?)\]/.exec(toml);
  const crons = cronBlock ? [...cronBlock[1].matchAll(/"([^"]+)"/g)].map(m => m[1]) : [];
  check('wrangler.toml declares both cron schedules', crons.length === 2, crons.join(' | '));

  // scheduled() compares the matched schedule string literally, so a cron edited in
  // one place and not the other silently turns recalibration into the hourly monitor.
  const compared = /cron === '([^']+)'/.exec(src);
  check('the schedule scheduled() compares is one of the declared crons',
        !!compared && crons.includes(compared[1]),
        'compares ' + (compared ? compared[1] : 'nothing') + ', declares ' + crons.join(' | '));
  note('recalibration runs only when the matched string is exactly ' + (compared ? compared[1] : '?'));
}

// ---------------------------------------------------------------- the parsers still parse
// This file was ported out of the Cloudflare dashboard by hand. The bank parsers are
// the money path — a mistyped regex means credits stop being ingested and every
// payment silently falls back to manual verification. These samples are shaped like
// the alerts the parsers were written against, so a transcription slip fails here.
{
  const api = buildModule([
    extractFunction(src, 'parseICICI'), extractFunction(src, 'parseAirtel'),
    extractFunction(src, 'parseAxis'),  extractFunction(src, 'parsePayment'),
    extractFunction(src, 'parseBankEmail'),
    "const _num = (re, t) => { const m = t.match(re); return m ? parseFloat(m[1].replace(/,/g,'')) : null; };",
    "const _grp = (re, t) => { const m = t.match(re); return m ? m[1] : null; };",
  ], { parseFloat, String }, ['parsePayment', 'parseBankEmail']);

  const icici = api.parsePayment('icici',
    'Dear Customer, Acct XX123 is credited with Rs 1,250.00 on 12-Aug-25 from RAHUL SHARMA. UPI: 523412345678.');
  check('ICICI: amount, account, payer and UTR all come out',
        icici.amount === 1250 && icici.ref === '523412345678' &&
        icici.payer === 'RAHUL SHARMA' && icici.acct === 'XX123', JSON.stringify(icici));

  const airtel = api.parsePayment('airtel', 'Your a/c is credited with Rs. 480 . Txn ID: 987654321012');
  check('Airtel: amount and txn id come out', airtel.amount === 480 && airtel.ref === '987654321012',
        JSON.stringify(airtel));

  const axis = api.parsePayment('axis',
    'Amount Credited: INR 2,340.50\nAccount Number: XXXX7788\n' +
    'Transaction Info: UPI/P2M/512398765432/PRIYA N/AXIS\nDate & Time: 12-08-2025, 14:22:07 IST');
  check('Axis: amount, UTR and payer parse out of the transaction info field',
        axis.amount === 2340.5 && axis.ref === '512398765432' && axis.payer === 'PRIYA N',
        JSON.stringify(axis));

  check('a debit alert is not mistaken for a credit',
        api.parsePayment('icici', 'Acct XX123 debited Rs 500 on 12-Aug-25.').amount === null);
  check('an unrecognised sender yields nothing to write',
        api.parsePayment('', 'Your OTP is 445566. Do not share it.') === null);

  // the email path, which is what actually runs today
  const axisMail = api.parseBankEmail('axis',
    'Amount Credited INR 899.00 Account Number XXXX7788 UPI/P2M/512300099988/ARJUN K/ Date');
  check('the Axis email parser extracts the same fields',
        axisMail && axisMail.amount === 899 && axisMail.ref === '512300099988' && axisMail.payer === 'ARJUN K',
        JSON.stringify(axisMail));

  const yesMail = api.parseBankEmail('yes',
    'INR 1,499.00 has been credited to your A/C No. XX4455 UPI:512377766655 /From:rahul@okaxis on 12-Aug');
  check('the Yes Bank email parser extracts the same fields',
        yesMail && yesMail.amount === 1499 && yesMail.ref === '512377766655' && yesMail.payer === 'rahul@okaxis',
        JSON.stringify(yesMail));

  check('a marketing email from a bank is not parsed as a credit',
        api.parseBankEmail('axis', 'Get a credit card with INR 50,000 limit! Apply now.') === null);
  note('these guard the hand-port out of the dashboard, not the banks\' formats');
}

// ---------------------------------------------------------------- the robot can reach what it reads
// Every write the Worker needs was granted to robot@cafeila.app by email. Not one
// read was — they were all gated on users/{auth.uid}/role, and a service account
// has no users entry. So the robot could write eta/model but could not read
// orders/completed to derive one, and could not read pushSubscriptions to notify
// anyone. Recalibration and the whole verification monitor were shut out of their
// own inputs.
//
// Paths are extracted from the Worker's source, so adding a new read without a
// matching rule fails here instead of failing silently at 3am on the 1st.
{
  const rules = JSON.parse(stripComments(fs.readFileSync(path.join(ROOT, 'database.rules.json'), 'utf8'))).rules;
  const ROBOT = 'robot@cafeila.app';

  // nearest ancestor carrying the rule wins — Firebase rules cascade down
  function granted(p, kind) {
    let cur = rules, best = cur[kind];
    for (const seg of p.split('/').filter(Boolean)) {
      if (!cur) break;
      const wild = Object.keys(cur).find(k => k.startsWith('$'));
      const next = Object.prototype.hasOwnProperty.call(cur, seg) ? cur[seg] : (wild ? cur[wild] : null);
      if (!next) { cur = null; break; }
      cur = next;
      if (cur[kind] != null) best = cur[kind];
    }
    return best === true || (typeof best === 'string' && best.includes(ROBOT));
  }

  // every literal database path in the Worker, with whether that call writes
  const found = new Map();
  for (const m of src.matchAll(/DB_URL \+ '([^']+)'/g)) {
    // A literal ending in '/' has a dynamic segment concatenated after it
    // ('/users/' + uid). Keep a placeholder so the path resolves against the
    // wildcard rule that governs it ($uid) rather than against its parent.
    let p = m[1].replace(/\.json.*$/, '');
    p = p.endsWith('/') && p !== '/' ? p + '$dynamic' : (p || '/');
    const after = src.slice(m.index, m.index + 260);
    const writes = /method\s*:\s*'(PUT|PATCH|POST|DELETE)'/.test(after);
    found.set(p, (found.get(p) || false) || writes);
  }
  for (const m of src.matchAll(/monLoad\([^,]+,\s*'([^']+)'\)/g)) {
    if (!found.has(m[1])) found.set(m[1], false);          // monLoad only ever reads
  }

  // '/' is the root PATCH that writes the monitor/* alert state in one call
  const ROOT_PATCH = { '/': 'monitor' };
  const WRITE_ONLY = ['/payments/incoming'];                // never read back

  const unreachable = [];
  for (const [p, writes] of found) {
    const target = ROOT_PATCH[p] || p;
    if (writes && !granted(target, '.write')) unreachable.push(p + ' (write)');
    const readOnlyNeeded = !WRITE_ONLY.some(w => p.startsWith(w)) && p !== '/';
    if (readOnlyNeeded && !granted(target, '.read')) unreachable.push(p + ' (read)');
  }
  check('the robot can reach every database path the Worker uses',
        unreachable.length === 0, unreachable.join(', '));
  note([...found.keys()].sort().join('  '));

  // discriminating: strip the robot from one rule and the check must notice
  const saved = JSON.stringify(rules.pushSubscriptions['.read']);
  rules.pushSubscriptions['.read'] = "auth != null && root.child('users').child(auth.uid).child('role').exists()";
  check('and it notices when a rule stops naming the robot', !granted('/pushSubscriptions', '.read'),
        'the audit would have passed a rule that locks the Worker out');
  rules.pushSubscriptions['.read'] = JSON.parse(saved);

  // the grants must not have opened anything to the world
  const PUBLIC_OK = ['menu', 'settings', 'eta', 'orders/track'];
  const leaked = [];
  (function walk(n, p) {
    if (!n || typeof n !== 'object') return;
    if (n['.read'] === true && !PUBLIC_OK.some(x => (p || '').startsWith(x))) leaked.push(p || '(root)');
    for (const k of Object.keys(n)) if (!k.startsWith('.')) walk(n[k], p ? p + '/' + k : k);
  })(rules, '');
  check('and nothing became world-readable in the process', leaked.length === 0, leaked.join(', '));
}

// ---------------------------------------------------------------- the token check itself
// The relay's only defence now. Rejecting a good token is visible — nobody gets
// alerts. Accepting a bad one is invisible, and puts a fabricated "Bill voided
// ₹50,000" on the owner's lock screen through the café's own pipe. So this signs
// real tokens with a real key and checks each rejection reason separately.
{
  const { webcrypto } = require('crypto');
  const b64url = b => Buffer.from(b).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const kp = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pubJwk = await webcrypto.subtle.exportKey('jwk', kp.publicKey);
  const KID = 'test-kid';

  // the JWKS endpoint the Worker fetches, stubbed
  const fetchStub = async () => ({
    ok: true,
    headers: { get: () => 'max-age=3600' },
    json: async () => ({ keys: [{ kty: pubJwk.kty, n: pubJwk.n, e: pubJwk.e, alg: 'RS256', kid: KID }] })
  });

  const api = buildModule([
    'let _jwkCache = null, _jwkExp = 0;',
    'const _enc = new TextEncoder();',
    extractFunction(src, 'b64urlToBytes'),
    extractFunction(src, 'googleJwks'),
    extractFunction(src, 'verifyIdToken'),
    'function setProject(p){ FIREBASE_PROJECT = p; }',
  ], { FIREBASE_PROJECT: 'ila-cafe', fetch: fetchStub, crypto: webcrypto,
       TextEncoder, TextDecoder, Date, Math, JSON, String, parseInt },
     ['verifyIdToken']);

  const now = () => Math.floor(Date.now() / 1000);
  async function mint(over, signWith) {
    const header = Object.assign({ alg: 'RS256', kid: KID, typ: 'JWT' }, (over || {}).header || {});
    const payload = Object.assign({
      iss: 'https://securetoken.google.com/ila-cafe', aud: 'ila-cafe',
      sub: 'staff-uid-1', iat: now() - 60, exp: now() + 3600,
      firebase: { sign_in_provider: 'password' }
    }, (over || {}).payload || {});
    const h = b64url(JSON.stringify(header)), p = b64url(JSON.stringify(payload));
    const sig = new Uint8Array(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',
      signWith || kp.privateKey, new TextEncoder().encode(h + '.' + p)));
    return h + '.' + p + '.' + b64url(sig);
  }

  check('a properly signed, current token for this project is accepted',
        (await api.verifyIdToken(await mint())) !== null);

  check('a token signed by somebody else is rejected',
        (await api.verifyIdToken(await mint({}, (await webcrypto.subtle.generateKey(
          { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
          true, ['sign', 'verify'])).privateKey))) === null,
        'a forged signature was accepted');

  check('a tampered payload is rejected',
        await (async () => {
          const t = await mint(); const [h, p, sg] = t.split('.');
          const bad = b64url(JSON.stringify(Object.assign(
            JSON.parse(Buffer.from(p, 'base64url').toString()), { sub: 'someone-else' })));
          return (await api.verifyIdToken(h + '.' + bad + '.' + sg)) === null;
        })(), 'the signature did not cover the payload');

  check('an expired token is rejected',
        (await api.verifyIdToken(await mint({ payload: { exp: now() - 10 } }))) === null);
  check('a token for a different Firebase project is rejected',
        (await api.verifyIdToken(await mint({ payload: { aud: 'some-other-app' } }))) === null);
  check('a token from a different issuer is rejected',
        (await api.verifyIdToken(await mint({ payload: { iss: 'https://evil.example/ila-cafe' } }))) === null);
  check('an unsigned alg:none token is rejected',
        (await api.verifyIdToken(await mint({ header: { alg: 'none' } }))) === null,
        'alg:none is the classic JWT bypass');
  check('a token whose kid names no known key is rejected',
        (await api.verifyIdToken(await mint({ header: { kid: 'not-a-real-kid' } }))) === null);
  check('garbage is rejected without throwing',
        (await api.verifyIdToken('not.a.token')) === null &&
        (await api.verifyIdToken('')) === null &&
        (await api.verifyIdToken(null)) === null);
  note('an anonymous customer token is caught separately, by sign_in_provider and by the role lookup');
}

// ---------------------------------------------------------------- the relay's own wiring
{
  check('the relay no longer authenticates with the public push secret',
        !/authOk\(data\.secret,\s*SHARED_SECRET\)/.test(src) && !/SHARED_SECRET\s*=/.test(src),
        'the retired secret is still wired up');
  check('recipients come from the database, not from the caller',
        !/Array\.isArray\(data\.subscriptions\)/.test(src) &&
        /unwrapSubs\(res\.ok/.test(src),
        'the caller can still choose who gets pushed');
  check('an anonymous sign-in is refused before the role lookup',
        /sign_in_provider === 'anonymous'/.test(src));
  check('the payload is sanitised before it is sent',
        /safeNotification\(data\.notification\)/.test(src));

  const api = buildModule([extractFunction(src, 'safeText'), extractFunction(src, 'safeNotification')],
                          { String }, ['safeNotification']);
  const n = api.safeNotification({ title: 'x'.repeat(500), body: 'a\u0000b', tag: 't',
                                   url: 'https://evil.example/steal' });
  check('an absolute url cannot ride in — sw.js hands it to openWindow() on tap',
        n.url === '/admin.html', n.url);
  check('a protocol-relative url is refused too', api.safeNotification({ url: '//evil.example' }).url === '/admin.html');
  check('a same-site path is kept', api.safeNotification({ url: '/pos.html' }).url === '/pos.html');
  check('the title is bounded', n.title.length === 80);
  check('control characters are stripped from the body', !/\u0000/.test(n.body), JSON.stringify(n.body));
  check('an empty notification still yields something sendable',
        api.safeNotification({}).title === 'Café Ila' && api.safeNotification(null).tag === 'ila');
}

done();
}
