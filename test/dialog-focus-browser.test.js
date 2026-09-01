// A dialog that behaves like one.
//
// Every overlay on the ordering page already said aria-modal="true". Nothing made
// that true. aria-modal is a claim about the accessibility tree and nothing else:
// it does not move focus, it does not stop Tab, and it does not make the page
// underneath unreachable. So opening the checkout dialog left focus on whatever had
// been tapped — behind it — and Tab walked straight down into the sixty rows of the
// menu, where + and - were still live buttons under an overlay covering them.
//
// The till was the same shape with more of it: fourteen overlays, a floor plan of
// live table buttons behind them, and no Escape key on a device cashiers type into
// all day. The way out of a dialog opened by mistake was to find ✖ CLOSE at the
// bottom of a card that might be scrolled.
//
// Four things, and they are the whole of what a dialog owes the person in it:
//
//   focus goes in      the next Tab is inside the dialog, not underneath it
//   Tab stays in       the last control wraps to the first
//   Escape gets out    the same act as tapping the backdrop, held to the same rules
//   focus comes back   to the control that opened it, not the top of the document
//
// TWO DIALOGS ARE DELIBERATELY EXCLUDED FROM ESCAPE, and that is checked here too,
// because "Escape closes dialogs" is exactly the tidy generalisation that would
// quietly delete them. The customer's payment screen is the one telling them what
// they owe; the till's UPI screen is in a customer's hands while they scan. Neither
// is dismissed by a stray anything — each keeps its own explicit button.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Dialogs — focus goes in, Tab stays in, Escape gets out');

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

// Nothing here is about Firebase, but a page that throws on its first line has not
// wired up anything, so the SDK is stubbed rather than left broken.
const STUB = `
(() => {
  const snap = (o) => ({ val: () => (o === undefined ? null : o), exists: () => o != null,
                         numChildren: () => 0, forEach: () => {}, key: null });
  const mk = () => { const s = {
    key: 'k', child: () => mk(), orderByChild: () => s, orderByKey: () => s,
    limitToLast: () => s, limitToFirst: () => s, startAt: () => s, endAt: () => s, equalTo: () => s,
    on: (_e, cb) => { try { if (cb) cb(snap(null)); } catch (e) {} return cb; }, off: () => {},
    once: (_e, cb) => { const x = snap(null); if (cb) cb(x); return Promise.resolve(x); },
    push: () => mk(), set: () => Promise.resolve(), update: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    transaction: (_f, cb) => { const x = snap(null); if (cb) cb(null, false, x); return Promise.resolve({ committed: false, snapshot: x }); }
  }; return s; };
  const database = () => ({ ref: () => mk(), goOnline: () => {}, goOffline: () => {} });
  database.ServerValue = { TIMESTAMP: 1756200000000, increment: (n) => ({ '.sv': { increment: n } }) };
  window.firebase = {
    initializeApp: () => ({}), apps: [], database: database,
    auth: () => ({ currentUser: { uid: 'u1' }, onAuthStateChanged: (cb) => { window.__authCb = cb; return () => {}; },
                   signOut: () => Promise.resolve(),
                   signInWithEmailAndPassword: () => Promise.resolve({ user: { uid: 'u1' } }),
                   signInAnonymously: () => Promise.resolve({ user: { uid: 'a' } }) })
  };
  window.Chart = function () { return { destroy(){}, update(){}, data:{datasets:[]}, options:{} }; };
})();
`;

