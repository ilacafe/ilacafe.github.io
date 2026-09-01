// Is there anything to SEE on the control the keyboard is on?
//
// All seven pages set outline:none on their text fields, and that is a defensible
// choice on its own — the default ring is a grey box that does not belong on the
// brand brown. What none of them did was replace it. The sign-in box is two fields
// stacked, Email then Password, and staff sign these tablets in with a Bluetooth
// keyboard as often as with the on-screen one. With no ring there was nothing to say
// which of the two the next keystroke was going into, and a password typed into the
// email field is shown on screen in plain text.
//
// WHY THIS IS ASKED OF A BROWSER AND NOT OF THE FILE
//
// Because the first version of the fix did not work, and reading the file said it
// did. `:focus-visible { outline: 2px solid #fff }` is there in every page, correct,
// and beaten on both of the fields it was written for: `#login-box input` carries an
// id, so it outranks a bare pseudo-class wherever in the file it sits, and its
// `outline: none` kept winning. A source check found the rule and passed. The page
// still had no ring.
//
// The cascade is the whole of the question here, so the question is put to the thing
// that implements it: focus each control the way a person would, and ask what is
// actually painted around it.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Every page — a focus ring that survives the cascade');

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
    auth: () => ({ currentUser: null, onAuthStateChanged: () => () => {},
                   signOut: () => Promise.resolve(),
                   signInWithEmailAndPassword: () => Promise.resolve({ user: { uid: 'u1' } }),
                   signInAnonymously: () => Promise.resolve({ user: { uid: 'a' } }) })
  };
  window.Chart = function () { return { destroy(){}, update(){}, data:{datasets:[]}, options:{} }; };
})();
`;

const STAFF = ['pos.html', 'admin.html', 'analytics.html', 'barista.html', 'chef.html', 'inventory.html'];

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE) ? { executablePath: PRE } : {});
  const threw = [];

  async function open(file) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1024, height: 768 } });
    await ctx.addInitScript(STUB);
    const pg = await ctx.newPage();
    pg.on('pageerror', e => threw.push(file + ': ' + String(e.message || e).split('\n')[0]));
    await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await pg.goto(base + '/' + file, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(300);
    return { ctx, pg };
  }

  // A ring is a ring only if it is drawn and wide enough to see. `outline-style: none`
  // and `outline-width: 0` are both "nothing there", and either can be the answer, so
  // both are asked. Installed once per page rather than passed around as a string.
  const RING = () => {
    window.__ringed = (el) => {
      const cs = getComputedStyle(el);
      return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1;
    };
  };

  // ------------------------------------------------------------- the sign-in fields
  {
    const bare = [];
    for (const file of STAFF) {
      const { ctx, pg } = await open(file);
      // The login box lives in a <template> so iOS cannot find the password field on a
      // till that is already signed in. auth-gate.js clones it when a sign-in is
      // actually needed; this does the same thing, and then tabs through it.
      await pg.evaluate(() => {
        const ov = document.getElementById('login-overlay');
        ov.classList.remove('hidden');
        ov.appendChild(document.getElementById('login-box-template').content.cloneNode(true));
        document.getElementById('login-email').focus();
      });
      await pg.evaluate(RING);
      const onEmail = await pg.evaluate(() => window.__ringed(document.getElementById('login-email')));
      if (!onEmail) bare.push(file + ': Email');

      await pg.keyboard.press('Tab');   // -> Password, by keyboard, as a person would
      const onPassword = await pg.evaluate(() => {
        const el = document.getElementById('login-password');
        return { focused: document.activeElement === el, ringed: window.__ringed(el) };
      });
      if (!onPassword.focused) bare.push(file + ': Tab did not reach Password');
      else if (!onPassword.ringed) bare.push(file + ': Password');

      await ctx.close();
    }
    check('both sign-in fields are ringed when the keyboard is on them',
          bare.length === 0, bare.join(', '));
    note('this is the check that failed first — the rule was in the file and outranked');
  }

  // ----------------------------------------------- and the customer page's own fields
  {
    const { ctx, pg } = await open('index.html');
    await pg.evaluate(RING);
    const seen = await pg.evaluate(() => {
      openModal('checkout-modal');
      // The slider is two choices deep — Takeaway, then "I'll pick up later" — and a
      // display:none control cannot take focus, so a check that skipped this would be
      // asking about a ring on something nobody can reach.
      window.setOrderType('Takeaway');
      document.getElementById('takeaway-schedule-toggle').checked = true;
      window.toggleSchedule();

      const out = {};
      for (const id of ['cart-notes', 'takeaway-schedule-toggle', 'takeaway-sched-time', 'btn-pay']) {
        const el = document.getElementById(id);
        el.focus();
        out[id] = document.activeElement === el && window.__ringed(el);
      }
      return out;
    });

    const bare = Object.entries(seen).filter(([, ok]) => !ok).map(([k]) => k);
    check('the checkout dialog’s own controls are ringed too', bare.length === 0,
          bare.join(', '));
    note('the pickup-time slider had outline:none INLINE, which no stylesheet can answer');

    // The one exception, and the reason it is one: the card is focused when its dialog
    // opens so the next Tab is inside it. Nobody chose it, so it must not be ringed.
    const card = await pg.evaluate(() => {
      const c = document.querySelector('#checkout-modal .modal-content');
      c.focus();
      return { focused: document.activeElement === c, ringed: window.__ringed(c) };
    });
    check('and the dialog card itself is focusable but not ringed',
          card.focused && !card.ringed, JSON.stringify(card));

    await ctx.close();
  }

  check('no page threw while any of that ran', threw.length === 0, threw.join(' | '));

  await browser.close();
  server.close();
  done();
})();
