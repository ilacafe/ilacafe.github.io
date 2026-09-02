// The till's less-travelled paths, driven rather than read.
//
// Replacing 86 browser dialogs with the app's own meant converting 32 call sites from
// something synchronous to something awaited, and making 16 functions async to hold
// them. Three suites caught real breakage in the paths they already covered — the
// end-of-day archive silently never being written, among them. The paths NOBODY
// covered were the ones left: voiding a line off a table, merging two bills, marking
// an unverified payment received, paying tips out of the drawer, a short drawer, a
// custom tip, and accepting or rejecting a web order.
//
// Two failure modes are worth naming, because they are the ones that would have been
// invisible in a diff:
//
//   A MISSING await. `if (!ilaAsk(…))` tests a Promise, and a Promise is always
//   truthy — so the guard inverts and every confirmation silently auto-confirms.
//   That is the worst possible outcome for a set of prompts that exist to stop
//   somebody voiding a bill by accident.
//
//   A MISSING null GUARD. ilaAskText resolves null when it is backed out of, exactly
//   as prompt() returned null, and several of these call .trim() on the answer.
//
// Both are checkable by driving the real function through the real overlay and
// watching what it writes, which is what this does. The state each flow needs is set
// on the page directly: this is not a test of how a cashier gets to the button, it is
// a test of what happens once they have.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('The till — the paths no other suite walks');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
                '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('no');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

// Every write is recorded rather than performed, so a flow that reaches its write can
// be told apart from one that quietly returned early.
const STUB = `
(() => {
  window.__writes = [];
  const snap = (o) => ({ val: () => (o === undefined ? null : o), exists: () => o != null,
                         numChildren: () => 0, forEach: () => {}, key: null });
  const mk = (p) => { const s = {
    key: 'k', child: (c) => mk(p + '/' + c), orderByChild: () => s, orderByKey: () => s,
    limitToLast: () => s, limitToFirst: () => s, startAt: () => s, endAt: () => s, equalTo: () => s,
    on: (_e, cb) => { try { if (cb) cb(snap(null)); } catch (e) {} return cb; }, off: () => {},
    once: (_e, cb) => { const x = snap(null); if (cb) cb(x); return Promise.resolve(x); },
    push: () => { window.__writes.push({ op: 'push', at: String(p) }); return mk(p + '/new'); },
    set: (v) => { window.__writes.push({ op: 'set', at: String(p), v: v }); return Promise.resolve(); },
    update: (v) => { window.__writes.push({ op: 'update', at: String(p), v: v }); return Promise.resolve(); },
    remove: () => { window.__writes.push({ op: 'remove', at: String(p) }); return Promise.resolve(); },
    transaction: (f, cb) => { window.__writes.push({ op: 'transaction', at: String(p) });
                              const x = snap(null); if (cb) cb(null, true, x);
                              return Promise.resolve({ committed: true, snapshot: x }); }
  }; return s; };
  const database = () => ({ ref: (p) => mk(p === undefined ? '' : String(p)), goOnline: () => {}, goOffline: () => {} });
  database.ServerValue = { TIMESTAMP: 1756200000000, increment: (n) => ({ '.sv': { increment: n } }) };
  window.firebase = {
    initializeApp: () => ({}), apps: [], database: database,
    auth: () => ({ currentUser: { uid: 'u1' },
                   onAuthStateChanged: (cb) => { setTimeout(() => { try { cb({ uid: 'u1' }); } catch (e) {} }, 0); return () => {}; },
                   signOut: () => { window.__signedOut = true; return Promise.resolve(); },
                   signInWithEmailAndPassword: () => Promise.resolve({ user: { uid: 'u1' } }),
                   signInAnonymously: () => Promise.resolve({ user: { uid: 'a' } }) })
  };
  window.Chart = function () { return { destroy(){}, update(){}, data:{datasets:[]}, options:{} }; };
})();
`;