// One dialog that must answer Escape, and one that must not, per page. The excluded
// one is named rather than derived: it is a deliberate exception, so a test that
// worked it out from the source would agree with a mistake.
const PAGES = [
  { file: 'index.html',     open: `openModal('checkout-modal')`,    id: 'checkout-modal',  never: 'payment-modal' },
  { file: 'pos.html',       open: `openModal('table-modal')`,       id: 'table-modal',     never: 'upi-modal' },
  { file: 'inventory.html', open: `openModal('prep', 'Cold Brew')`, id: 'action-modal',    never: null },
];

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE) ? { executablePath: PRE } : {});
  const threw = [];

  for (const page of PAGES) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 900, height: 800 } });
    await ctx.addInitScript(STUB);
    const pg = await ctx.newPage();
    pg.on('pageerror', e => threw.push(page.file + ': ' + String(e.message || e).split('\n')[0]));
    await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await pg.goto(base + '/' + page.file, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(400);

    // Something outside the dialog to open it FROM, so "focus came back" means
    // something. A real button on the page, marked so it can be recognised again.
    await pg.evaluate(() => {
      const opener = document.createElement('button');
      opener.id = '__opener';
      opener.textContent = 'opener';
      document.body.appendChild(opener);
      opener.focus();
    });

    // ------------------------------------------------------------- focus goes in
    const opened = await pg.evaluate(async (p) => {
      eval(p.open);
      await new Promise(r => setTimeout(r, 200));   // inventory focuses its first field on a timer
      const ov = document.getElementById(p.id);
      return { active: ov.classList.contains('active'),
               inside: ov.contains(document.activeElement),
               onBody: document.activeElement === document.body };
    }, page);

    check(page.file + ' — opening a dialog opens it', opened.active);
    check(page.file + ' — and puts focus inside it',
          opened.inside, opened.onBody ? 'focus was left on the body' : 'focus was left outside');

    // -------------------------------------------------------------- Tab stays in
    // Far more presses than the dialog has controls, so a trap that only holds for
    // one lap is not enough to pass.
    let escaped = null;
    for (let i = 0; i < 40 && escaped === null; i++) {
      await pg.keyboard.press('Tab');
      const out = await pg.evaluate((id) => {
        const ov = document.getElementById(id);
        return ov.contains(document.activeElement) ? null
             : (document.activeElement.id || document.activeElement.className ||
                document.activeElement.tagName);
      }, page.id);
      if (out) escaped = 'after ' + (i + 1) + ' Tab presses, focus reached ' + out;
    }
    check(page.file + ' — 40 Tab presses never leave the dialog', escaped === null, escaped || '');

    // Backwards too. Shift+Tab from the first control is the easier one to get wrong.
    let escapedBack = null;
    for (let i = 0; i < 40 && escapedBack === null; i++) {
      await pg.keyboard.press('Shift+Tab');
      const out = await pg.evaluate((id) => {
        const ov = document.getElementById(id);
        return ov.contains(document.activeElement) ? null
             : (document.activeElement.id || document.activeElement.className ||
                document.activeElement.tagName);
      }, page.id);
      if (out) escapedBack = 'after ' + (i + 1) + ' presses, focus reached ' + out;
    }
    check(page.file + ' — and 40 backwards do not either', escapedBack === null, escapedBack || '');

    // ------------------------------------------------- Escape out, focus restored
    await pg.keyboard.press('Escape');
    await pg.waitForTimeout(50);
    const closed = await pg.evaluate((id) => ({
      active: document.getElementById(id).classList.contains('active'),
      back: document.activeElement.id
    }), page.id);

    check(page.file + ' — Escape closes it', !closed.active);
    check(page.file + ' — and hands focus back to what opened it',
          closed.back === '__opener', 'focus landed on ' + (closed.back || '(nothing)'));

    // ------------------------------------------------------ and the one that must not
    if (page.never) {
      const held = await pg.evaluate(async (id) => {
        openModal(id);
        await new Promise(r => setTimeout(r, 50));
        return document.getElementById(id).classList.contains('active');
      }, page.never);
      check(page.file + ' — ' + page.never + ' opens', held);

      await pg.keyboard.press('Escape');
      await pg.waitForTimeout(50);
      const stillOpen = await pg.evaluate((id) => document.getElementById(id).classList.contains('active'), page.never);
      check(page.file + ' — and Escape does NOT dismiss it', stillOpen,
            page.never + ' was dismissed by Escape');
    }

    await ctx.close();
  }

  note('the payment screen and the till’s UPI screen are held out on purpose —');
  note('one is what the customer owes, the other is in their hands while they scan');

  check('no page threw while any of that ran', threw.length === 0, threw.join(' | '));

  await browser.close();
  server.close();
  done();
})();
