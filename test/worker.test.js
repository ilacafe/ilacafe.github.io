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
const { ROOT, readPage, extractFunction, buildModule, suite } = require('./helpers');

const src  = readPage('worker/worker.js');
const toml = fs.readFileSync(path.join(ROOT, 'worker', 'wrangler.toml'), 'utf8');
const doc  = fs.readFileSync(path.join(ROOT, 'worker', 'README.md'), 'utf8');

const { check, note, done } = suite('Worker — secrets, auth routing and the recalibration gate');

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
  const PUBLIC_OK = ['VAPID_PUBLIC', 'FIREBASE_API_KEY', 'DB_URL'];
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

done();
