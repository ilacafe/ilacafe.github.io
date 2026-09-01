// A prepaid web order has to arrive at the till already BILLED.
//
// The customer's phone now collects the payment: it draws the café's UPI code on
// the ordering page for a second device to scan. Which means the phone is also
// what decides which of the café's accounts the money goes to, and when the
// customer was asked — and it writes both onto the order, in the same push that
// creates it, because under the database rules an anonymous browser may create an
// order and never touch it again.
//
// Those two fields are the whole of what makes a web payment verifiable. The till's
// matcher refuses an order carrying neither: without them it would match a bank
// credit on amount alone and could book money that belongs to another bill. So if
// this write regresses, nothing announces it — orders keep being placed, customers
// keep paying, and every one of them silently stops auto-verifying.
//
// So this drives the real page: a real cart, the page's own checkout, and a stub
// that records what it was asked to write.
//
// Run with `npm run test:browser`.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const jsQR = require('jsqr').default || require('jsqr');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('A web order arrives billed — the VPA, and when it was asked');

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

// A path-aware stub. Unlike the other browser suites' no-op version this one
// answers reads from a table and RECORDS writes, because what is under test is
// what the page asks the database to store.
//
// TIMESTAMP is the real sentinel Firebase sends rather than a number, so the
// suite can tell a server clock from the phone's. That distinction matters here:
// the till compares payLinkSentAt against the times on bank credits, and a phone
// with a wrong clock would put the order outside its own payment window.
const STUB = `
(() => {
  const DATA = {
    'settings/upiList': ['ila.one@okaxis', 'ila.two@okhdfcbank', 'ila.one@okaxis'],
    'settings/storeStatus': { delivery: true, takeaway: true },
    'settings/isOpen': true
  };
  window.__DATA = DATA;
  window.__writes = [];
  window.__handlers = {};
  const snap = (o) => ({ val: () => (o === undefined ? null : o), exists: () => o != null,
                         numChildren: () => 0, forEach: () => {}, key: null });
  window.__emit = (p) => (window.__handlers[p] || []).forEach(cb => { try { cb(snap(DATA[p])); } catch (e) {} });
  const mk = (p) => { const s = {
    key: 'k', child: (c) => mk(p + '/' + c),
    orderByChild: () => s, orderByKey: () => s, limitToLast: () => s, limitToFirst: () => s,
    startAt: () => s, endAt: () => s, equalTo: () => s,
    on: (_e, cb) => { (window.__handlers[p] = window.__handlers[p] || []).push(cb);
                      try { if (cb) cb(snap(DATA[p])); } catch (e) {} return cb; },
    off: () => {},
    once: (_e, cb) => { const x = snap(DATA[p]); if (cb) cb(x); return Promise.resolve(x); },
    push: (v) => { if (v !== undefined) window.__writes.push({ op: 'push', path: p, value: v }); return mk(p + '/-new'); },
    set: (v) => { window.__writes.push({ op: 'set', path: p, value: v }); return Promise.resolve(); },
    update: (v) => { window.__writes.push({ op: 'update', path: p, value: v }); return Promise.resolve(); },
    remove: () => Promise.resolve(),
    transaction: (_f, cb) => { const x = snap(null); if (cb) cb(null, false, x);
                               return Promise.resolve({ committed: false, snapshot: x }); }
  }; return s; };
  const database = () => ({ ref: (p) => mk(p || ''), goOnline: () => {}, goOffline: () => {} });
  database.ServerValue = { TIMESTAMP: { '.sv': 'timestamp' }, increment: (n) => ({ '.sv': { increment: n } }) };
  window.firebase = {
    initializeApp: () => ({}), apps: [], database: database,
    auth: () => ({ currentUser: { uid: 'a' }, onAuthStateChanged: () => () => {},
                   signInAnonymously: () => Promise.resolve({ user: { uid: 'a' } }),
                   signOut: () => Promise.resolve() })
  };
})();
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE) ? { executablePath: PRE } : {});
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 },
                                         deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript(STUB);
  const pg = await ctx.newPage();
  const threw = [];
  pg.on('pageerror', e => threw.push(String(e.message || e).split('\n')[0]));
  await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());

  // A fresh page with nothing carried over. localStorage survives a reload on the
  // same origin, and this page deliberately remembers an order between opens — so
  // without this each scenario would inherit the previous one's.
  const fresh = async () => {
    await pg.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
    await pg.evaluate(() => localStorage.clear());
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(350);
  };

  // The page's own checkout, from a cart, through the phone step, to the code.
  // The order is written inside a promise (anonymous sign-in resolves first), so
  // the read has to come after it rather than in the same tick.
  const place = async (t) => pg.evaluate(async (type) => {
    window.__writes.length = 0;
    window.cart = { 'Flat White': { price: 180, qty: 2 } };
    window.totalAmount = 360; window.totalItems = 2;
    window.currentOrderType = type;
    window.currentDineInTable = '4';                     // only read for dine-in
    window.proceedToPayment();
    if (type !== 'Dine-in'){
      document.getElementById('cust-phone').value = '9990001111';
      window.startPayment();
    }
    await new Promise(r => setTimeout(r, 120));
    const pushed = window.__writes.filter(w => w.op === 'push' && w.path === 'orders/pendingWeb');
    const canvas = document.getElementById('cust-qr');
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    return {
      record: pushed.length === 1 ? pushed[0].value : null,
      pushes: pushed.length,
      payStep: document.getElementById('pay-step-pay').style.display,
      vpaShown: document.getElementById('cust-upi-id').textContent,
      amtShown: document.getElementById('cust-upi-amount').textContent,
      detail: document.getElementById('status-detail').textContent,
      stored: localStorage.getItem('ila_pay'),
      qr: { w: canvas.width, h: canvas.height, data: Array.from(d.data) }
    };
  }, t);

  const order = async (type) => { await fresh(); return place(type); };

  // ------------------------------------------------------------ takeaway: prepaid
  {
    const r = await order('Takeaway');
    const rec = r.record || {};
    check('one order is written, and it is written once', r.pushes === 1, r.pushes + ' push(es)');
    check('it carries a VPA off the café’s routing list',
          ['ila.one@okaxis', 'ila.two@okhdfcbank'].includes(rec.upiId), 'upiId was ' + JSON.stringify(rec.upiId));
    check('and the moment the customer was asked, on the SERVER’s clock',
          !!rec.payLinkSentAt && rec.payLinkSentAt['.sv'] === 'timestamp',
          JSON.stringify(rec.payLinkSentAt));
    note('a phone with a wrong clock would put its own order outside its payment window');
    check('both in the same write — nothing may be added to the order afterwards',
          r.pushes === 1 && !!rec.upiId && !!rec.payLinkSentAt);
    note('the rules let an anonymous browser create an order and never touch it again');

    check('the code is on screen', r.payStep === 'block', 'display: ' + r.payStep);
    const out = jsQR(new Uint8ClampedArray(r.qr.data), r.qr.w, r.qr.h);
    check('and it is a code for the VPA and total that were written',
          !!out && out.data === 'upi://pay?pa=' + rec.upiId + '&pn=ILA&am=' + rec.total + '&cu=INR',
          out ? 'got ' + JSON.stringify(out.data) : 'no code found');
    check('the ID printed for anyone with one phone is that same VPA',
          r.vpaShown === rec.upiId && r.amtShown === String(rec.total),
          JSON.stringify({ id: r.vpaShown, amt: r.amtShown }));

    let stored = null; try { stored = JSON.parse(r.stored); } catch (e) {}
    check('and the code is remembered, so closing the screen does not strand the order',
          !!stored && stored.vpa === rec.upiId && stored.amount === rec.total,
          JSON.stringify(stored));
  }

  // ---------------------------------------------- dine-in: settles at the table
  // A second code here would take money the table's own bill would never know
  // about, and the customer would be asked for it twice.
  {
    const r = await order('Dine-in');
    const rec = r.record || {};
    check('a dine-in order is written', r.pushes === 1, r.pushes + ' push(es)');
    check('and is billed by nothing here',
          !rec.upiId && !rec.payLinkSentAt, JSON.stringify({ upiId: rec.upiId, sent: rec.payLinkSentAt }));
    check('no code is shown for it', r.payStep === 'none', 'display: ' + r.payStep);
    check('and it says to pay at the table', /at your table/i.test(r.detail), r.detail);
    check('nothing is remembered to bring a code back to', r.stored === null, String(r.stored));
  }

  // ------------------------------------------- a routing list that cannot be used
  // settings/upiList is world-readable and staff-writable, and whatever is in it
  // ends up inside a upi:// query string a customer is asked to pay. An entry with
  // an & or a space in it would quietly change what that string says.
  {
    await fresh();
    await pg.evaluate(() => {
      window.__DATA['settings/upiList'] = ['not a vpa', 'x@y&pa=attacker@ybl', '', 'ila@ok axis'];
      window.__emit('settings/upiList');
    });
    const placed = await place('Takeaway');
    const r = { upiId: (placed.record || {}).upiId, qr: placed.qr };
    check('a malformed entry is never billed to',
          !!r.upiId && /^[a-zA-Z0-9][a-zA-Z0-9._-]*@[a-zA-Z][a-zA-Z0-9.-]*$/.test(r.upiId),
          'billed to ' + JSON.stringify(r.upiId));
    const out = jsQR(new Uint8ClampedArray(r.qr.data), r.qr.w, r.qr.h);
    check('and the code names one payee, not a second one smuggled into the query',
          !!out && (out.data.match(/[?&]pa=/g) || []).length === 1 &&
                   out.data === 'upi://pay?pa=' + r.upiId + '&pn=ILA&am=360&cu=INR',
          out ? 'got ' + JSON.stringify(out.data) : 'no code found');
    note('the café’s own ID is the fallback — a code that pays us, or none');
  }

  // ------------------------------------------------ the code goes when the money lands
  {
    await fresh();
    await place('Takeaway');
    const r = await pg.evaluate(() => {
      const before = { step: document.getElementById('pay-step-pay').style.display,
                       stored: localStorage.getItem('ila_pay') !== null };
      // the till books the credit against the order
      const trackId = localStorage.getItem('ila_track_id');
      window.__DATA['orders/track/' + trackId] = { status: 'received', paymentVerified: true };
      window.__emit('orders/track/' + trackId);
      return { before, after: { step: document.getElementById('pay-step-pay').style.display,
                                stored: localStorage.getItem('ila_pay') !== null,
                                title: document.getElementById('status-title').textContent } };
    });
    check('the code is up while the payment is owed',
          r.before.step === 'block' && r.before.stored, JSON.stringify(r.before));
    check('and it is gone the moment the payment is confirmed',
          r.after.step === 'none' && !r.after.stored, JSON.stringify(r.after));
    check('with the screen saying so', /confirmed/i.test(r.after.title), r.after.title);
    note('a code still offered to someone who has paid is an invitation to pay twice');
  }

  check('the page threw nothing while any of that ran', threw.length === 0, threw.slice(0, 3).join(' | '));

  done();
  await browser.close();
  server.close();
})().catch((e) => { server.close(); console.error(e); process.exit(1); });