const DLG = '.ila-dialog';

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE) ? { executablePath: PRE } : {});
  const threw = [];

  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true });
  await ctx.addInitScript(STUB);
  const pg = await ctx.newPage();
  pg.on('pageerror', e => threw.push(String(e.message || e).split('\n')[0]));
  await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
  await pg.goto(base + '/pos.html', { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(900);
  await pg.evaluate(() => {
    const o = document.getElementById('login-overlay'); if (o) o.style.display = 'none';
    // Redraws that need a screen state these flows do not set up.
    window.renderUPIQR = () => {};
    window.renderCart = window.renderCart || (() => {});
  });

  // The dialog is the real one, so it is answered the way a thumb answers it.
  const seen = async () => { await pg.waitForSelector(DLG, { state: 'visible', timeout: 3000 }); };
  const title = () => pg.evaluate((s) => {
    const c = document.querySelector(s + ' [role="dialog"]');
    const t = c && document.getElementById(c.getAttribute('aria-labelledby'));
    return t ? t.textContent.trim() : null;
  }, DLG);
  const tapOk = () => pg.click(`${DLG} button:last-of-type`);
  const tapNo = () => pg.click(`${DLG} button:first-of-type`);
  const typeIn = async (v) => { await pg.fill(DLG + ' input', v); await tapOk(); };
  const writes = () => pg.evaluate(() => window.__writes.map(w => w.op + ' ' + w.at));
  const clear  = () => pg.evaluate(() => { window.__writes = []; });
  const toastText = () => pg.evaluate(() => document.body.innerText);

  // ---------------------------------------------------------- a custom tip
  {
    await pg.evaluate(() => { window.pendingTip = 0; window.__t = window.setTip('custom'); });
    await seen();
    check('a custom tip asks for the amount', (await title()) === 'Tip amount', String(await title()));
    await typeIn('45');
    await pg.evaluate(() => window.__t);
    check('and the amount typed is the tip that is set',
          (await pg.evaluate(() => window.pendingTip)) === 45,
          'pendingTip = ' + await pg.evaluate(() => window.pendingTip));

    // Backing out must leave the tip alone, which is the null path.
    await pg.evaluate(() => { window.pendingTip = 45; window.__t = window.setTip('custom'); });
    await seen(); await pg.keyboard.press('Escape');
    await pg.evaluate(() => window.__t);
    check('and backing out leaves the tip exactly as it was',
          (await pg.evaluate(() => window.pendingTip)) === 45, 'the tip moved');

    await pg.evaluate(() => { window.pendingTip = 45; window.__t = window.setTip('custom'); });
    await seen(); await typeIn('abc');
    await pg.evaluate(() => window.__t);
    check('and a non-number is refused rather than written as NaN',
          (await pg.evaluate(() => window.pendingTip)) === 45 && /valid amount/i.test(await toastText()),
          'pendingTip = ' + await pg.evaluate(() => window.pendingTip));
  }

  // ------------------------------------------------- voiding a line off a table
  //
  // Two questions back to back — a reason, then a PIN — which is the shape most
  // likely to break when prompt() stops being synchronous.
  {
    await clear();
    await pg.evaluate(() => {
      window.staffPins = { }; window.checkoutTableID = '4';
      window.activeTables = { '4': { total: 400, paid: 0, items: { 'Latte': { qty: 1, price: 400 } } } };
      window.__v = window.removeTableItem('4', 'Latte', 400, 'Latte');
    });
    await seen();
    check('voiding a line asks why first', /^Remove /.test(await title() || ''), String(await title()));
    await typeIn('spilled');
    await seen();
    check('and then asks for a PIN', (await title()) === 'Staff PIN', String(await title()));
    await typeIn('9999');                                   // no staff PIN matches
    await pg.waitForTimeout(250);
    await seen();
    check('and an unknown PIN is refused, in words', (await title()) === 'Invalid PIN', String(await title()));
    await tapOk();
    check('and nothing was written when it was refused',
          (await writes()).length === 0, (await writes()).join(', '));
  }

  // ------------------------------------------------------- merging two bills
  {
    await clear();
    await pg.evaluate(() => {
      window.checkoutTableID = '4';
      window.activeTables = { '4': { total: 400, paid: 0, items: {} }, '7': { total: 250, paid: 0, items: {} } };
      window.__m = window.confirmMoveTable('7');
    });
    await seen();
    check('moving onto an occupied table asks before merging',
          /already occupied/.test(await title() || ''), String(await title()));
    await tapNo();
    await pg.evaluate(() => window.__m);
    check('and saying no writes nothing at all', (await writes()).length === 0, (await writes()).join(', '));
    note('a Promise is truthy, so a missing await here would merge two bills silently');
  }

  // ------------------------------- marking an unverified payment as received
  {
    await clear();
    await pg.evaluate(() => {
      window.pendingUPIAmount = 300; window.checkoutTableID = '4';
      window.activeTables = { '4': { total: 300, paid: 0, items: {} } };
      window.__u = window.confirmUPIPayment();
    });
    await seen();
    check('marking an unmatched payment received asks first',
          /as received\?$/.test(await title() || ''), String(await title()));
    await tapNo();
    await pg.evaluate(() => window.__u);
    check('and saying no records no payment', (await writes()).length === 0, (await writes()).join(', '));
  }

  // ------------------------------------------------------- rejecting a web order
  {
    await clear();
    await pg.evaluate(() => {
      window._webActing = {};
      window.pendingWebOrders = { w1: { id: 'w1', items: { Latte: { qty: 1, price: 400 } }, total: 400, destination: 'Takeaway' } };
      window.__r = window.rejectWebOrder('w1');
    });
    await seen();
    check('rejecting a web order asks before it does', /Reject/i.test(await title() || ''), String(await title()));
    await tapNo();
    await pg.evaluate(() => window.__r);
    check('and saying no leaves the order alone', (await writes()).length === 0, (await writes()).join(', '));
  }

  // ----------------------------------------------- accepting one with no menu
  //
  // The one converted site where the cleanup had to be moved BEFORE the message: the
  // in-flight flag has to clear whether or not anyone is standing there to tap Okay.
  {
    await clear();
    await pg.evaluate(() => {
      window.itemPriceMap = {};                       // menu not loaded
      window._webActing = {};
      window.pendingWebOrders = { w2: { id: 'w2', items: { Latte: { qty: 1, price: 400 } }, total: 400, destination: 'Takeaway' } };
      window.__a = window.acceptWebOrder('w2');
    });
    await seen();
    check('accepting with no menu loaded says so rather than guessing at prices',
          /Menu not loaded/i.test(await title() || ''), String(await title()));
    const flag = await pg.evaluate(() => !!(window._webActing && window._webActing.w2));
    check('and the order is released before the message, not after it', flag === false,
          'it is still flagged as in-flight while the dialog is up');
    await tapOk();
    check('and no prices were written', (await writes()).length === 0, (await writes()).join(', '));
  }

  // ----------------------------------------------------------- signing out
  {
    await pg.evaluate(() => { window.__signedOut = false; window.__s = window.signOutPOS(); });
    await seen();
    await tapNo();
    await pg.evaluate(() => window.__s);
    check('cancelling sign-out keeps the till signed in',
          (await pg.evaluate(() => window.__signedOut)) === false, 'it signed out anyway');
  }

  check('the till threw nothing while any of that ran', threw.length === 0, threw.join(' | '));
  note('every one of these was a confirm() or a prompt() a fortnight ago');

  await ctx.close();
  await browser.close();
  server.close();
  done();
})();
