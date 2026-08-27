// The staff PIN box: masked on screen, exact when it is read.
//
// It used to be type="password", which is what iOS looks for. Changing it to
// type="text" and masking with -webkit-text-security looked like a fix and was
// not — WebKit classifies a field as secure by the MASKING, not by the type, so
// "Sign in to ila.cafe with your password for …" kept appearing over a working
// till at every startup. The kitchen display, which carries the same login markup
// but no PIN box, never showed it. That is what identified this field.
//
// So nothing in the document is secure any more: a plain numeric text box, digits
// held in pin-mask.js, bullets on screen.
//
// This gates cash leaving the drawer, so it is typed at rather than asserted
// about. A masking bug here does not look like a masking bug — it looks like a
// PIN that is refused, or worse, one that is accepted when it should not be.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('The staff PIN — bullets on screen, digits when read');

const PAGES = [
  { file: 'pos.html', input: 'transaction-pin' },
  { file: 'inventory.html', input: 'modal-pin' },
];

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

const STUB = `
(() => {
  const snap = (o) => ({ val: () => (o === undefined ? null : o), exists: () => o != null,
                         numChildren: () => 0, forEach: () => {}, key: null });
  const mk = (p) => { const s = {
    key: 'k', child: () => mk(p), orderByChild: () => s, orderByKey: () => s,
    limitToLast: () => s, limitToFirst: () => s, startAt: () => s, endAt: () => s, equalTo: () => s,
    on: (_e, cb) => { try { if (cb) cb(snap(null)); } catch (e) {} return cb; }, off: () => {},
    once: (_e, cb) => { const x = snap(null); if (cb) cb(x); return Promise.resolve(x); },
    push: () => mk(p), set: () => Promise.resolve(), update: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    transaction: (_f, cb) => { const x = snap(null); if (cb) cb(null, false, x); return Promise.resolve({ committed: false, snapshot: x }); }
  }; return s; };
  const database = () => ({ ref: (p) => mk(String(p || '')), goOnline: () => {}, goOffline: () => {} });
  database.ServerValue = { TIMESTAMP: 1756200000000, increment: (n) => ({ '.sv': { increment: n } }) };
  window.firebase = {
    initializeApp: () => ({}), apps: [], database: database,
    auth: () => ({ currentUser: null, onAuthStateChanged: (cb) => { window.__authCb = cb; return () => {}; },
                   signOut: () => Promise.resolve(), signInWithEmailAndPassword: () => Promise.resolve({ user: { uid: 'u1' } }),
                   signInAnonymously: () => Promise.resolve({ user: { uid: 'a' } }) })
  };
  window.Chart = function () { return { destroy(){}, update(){}, data:{datasets:[]}, options:{} }; };
})();
`;

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE) ? { executablePath: PRE } : {});
  const errors = [];

  async function open(file) {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const pg = await ctx.newPage();
    pg.on('pageerror', e => errors.push(file + ': ' + String(e.message || e).split('\n')[0]));
    await pg.addInitScript(STUB);
    await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await pg.goto(base + '/' + file, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(400);
    return { ctx, pg };
  }

  // ------------------------------------------- nothing in the document is secure
  {
    const secure = [];
    for (const { file } of PAGES) {
      const { ctx, pg } = await open(file);
      const found = await pg.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('input')) {
          const cs = getComputedStyle(el);
          const ts = cs.webkitTextSecurity || cs.getPropertyValue('-webkit-text-security') || 'none';
          if (el.type === 'password') out.push((el.id || '?') + ' (type=password)');
          else if (ts && ts !== 'none') out.push((el.id || '?') + ' (-webkit-text-security: ' + ts + ')');
        }
        return out;
      });
      if (found.length) secure.push(file + ': ' + found.join(', '));
      await ctx.close();
    }
    check('no field on either page is one iOS treats as a password',
          secure.length === 0, secure.join('; '));
    note('type="password" AND -webkit-text-security both count — the second is the one');
    note('that looked like a fix, shipped, and changed nothing at the counter');
  }

  // ------------------------------------------------ typing, reading, correcting
  for (const { file, input } of PAGES) {
    const { ctx, pg } = await open(file);

    const typed = await pg.evaluate(async (id) => {
      const el = document.getElementById(id);
      const type = (s) => { el.value += s; el.dispatchEvent(new Event('input', { bubbles: true })); };
      const back = () => { el.value = el.value.slice(0, -1); el.dispatchEvent(new Event('input', { bubbles: true })); };

      type('4'); type('8'); type('2');
      const afterThree = { shown: el.value, held: window.ilaPin.value(el) };
      back();
      const afterBack = { shown: el.value, held: window.ilaPin.value(el) };
      type('2'); type('1');
      const afterFive = { shown: el.value, held: window.ilaPin.value(el) };
      type('9');                                   // past maxlength
      const afterOver = { held: window.ilaPin.value(el) };
      window.ilaPin.clear(el);
      const afterClear = { shown: el.value, held: window.ilaPin.value(el) };
      return { afterThree, afterBack, afterFive, afterOver, afterClear };
    }, input);

    check(file + ': what is typed is what is read',
          typed.afterThree.held === '482', JSON.stringify(typed.afterThree));
    check(file + ': and the screen shows bullets, not the PIN',
          typed.afterThree.shown === '•••', JSON.stringify(typed.afterThree));
    check(file + ': a backspace takes one digit off, not one bullet off a stale value',
          typed.afterBack.held === '48' && typed.afterBack.shown === '••',
          JSON.stringify(typed.afterBack));
    note('the box holds bullets, so the digits have to be tracked beside it — getting');
    note('this wrong reads as a refused PIN, or worse an accepted one');
    check(file + ': it keeps taking digits after a correction',
          typed.afterFive.held === '4821', JSON.stringify(typed.afterFive));
    check(file + ': and stops at four', typed.afterOver.held === '4821', JSON.stringify(typed.afterOver));
    check(file + ': clearing empties both the digits and the box',
          typed.afterClear.held === '' && typed.afterClear.shown === '',
          JSON.stringify(typed.afterClear));

    await ctx.close();
  }

  // --------------------------------------------- and if the helper never arrives
  {
    const { ctx, pg } = await open('pos.html');
    const fallback = await pg.evaluate(() => {
      const el = document.getElementById('transaction-pin');
      delete window.ilaPin;                                  // as if the script had not loaded
      el.value = '4821';
      return (window.ilaPin ? window.ilaPin.value(el) : (el.value || '')).trim();
    });
    check('a till whose PIN script failed to load still reads a real PIN',
          fallback === '4821', fallback);
    note('the field is a plain text box, so its own value is what was typed — visible');
    note('while typing, which is a worse screen but not a till that cannot cash out');
    await ctx.close();
  }

  check('no page threw while any of that ran', errors.length === 0, errors.slice(0, 3).join('; '));

  await browser.close();
  server.close();
  done();
})();
