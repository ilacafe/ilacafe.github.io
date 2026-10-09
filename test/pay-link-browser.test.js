// Sending a bill to a customer's WhatsApp, and the page that link opens.
//
// The bill screen's Send Pay Link was taken out with the web-order one, and the Phone No.
// box stayed behind sending nothing, so the till had no way left to bill a customer who
// was not standing in front of it. Putting it back with a upi:// link did not work:
// WhatsApp only makes http(s) links tappable, and a upi:// opened any way at all is an
// Intent to a personal VPA, which is refused after the PIN. What these checks hold:
//
// THE MESSAGE CARRIES A LINK WHATSAPP WILL MAKE TAPPABLE — https, to /pay.html — and the
// UPI ID and amount as plain text as well, and no upi:// at all.
//
// THE PAGE SHOWS A CODE THAT IS EXACTLY THAT PAYMENT, saves it to the phone (a QR picked
// from the gallery is a scan, which a personal VPA can take), and offers nothing that
// would open a UPI app from the page. It refuses a link naming a VPA the café does not
// use: the URL is written by whoever sends it.
//
// THE PAYMENT IT PRODUCES IS ONE THE TILL WILL ACCEPT. The UPI screen rolled a fresh VPA
// every time it opened, and its watcher only takes a credit from the bank that VPA
// belongs to. So the link's VPA is written onto the table, and the UPI screen opened for
// that amount uses it.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');
const jsQR = require('jsqr').default || require('jsqr');

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
// returning undefined aborts — the stub from move-table-browser.test.js, with forEach
// and distinct push keys, because the UPI watcher scans credits and the ledger pushes.
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
    hasChild: () => false, child: () => snapOf(null, null),
    forEach: (fn) => { if (v && typeof v === 'object') for (const k of Object.keys(v)) { if (fn(snapOf(v[k], k)) === true) break; } } });
  let pushed = 0;

  const mkRef = (p) => { const self = {
    key: p.split('/').filter(Boolean).pop() || null,
    child: (c) => mkRef(p + '/' + c),
    orderByChild: () => self, orderByKey: () => self, limitToLast: () => self,
    limitToFirst: () => self, startAt: () => self, endAt: () => self, equalTo: () => self,
    on: (e, cb) => { if (cb && (!e || e === 'value')) setTimeout(() => cb(snapOf(get(p), self.key)), 0); return cb; },
    off: () => {},
    once: (_e, cb) => { const s = snapOf(get(p), self.key); if (typeof cb === 'function') cb(s); return Promise.resolve(s); },
    push: (v) => { const r = mkRef(p + '/-N' + (++pushed)); if (v !== undefined) r.set(v); return r; },
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
      window.__told = []; window.__opened = []; window.__windowOpen = 0;
      window.ilaToast = (m) => { window.__told.push(String(m)); };
      window.ilaAsk = () => Promise.resolve(true);
      // The hand-off is a target=_blank link, as on a web-order card. window.open answers
      // null, which is what it does inside a home-screen app on an iPad — the tills.
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function(){
        if (this.target === '_blank' && /wa\.me/.test(this.href)) { window.__opened.push(this.href); return; }
        return click.call(this);
      };
      window.open = () => { window.__windowOpen++; return null; };
      window.__setServer({ 'pos/activeTables/5': table });
      window.activeTables = { '5': table };
      window.checkoutTableID = '5';
      window.activeUPIs = ['first@okicici', 'other@okaxis'];
      // The weighted pick is random; pin it, so "reused" and "rolled again" are distinguishable.
      window.getRandomUPI = () => 'first@okicici';
    }, TABLE());
    return { ctx, pg };
  }
  const messageOf = (url) => {
    // searchParams already undoes the one encodeURIComponent the till applied; a second
    // decode would turn the link's own %40 back into @ and hide exactly what is checked.
    try { return new URL(url).searchParams.get('text') || ''; } catch (e) { return ''; }
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
      const r = await pg.evaluate(() => ({ opened: window.__opened, told: window.__told, server: window.__getServer(), windowOpen: window.__windowOpen }));
      const url = r.opened[0] || '';
      const msg = messageOf(url);
      check('the bill screen has a Send Pay Link button',
            await pg.evaluate(() => !![...document.querySelectorAll('#checkout-modal button')].find(b => /send pay link/i.test(b.textContent))));
      check('it opens WhatsApp to the number typed on the bill',
            url.indexOf('https://wa.me/919876543210?') === 0, url || '(nothing opened)');
      check('as a new window from a link — not by navigating the till, and not on window.open\'s answer',
            r.windowOpen === 0 && await pg.evaluate(() => location.pathname === '/pos.html'),
            'window.open called ' + r.windowOpen + ' time(s)');
      const link = (msg.match(/https:\/\/\S+\/pay\.html\?\S+/) || [''])[0];
      check('the message carries an https link to the pay page — the kind WhatsApp makes tappable',
            link.indexOf('https://ila.cafe/pay.html?') === 0, msg);
      const lp = link ? new URL(link).searchParams : new URLSearchParams();
      check('and the link names this payment: the VPA, what is still due, and the table',
            lp.get('pa') === 'first@okicici' && lp.get('am') === '250' && lp.get('t') === '5', link);
      check('with the @ escaped, so WhatsApp does not end the link at it',
            link.indexOf('@') === -1, link);
      check('there is no upi:// in it — untappable in WhatsApp, refused to a personal VPA',
            msg.indexOf('upi://') === -1, msg);
      check('and the UPI ID and amount are there as plain text too',
            msg.includes('Or pay \u20b9250 to UPI ID: first@okicici'), msg);
      check('and it says what to do if WhatsApp has left the link inactive',
            /reply to this message/i.test(msg), msg);
      check('and it is itemised, with what has been paid already',
            msg.includes('2x Latte - \u20b9200') && msg.includes('1x Cake - \u20b9150') && msg.includes('Paid: \u20b9100') && msg.includes('Due: \u20b9250'), msg);

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
            again.includes('UPI ID: first@okicici') && again.includes('pa=first%40okicici') && !again.includes('other@okaxis'), again);
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

    // ------------------------------------------------------- numbers as people give them
    //
    // The field was maxlength=10, so the browser cut a typed 919876543210 to 9198765432
    // before anything could strip the prefix — a real-looking number, and a stranger got
    // the bill. The cut is a typing-time thing, so it is checked on the attribute; the
    // parsing is checked on what reaches the function.
    {
      const { ctx, pg } = await open();
      const max = await pg.evaluate(() => parseInt(document.getElementById('checkout-phone').getAttribute('maxlength') || '0'));
      check('the phone box has room for +91 and spaces, so a prefix is not cut off mid-number',
            max >= 15, 'maxlength=' + max);
      const sent = await pg.evaluate(() => {
        const out = {};
        for (const typed of ['+91 98765 43210', '919876543210', '09876543210', '98765-43210']) {
          window.__opened = [];
          document.getElementById('checkout-phone').value = typed;
          window.sendBillPayLink();
          out[typed] = (window.__opened[0] || '').split('?')[0];
        }
        for (const typed of ['98765432101', '1234567890', '9198765432101']) {
          window.__opened = []; window.__told = [];
          document.getElementById('checkout-phone').value = typed;
          window.sendBillPayLink();
          out[typed] = window.__opened.length ? window.__opened[0].split('?')[0] : 'refused:' + window.__told.join('|');
        }
        return out;
      });
      check('+91, 91, a leading 0 and dashes all reach the same customer',
            ['+91 98765 43210', '919876543210', '09876543210', '98765-43210'].every(k => sent[k] === 'https://wa.me/919876543210'),
            JSON.stringify(sent));
      check('a number that is not a 10-digit mobile is refused, not guessed at',
            ['98765432101', '1234567890', '9198765432101'].every(k => /^refused:/.test(sent[k])),
            JSON.stringify(sent));
      await ctx.close();
    }

    // ---------------------------------------- a resend after the VPA has left the list
    //
    // A monthly cap or a retired account takes a VPA out of settings/upiList, and pay.html
    // then refuses a link naming it, telling the customer to ask for a new one. A resend
    // that named the same VPA again could never succeed.
    {
      const { ctx, pg } = await open();
      const r = await pg.evaluate(() => {
        const t = JSON.parse(JSON.stringify(window.activeTables['5']));
        t.payLink = { vpa: 'capped@okicici', amount: 250, at: Date.now() - 60000 };
        window.__setServer({ 'pos/activeTables/5': t }); window.activeTables = { '5': t };
        window.activeUPIs = ['live@okaxis']; window.getRandomUPI = () => 'live@okaxis';
        document.getElementById('checkout-phone').value = '9876543210';
        window.sendBillPayLink();
        return { url: window.__opened[0] || '', stored: (window.__getServer()['pos/activeTables/5'] || {}).payLink };
      });
      const msg = messageOf(r.url);
      check('a resend after the VPA left the list names one the café still offers',
            msg.includes('pa=live%40okaxis') && msg.includes('UPI ID: live@okaxis') && !msg.includes('capped'), msg);
      check('and the table now expects that one', !!r.stored && r.stored.vpa === 'live@okaxis', JSON.stringify(r.stored));
      await ctx.close();
    }

    // -------------------------------- a resend before the first send's write has landed
    //
    // On café wifi the write can sit in the queue. The table on this screen has no payLink
    // yet, but this tab already sent one — a second roll could name a different account,
    // and the customer may pay from the first message.
    {
      const { ctx, pg } = await open();
      const r = await pg.evaluate(() => {
        window.tableUPIVPA['5'] = 'first@okicici';      // what this tab sent a moment ago
        window.getRandomUPI = () => 'other@okaxis';
        document.getElementById('checkout-phone').value = '9876543210';
        window.sendBillPayLink();
        return window.__opened[0] || '';
      });
      check('a resend before the first write lands names the VPA this tab already sent',
            messageOf(r).includes('UPI ID: first@okicici'), messageOf(r));
      await ctx.close();
    }

    // ------------------------------------------- merged into a table that is occupied
    {
      const { ctx, pg } = await open();
      const dst = await pg.evaluate(async () => {
        const t3 = { items: { Tea: { price: 100, qty: 3 } }, total: 300, paid: 0,
                     payLink: { vpa: 'first@okicici', amount: 300, at: Date.now() - 60000 } };
        const t5 = { items: { Cake: { price: 500, qty: 1 } }, total: 500, paid: 0 };
        window.__setServer({ 'pos/activeTables/3': t3, 'pos/activeTables/5': t5 });
        window.activeTables = { '3': t3, '5': t5 };
        window.checkoutTableID = '3';
        window.closeModal = () => {}; window.openCheckout = () => {};
        await window.confirmMoveTable('5');
        await new Promise(r => setTimeout(r, 300));
        return window.__getServer()['pos/activeTables/5'] || {};
      });
      check('a bill with a pay link out, merged into an occupied table, keeps the link',
            !!dst.payLink && dst.payLink.vpa === 'first@okicici' && dst.payLink.amount === 300, JSON.stringify(dst));
      await ctx.close();
    }

    // ============================================== the link's payment is its table's
    //
    // The customer pays from their seat. Nothing is on screen waiting for that credit, and
    // every claimer matches on amount, bank and time — so it used to go to whoever asked
    // first: the next ₹450 QR on any table, the web-order sweep, the late reconciler.
    // Table 2 closed as bank-verified on Table 5's money, and Table 5's diner, who had paid,
    // could never be verified.
    const LINKED = async (pg, opts) => pg.evaluate((o) => {
      const now = Date.now();
      const t5 = { items: { Latte: { price: 150, qty: 3 } }, total: 450, paid: 0 };
      const t2 = { items: { Mocha: { price: 225, qty: 2 } }, total: 450, paid: 0 };
      window.__setServer({ 'pos/activeTables/5': t5, 'pos/activeTables/2': t2, 'upiRouting/config': {} });
      window.activeTables = { '5': t5, '2': t2 };
      window.checkoutTableID = '5';
      window.getRandomUPI = () => 'first@okicici';
      document.getElementById('checkout-phone').value = '9876543210';
      window.sendBillPayLink();
      window.activeTables['5'] = window.__getServer()['pos/activeTables/5'];
      if (o.sentMinsAgo) { window.activeTables['5'].payLink.at = now - o.sentMinsAgo * 60000;
                           window.__server['pos/activeTables/5'].payLink.at = now - o.sentMinsAgo * 60000; }
      window.__server['payments/incoming'] = { c1: { amount: 450, at: now - o.paidMinsAgo * 60000, payer: 'LINK PAYER', bank: 'icici' } };
      return true;
    }, opts);
    const settled = (pg) => pg.evaluate(() => {
      const s = window.__getServer();
      return { claim: s['payments/claims/c1'] || null, t2: !!s['pos/activeTables/2'], t5: !!s['pos/activeTables/5'],
               ledger: Object.keys(s).filter(k => k.indexOf('pos/ledgerEntries/') === 0).map(k => s[k]) };
    });

    {
      const { ctx, pg } = await open();
      await LINKED(pg, { sentMinsAgo: 5, paidMinsAgo: 3 });
      await pg.evaluate(() => { window.checkoutTableID = '2'; window.getRandomUPI = () => 'other@okaxis'; window.payWithUPI(null); });
      await sleep(1500);
      let r = await settled(pg);
      check('another table’s ₹450 QR does not take a ₹450 link payment',
            !r.claim && r.t2 && !r.ledger.some(e => /Table 2/.test(e.reason || '')), JSON.stringify(r));
      await pg.evaluate(() => window.cancelUPI());

      // the counter's own fallback, on the same other table
      await pg.evaluate(() => { window.payWithUPI(null); window.confirmUPIPayment(); });
      await sleep(1500);
      r = await settled(pg);
      const t2Entry = r.ledger.find(e => /Table 2/.test(e.reason || ''));
      check('nor does marking that table received by hand — it books unverified and leaves the credit',
            !r.claim && !!t2Entry && t2Entry.state === 'unverified', JSON.stringify(r));

      // and the late reconciler, with that unverified line sitting there
      await pg.evaluate(() => {
        const s = window.__getServer();
        const map = {}; for (const k in s) if (k.indexOf('pos/ledgerEntries/') === 0) map[k.slice(18)] = s[k];
        window.salesLedgerMap = map; window._reconCredits = s['payments/incoming'];
        window._carryUnverified = {}; window._carryKnown = true;
        reconcileLedgerVerification();
      });
      await sleep(300);
      r = await settled(pg);
      check('nor does the reconciler verify that line with it while Table 5’s link is out',
            !r.claim && r.ledger.every(e => e.state !== 'verified'), JSON.stringify(r.ledger));

      // and the web-order matcher
      const web = await pg.evaluate(() => {
        const now = Date.now();
        const order = { total: 450, upiId: 'first@okicici', billedAt: now - 10 * 60000, trackId: 'T1' };
        const credits = window.__getServer()['payments/incoming'];
        const withLink = window.wvFindMatch(order, credits, {}, now);
        const saved = window.activeTables; window.activeTables = {};
        const without = window.wvFindMatch(order, credits, {}, now);
        window.activeTables = saved;
        return { withLink: withLink && withLink.ref, without: without && without.ref };
      });
      check('nor does a pending web order of the same amount',
            web.withLink === null, JSON.stringify(web));
      check('which it would take with no link out — the control', web.without === 'c1', JSON.stringify(web));

      // ...and the table it belongs to does take it
      await pg.evaluate(() => { window.checkoutTableID = '5'; window.getRandomUPI = () => 'other@okaxis'; window.payWithUPI(null); });
      await sleep(2000);
      r = await settled(pg);
      const t5Entry = r.ledger.find(e => /Table 5/.test(e.reason || ''));
      check('Table 5’s own UPI screen claims it and closes the bill verified',
            !!r.claim && !r.t5 && !!t5Entry && t5Entry.state === 'verified' && t5Entry.ref === 'c1', JSON.stringify(r));
      await ctx.close();
    }

    // ----------------------------------------- paid more than 30 minutes before anyone looked
    {
      const { ctx, pg } = await open();
      await LINKED(pg, { sentMinsAgo: 50, paidMinsAgo: 45 });
      await pg.evaluate(() => { window.checkoutTableID = '5'; window.payWithUPI(null); });
      await sleep(2000);
      const r = await settled(pg);
      check('a link paid 45 minutes ago is still taken by its own table — the link bounds it, not the clock',
            !!r.claim && !r.t5, JSON.stringify(r));
      await ctx.close();
    }

    // ------------------------------------------------- paid before the link went out
    {
      const { ctx, pg } = await open();
      await LINKED(pg, { sentMinsAgo: 10, paidMinsAgo: 20 });
      const owners = await pg.evaluate(() => window.linkTablesFor(window.__getServer()['payments/incoming'].c1));
      check('a credit from before the link was sent is not reserved for it',
            Array.isArray(owners) && owners.length === 0, JSON.stringify(owners));
      await ctx.close();
    }

    // ======================================================= the page the link opens
    //
    // The café's VPA list is the public settings/upiList, read over REST. The test answers
    // that request itself, so it can be a list, a refusal or a dead network.
    const DB_LIST = 'https://ila-cafe-default-rtdb.asia-southeast1.firebasedatabase.app/settings/upiList.json';
    async function openPay(query, answer) {
      const ctx = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
      const pg = await ctx.newPage();
      pg.on('pageerror', e => pageErrors.push('pay.html: ' + String(e.message || e).split('\n')[0]));
      await pg.route('**/*', r => {
        const u = r.request().url();
        if (u.indexOf(DB_LIST) === 0) {
          if (answer === 'offline') return r.abort();
          return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
                             body: JSON.stringify(answer) });
        }
        return u.startsWith(base) ? r.continue() : r.abort();
      });
      await pg.goto(base + '/pay.html?' + query, { waitUntil: 'load' });
      await pg.waitForTimeout(300);
      return { ctx, pg };
    }
    const decodeImg = (pg, sel) => pg.evaluate(async (sel) => {
      const img = document.querySelector(sel);
      if (!img || !img.complete || !img.naturalWidth) return null;
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      return { w: c.width, h: c.height, data: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) };
    }, sel);

    // ---------------------------------------------------------------- a real link
    {
      const LIST = ['first@okicici', 'first@okicici', 'other@okaxis'];
      const { ctx, pg } = await openPay('pa=first%40okicici&am=250&t=5', LIST);
      const r = await pg.evaluate(() => ({
        ready: !document.getElementById('pay-ready').hidden,
        vpa: document.getElementById('pay-vpa').textContent,
        amt: document.getElementById('pay-amount').textContent,
        big: document.getElementById('pay-amount-big').textContent,
        forWhat: document.getElementById('pay-for').textContent,
        upiLinks: [...document.querySelectorAll('a[href], [onclick], form[action]')].filter(e => /upi:/i.test(e.outerHTML)).length
      }));
      check('a link naming one of the café’s VPAs shows the payment', r.ready, JSON.stringify(r));
      check('with the amount and the table it is for',
            r.big === '₹250' && r.forWhat === 'Table 5', JSON.stringify({ big: r.big, forWhat: r.forWhat }));
      const shot = await decodeImg(pg, '#pay-qr');
      const out = shot && jsQR(new Uint8ClampedArray(shot.data), shot.w, shot.h);
      check('the code on screen is exactly that payment',
            !!out && out.data === 'upi://pay?pa=first@okicici&pn=ILA&am=250&cu=INR',
            out ? 'got ' + JSON.stringify(out.data) : 'no code found');
      check('and the UPI ID and amount beside it are the same payment',
            r.vpa === 'first@okicici' && r.amt === '250', JSON.stringify(r));
      check('nothing on the page offers to open a UPI app — that is refused for a personal VPA',
            r.upiLinks === 0, r.upiLinks + ' element(s)');

      // Saving the code is the one-phone route: it is scanned from the gallery.
      const [dl] = await Promise.all([
        pg.waitForEvent('download', { timeout: 5000 }).catch(() => null),
        pg.click('#pay-save')
      ]);
      check('Save puts the code on the phone as an image', !!dl && /\.png$/.test(dl.suggestedFilename()),
            dl ? dl.suggestedFilename() : 'no download');
      if (dl) {
        const file = await dl.path();
        const b64 = fs.readFileSync(file).toString('base64');
        const saved = await pg.evaluate(async (b64) => {
          const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
          const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
          const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
          return { w: c.width, h: c.height, data: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) };
        }, b64);
        const got = jsQR(new Uint8ClampedArray(saved.data), saved.w, saved.h);
        check('and the saved image scans to the same payment, caption and all',
              !!got && got.data === 'upi://pay?pa=first@okicici&pn=ILA&am=250&cu=INR',
              got ? 'got ' + JSON.stringify(got.data) : 'no code found in the saved image');
      }
      await ctx.close();
    }

    // -------------------------------------------- a fractional amount, and Takeaway
    {
      const { ctx, pg } = await openPay('pa=first%40okicici&am=1250.5&t=Takeaway', ['first@okicici']);
      const shot = await decodeImg(pg, '#pay-qr');
      const out = shot && jsQR(new Uint8ClampedArray(shot.data), shot.w, shot.h);
      check('a part-rupee amount goes into the code exactly as the till sent it',
            !!out && out.data === 'upi://pay?pa=first@okicici&pn=ILA&am=1250.5&cu=INR', out ? out.data : 'no code');
      check('and Takeaway is called Takeaway, not "Table Takeaway"',
            await pg.evaluate(() => document.getElementById('pay-for').textContent) === 'Takeaway');
      await ctx.close();
    }

    // ------------------------------------------------- a VPA that is not the café's
    //
    // Anyone can write this URL. A page on the café's own domain showing somebody
    // else's account under the café's name is the thing that must not happen.
    {
      const { ctx, pg } = await openPay('pa=someone%40ybl&am=500&t=5', ['first@okicici', 'other@okaxis']);
      const r = await pg.evaluate(() => ({
        ready: !document.getElementById('pay-ready').hidden,
        img: document.getElementById('pay-qr').getAttribute('src'),
        text: document.body.innerText
      }));
      check('a link naming a VPA the café does not use shows no code', !r.ready && !r.img, JSON.stringify({ ready: r.ready }));
      check('and does not print that VPA anywhere', r.text.indexOf('someone@ybl') === -1, r.text);
      check('and tells the customer not to pay it', /don.t pay/i.test(r.text), r.text);
      await ctx.close();
    }

    // ------------------------------------------------- the café's fallback VPA
    {
      const { ctx, pg } = await openPay('pa=sraveen.chirania-1%40okaxis&am=90&t=2', null);
      check('with no routing list set, the café’s own default VPA is still accepted',
            await pg.evaluate(() => !document.getElementById('pay-ready').hidden));
      await ctx.close();
    }

    // ------------------------------------------------------- broken and offline links
    {
      const { ctx, pg } = await openPay('pa=first%40okicici&am=abc&t=5', ['first@okicici']);
      const r = await pg.evaluate(() => ({ ready: !document.getElementById('pay-ready').hidden, text: document.body.innerText }));
      check('a link with no usable amount shows no code, and says it is incomplete',
            !r.ready && /incomplete/i.test(r.text), r.text);
      await ctx.close();
    }
    {
      const { ctx, pg } = await openPay('pa=first%40okicici&am=250&t=5', 'offline');
      const r = await pg.evaluate(() => ({ ready: !document.getElementById('pay-ready').hidden,
                                           retry: !document.getElementById('pay-retry').hidden, text: document.body.innerText }));
      check('when the link cannot be checked, no code is shown — it is not assumed to be ours',
            !r.ready, r.text);
      check('and there is a way to try again', r.retry && /connection/i.test(r.text), r.text);
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
