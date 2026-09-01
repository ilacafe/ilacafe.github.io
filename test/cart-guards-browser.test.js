// Two things about the checkout dialog on the customer's phone.
//
// EMPTY SAT NEXT TO PAY. Same row, same size, half an inch apart, and Empty deleted
// the whole cart on the first tap with nothing to undo it. The customer who hits it
// has to walk the menu again and remember what everyone at the table had chosen —
// which, for a table of four ordering together, is most of what they opened the page
// to do. It is the one irreversible control a customer can reach.
//
// A second tap inside five seconds, rather than a confirm dialog: this already IS a
// dialog, and stacking a second one over it to ask about the first is worse than the
// mistake. So the deliberate case stays two taps and no reading, and the accidental
// one costs nothing.
//
// WHICH CHOICE IS SELECTED WAS A COLOUR. Order type, sweetness and table number are
// each a row of buttons where one is filled white and the rest are outlined. Read
// aloud, that row was "Dine-in button, Takeaway button, Delivery button" — three
// identical buttons, with the answer to which one is chosen carried entirely by a
// background colour. aria-pressed is the button-shaped way to say it, and it has to
// MOVE with the choice: set once in the markup and left there, it is worse than
// absent, because it confidently names the wrong one.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Checkout — an order that is hard to lose, and a choice that is spoken');

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
                   signInAnonymously: () => Promise.resolve({ user: { uid: 'a' } }),
                   signOut: () => Promise.resolve() })
  };
})();
`;

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE) ? { executablePath: PRE } : {});
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 },
                                         isMobile: true, hasTouch: true });
  await ctx.addInitScript(STUB);
  const pg = await ctx.newPage();
  const threw = [];
  pg.on('pageerror', e => threw.push(String(e.message || e).split('\n')[0]));
  await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
  await pg.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(300);

  // ---------------------------------------------------- one tap does not empty a cart
  {
    const r = await pg.evaluate(() => {
      const btn = document.getElementById('btn-empty');
      window.cart = { 'Flat White': { price: 180, qty: 2 } };
      window.totalAmount = 360; window.totalItems = 2;
      openModal('checkout-modal');
      btn.click();
      const afterOne = { items: window.totalItems, says: btn.textContent };

      btn.click();
      const afterTwo = { items: window.totalItems, says: btn.textContent };

      return { afterOne, afterTwo };
    });

    check('one tap on Empty leaves the order alone', r.afterOne.items === 2,
          'the cart went to ' + r.afterOne.items + ' items on the first tap');
    check('and the button says what the next tap will do',
          /again/i.test(r.afterOne.says), 'it said "' + r.afterOne.says + '"');
    check('a second tap empties it', r.afterTwo.items === 0,
          'still ' + r.afterTwo.items + ' items after two taps');
    check('and the button goes back to reading Empty',
          /^empty$/i.test(r.afterTwo.says.trim()), 'it said "' + r.afterTwo.says + '"');
    note('two taps deliberately, nothing accidentally, and no dialog over a dialog');
  }

  // -------------------------------------------- and it forgets, rather than staying armed
  // An armed button left armed is a cart emptied by the first tap of whatever the
  // customer does next — which is the original bug with a delay on it.
  {
    const r = await pg.evaluate(async () => {
      const btn = document.getElementById('btn-empty');
      window.cart = { 'Cold Brew': { price: 220, qty: 1 } };
      window.totalAmount = 220; window.totalItems = 1;
      openModal('checkout-modal');

      btn.click();                       // armed
      closeModal('checkout-modal');      // and the customer backs out instead
      const disarmed = btn.textContent;

      btn.click();                       // the next tap, whenever it comes
      return { disarmed, items: window.totalItems };
    });

    check('closing the dialog disarms it', /^empty$/i.test(r.disarmed.trim()),
          'the button still said "' + r.disarmed + '"');
    check('so the next tap is a first tap again, not a delete', r.items === 1,
          'the cart was emptied by a single tap');
  }

  // ------------------------------------------------- the choice is said, not coloured
  {
    const r = await pg.evaluate(() => {
      const row = () => [...document.querySelectorAll('.type-row .type-btn')]
        .map(b => ({ id: b.id, on: b.classList.contains('selected'),
                     said: b.getAttribute('aria-pressed') }));

      window.setOrderType('Takeaway');
      const takeaway = row();
      window.setOrderType('Delivery');
      const delivery = row();

      // Sweetness, which is rebuilt every time the item dialog opens rather than
      // being toggled in place — a different code path to the same claim.
      window.selectSweetness('Very sweet', document.querySelectorAll('#sweetness-grid .choice-btn')[3]);
      const sweet = [...document.querySelectorAll('#sweetness-grid .choice-btn')]
        .map(b => ({ on: b.classList.contains('selected'), said: b.getAttribute('aria-pressed') }));

      return { takeaway, delivery, sweet };
    });

    const agrees = (list) => list.every(b => b.said === (b.on ? 'true' : 'false'));
    const oneOn  = (list) => list.filter(b => b.said === 'true').length === 1;

    check('every order-type button says whether it is the chosen one',
          agrees(r.takeaway) && agrees(r.delivery),
          JSON.stringify(r.takeaway) + ' then ' + JSON.stringify(r.delivery));
    check('and exactly one of them says yes, before and after the choice moves',
          oneOn(r.takeaway) && oneOn(r.delivery),
          JSON.stringify(r.delivery));
    check('the sweetness row says it too', agrees(r.sweet) && oneOn(r.sweet),
          JSON.stringify(r.sweet));
    note('aria-pressed that does not move with the class is worse than none —');
    note('it names the wrong button, confidently');
  }

  check('no page threw while any of that ran', threw.length === 0, threw.join(' | '));

  await browser.close();
  server.close();
  done();
})();
