// Sending a bill to a customer's WhatsApp, and getting the payment it produces verified.
//
// The bill screen's Send Pay Link was taken out with the web-order one, and the Phone No.
// box stayed behind sending nothing, so the till had no way left to bill a customer who
// was not standing in front of it. It is back, and two things about it are what these
// checks hold:
//
// THE MESSAGE HAS TO WORK WHEN THE LINK DOES NOT. WhatsApp shows a link from a number the
// customer has not saved as dead text. The UPI ID and the amount go in as plain text so a
// first-time customer can still pay.
//
// THE PAYMENT IT PRODUCES HAS TO BE ONE THE TILL WILL ACCEPT. The UPI screen rolled a
// fresh VPA every time it opened, and its watcher only takes a credit from the bank that
// VPA belongs to. A customer who paid from the link paid the VPA in the message; the roll
// often named another one, and the credit was turned away. So the link's VPA is written
// onto the table, and the UPI screen opened for that amount uses it.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Sending a pay link from the bill');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
                '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not here');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

// A database that holds state, so a transaction is applied to the CURRENT value and
// returning undefined aborts — the same stub as move-table-browser.test.js.
const STUB = `
(() => {
  window.__server = {};
  window.__setServer = (o) => { window.__server = JSON.parse(JSON.stringify(o)); };
  window.__getServer = () => JSON.parse(JSON.stringify(window.__server));
  const get = (p) => window.__server[p] === undefined ? null : JSON.parse(JSON.stringify(window.__server[p]));
  const put = (p, v) => { if (v === null) delete window.__server[p]; else window.__server[p] = JSON.parse(JSON.stringify(v)); };

  const snapOf = (v, key) => ({ key: key == null ? null : key,
    val: () => (v === undefined ? null : v), exists: () => v != null,
    numChildren: () => (v && typeof v === 'object') ? Object.keys(v).length : 0,
    hasChild: () => false, child: () => snapOf(null, null), forEach: () => {} });

  const mkRef = (p) => { const self = {
    key: p.split('/').filter(Boolean).pop() || null,
    child: (c) => mkRef(p + '/' + c),
    orderByChild: () => self, orderByKey: () => self, limitToLast: () => self,
    limitToFirst: () => self, startAt: () => self, endAt: () => self, equalTo: () => self,
    on: (e, cb) => { if (cb && (!e || e === 'value')) setTimeout(() => cb(snapOf(get(p), self.key)), 0); return cb; },
    off: () => {},
    once: (_e, cb) => { const s = snapOf(get(p), self.key); if (cb) cb(s); return Promise.resolve(s); },
    push: () => mkRef(p + '/-N'),
    set: (v) => { put(p, v); return Promise.resolve(); },
    update: (v) => {
      if (p === '') { for (const k in v) put(k.replace(/^\\/+/, ''), v[k]); return Promise.resolve(); }
      const cur = get(p) || {}; for (const k in v) cur[k] = v[k]; put(p, cur); return Promise.resolve();
    },
    remove: () => { put(p, null); return Promise.resolve(); },
    transaction: (fn, cb, _local) => {
      const cur = get(p);
      let next;
      try { next = fn(cur); } catch (e) { if (cb) cb(e, false, snapOf(cur, self.key)); return Promise.reject(e); }
      if (next === undefined) { if (cb) cb(null, false, snapOf(cur, self.key)); return Promise.resolve({ committed: false }); }
      put(p, next);
      if (cb) cb(null, true, snapOf(next, self.key));
      return Promise.resolve({ committed: true, snapshot: snapOf(next, self.key) });
    }
  }; return self; };

  const db = { ref: (p) => mkRef(String(p == null ? '' : p).replace(/^\\/+|\\/+$/g, '')),
               goOnline: () => {}, goOffline: () => {} };
  const database = () => db;
  database.ServerValue = { TIMESTAMP: 1757548800000, increment: (n) => ({ '.sv': { increment: n } }) };
  window.firebase = {
    initializeApp: () => ({}), apps: [{}], database: database,
    auth: () => ({ onAuthStateChanged: () => {}, signOut: () => Promise.resolve(),
                   currentUser: { uid: 'u1', isAnonymous: false, getIdToken: () => Promise.resolve('t') } })
  };
})();
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Two lattes and a cake, ₹100 of it already paid: ₹250 due.
const TABLE = () => ({ items: { Latte: { price: 100, qty: 2 }, Cake: { price: 150, qty: 1 } }, total: 350, paid: 100 });

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const pageErrors = [];

  async function open() {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const pg = await ctx.newPage();
    pg.on('pageerror', e => pageErrors.push(String(e.message || e).split('\n')[0]));
    await pg.addInitScript(STUB);
    await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await pg.goto(base + '/pos.html', { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(400);
    await pg.evaluate((table) => {
      window.__told = []; window.__opened = [];
      window.ilaToast = (m) => { window.__told.push(String(m)); };
      window.open = (u) => { window.__opened.push(String(u)); return {}; };
      window.__setServer({ 'pos/activeTables/5': table });
      window.activeTables = { '5': table };
      window.checkoutTableID = '5';
      // The weighted pick is random; pin it, so "reused" and "rolled again" are distinguishable.
      window.getRandomUPI = () => 'first@okicici';
    }, TABLE());
    return { ctx, pg };
  }
  const messageOf = (url) => {
    try { return decodeURIComponent(new URL(url).searchParams.get('text') || ''); } catch (e) { return ''; }
  };

  try {
    // ------------------------------------------------------------------ the message itself
    {
      const { ctx, pg } = await open();
      await pg.evaluate(() => {
        document.getElementById('checkout-phone').value = '98765 43210';
        window.sendBillPayLink();
      });
      await sleep(100);
      const r = await pg.evaluate(() => ({ opened: window.__opened, told: window.__told, server: window.__getServer() }));
      const url = r.opened[0] || '';
      const msg = messageOf(url);
      check('the bill screen has a Send Pay Link button',
            await pg.evaluate(() => !![...document.querySelectorAll('#checkout-modal button')].find(b => /send pay link/i.test(b.textContent))));
      check('it opens WhatsApp to the number typed on the bill',
            url.indexOf('https://wa.me/919876543210?') === 0, url || '(nothing opened)');
      check('the message carries a tap-to-pay link for what is still due',
            msg.includes('upi://pay?pa=first@okicici&pn=ILA&am=250.00&cu=INR'), msg);
      check('and the UPI ID and amount as plain text, for when WhatsApp will not let them tap it',
            msg.includes('Or pay ₹250 to UPI ID: first@okicici'), msg);
      check('and it is itemised, with what has been paid already',
            msg.includes('2x Latte - ₹200') && msg.includes('1x Cake - ₹150') && msg.includes('Paid: ₹100') && msg.includes('Due: ₹250'), msg);
      note('the till page itself never opens the upi:// — from a web page it is refused after the PIN');

      const t = r.server['pos/activeTables/5'] || {};
      check('the VPA it sent is written onto the table, with the amount',
            !!t.payLink && t.payLink.vpa === 'first@okicici' && t.payLink.amount === 250, JSON.stringify(t.payLink));
      check('and nothing else on the bill changes',
            t.total === 350 && t.paid === 100 && t.items && t.items.Latte && t.items.Latte.qty === 2, JSON.stringify(t));

      // ------------------------------------------- the UPI screen expects that payment
      //
      // The customer pays from the link; the cashier opens the bill and taps UPI. Make the
      // weighted pick name a different account, which is exactly when the old roll lost it.
      await pg.evaluate(() => {
        window.activeTables['5'] = window.__getServer()['pos/activeTables/5'];
        window.getRandomUPI = () => 'other@okaxis';
        window.payWithUPI(null);
      });
      const vpa = await pg.evaluate(() => window.tableUPIVPA['5']);
      check('UPI for the same amount waits on the VPA the link sent, not a fresh pick',
            vpa === 'first@okicici', vpa);
      await pg.evaluate(() => window.cancelUPI());

      await pg.evaluate(() => window.payWithUPI(100));
      const other = await pg.evaluate(() => window.tableUPIVPA['5']);
      check('a different amount — a split share — still gets the usual pick',
            other === 'other@okaxis', other);
      await pg.evaluate(() => window.cancelUPI());

      // ------------------------------------------------------------ sent a second time
      await pg.evaluate(() => { window.sendBillPayLink(); });
      await sleep(50);
      const again = messageOf(await pg.evaluate(() => window.__opened[1] || ''));
      check('a resend names the same VPA, so a customer can pay from either message',
            again.includes('pa=first@okicici') && !again.includes('other@okaxis'), again);
      await ctx.close();
    }

    // ------------------------------------------------------------------- no number typed
    {
      const { ctx, pg } = await open();
      await pg.evaluate(() => {
        document.getElementById('checkout-phone').value = '98765';
        window.sendBillPayLink();
      });
      await sleep(50);
      const r = await pg.evaluate(() => ({ opened: window.__opened, told: window.__told, server: window.__getServer() }));
      check('without a full number nothing is sent', r.opened.length === 0, r.opened.join(' '));
      check('and the cashier is told why', r.told.some(m => /number/i.test(m)), r.told.join(' | ') || '(said nothing)');
      check('and the table is not marked as billed',
            !(r.server['pos/activeTables/5'] || {}).payLink, JSON.stringify(r.server['pos/activeTables/5']));
      await ctx.close();
    }

    // -------------------------------------------- a bill closed on another till meanwhile
    //
    // This screen still shows table 5; the server has already archived it. Writing payLink
    // as a child would bring the table back with nothing on it but a payLink.
    {
      const { ctx, pg } = await open();
      await pg.evaluate(() => {
        window.__setServer({});
        document.getElementById('checkout-phone').value = '9876543210';
        window.sendBillPayLink();
      });
      await sleep(100);
      const s = await pg.evaluate(() => window.__getServer());
      check('a bill closed elsewhere stays closed — no empty table comes back',
            s['pos/activeTables/5'] === undefined && s['pos/activeTables/5/payLink'] === undefined, JSON.stringify(s));
      await ctx.close();
    }

    // ------------------------------------------------------------------ nothing owed
    {
      const { ctx, pg } = await open();
      await pg.evaluate(() => {
        const paidUp = { items: { Latte: { price: 100, qty: 1 } }, total: 100, paid: 100 };
        window.__setServer({ 'pos/activeTables/5': paidUp });
        window.activeTables = { '5': paidUp };
        document.getElementById('checkout-phone').value = '9876543210';
        window.sendBillPayLink();
      });
      await sleep(50);
      const r = await pg.evaluate(() => ({ opened: window.__opened, told: window.__told }));
      check('a bill with nothing due sends no request for money', r.opened.length === 0, r.opened.join(' '));
      await ctx.close();
    }

    check('nothing threw while any of that ran', pageErrors.length === 0,
          pageErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.close();
  }

  done();
})();
