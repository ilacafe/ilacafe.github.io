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
// THE PAYMENT IT PRODUCES IS BOOKED TO ITS OWN BILL, AND TO NO OTHER. Amount, bank and time
// cannot say whose a ₹450 is, and three designs that tried sent somebody's money to the
// wrong bill. So a link asks for the bill less a few paise, unique among the links that
// are out, and its credit names it exactly: sweepPayLinks books it to that table on its
// own, and amountFits keeps every other matcher off it — a QR pays exactly what it says,
// and nobody scanning a ₹450 code pays ₹449.63.

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
      const t = r.server['pos/activeTables/5'] || {};
      const sentAmt = t.payLink ? t.payLink.amount : NaN;
      check('the link asks for the bill less a few paise — between 1 and 49',
            sentAmt > 249.505 && sentAmt < 249.995 && Math.round(sentAmt * 100) % 100 !== 0, String(sentAmt));
      check('and the link names this payment: the VPA, that exact amount, and the table',
            lp.get('pa') === 'first@okicici' && lp.get('am') === sentAmt.toFixed(2) && lp.get('t') === '5', link);
      check('with the @ escaped, so WhatsApp does not end the link at it',
            link.indexOf('@') === -1, link);
      check('there is no upi:// in it — untappable in WhatsApp, refused to a personal VPA',
            msg.indexOf('upi://') === -1, msg);
      check('and the UPI ID and exact amount are there as plain text too',
            msg.includes('Or pay exactly \u20b9' + sentAmt.toFixed(2) + ' to UPI ID: first@okicici'), msg);
      check('saying why it is a few paise off', /how we know the payment is yours/.test(msg), msg);
      check('and it says what to do if WhatsApp has left the link inactive',
            /reply to this message/i.test(msg), msg);
      check('and it is itemised, with what has been paid already',
            msg.includes('2x Latte - \u20b9200') && msg.includes('1x Cake - \u20b9150') && msg.includes('Paid: \u20b9100') && msg.includes('Due: \u20b9250'), msg);

      check('the link is written onto the table — VPA, amount, the bill it was for, and the number',
            !!t.payLink && t.payLink.vpa === 'first@okicici' && t.payLink.sent && t.payLink.sent[0].due === 250 &&
            t.payLink.sent[0].phone === '9876543210', JSON.stringify(t.payLink));
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
      const after = await pg.evaluate(() => window.__getServer()['pos/activeTables/5'].payLink);
      check('a reminder is the same link — same VPA, same amount — so either message pays it',
            again.includes('UPI ID: first@okicici') && again.includes('am=' + sentAmt.toFixed(2)) && !again.includes('other@okaxis') &&
            after.sent.length === 1, again + ' ' + JSON.stringify(after));
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
      check('the phone box has room for any way of writing a number, so nothing is cut off mid-number',
            max >= 30, 'maxlength=' + max);
      const sent = await pg.evaluate(() => {
        const out = {};
        for (const typed of ['+91 98765 43210', '919876543210', '09876543210', '98765-43210', '+91 98 76 54 32 10', '0091 9876543210']) {
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
            ['+91 98765 43210', '919876543210', '09876543210', '98765-43210', '+91 98 76 54 32 10', '0091 9876543210'].every(k => sent[k] === 'https://wa.me/919876543210'),
            JSON.stringify(sent));
      check('a number that is not a 10-digit mobile is refused, not guessed at',
            ['98765432101', '1234567890', '9198765432101'].every(k => /^refused:/.test(sent[k])),
            JSON.stringify(sent));
      const kept = await pg.evaluate(() => {
        const out = {};
        for (const typed of ['98765432101', '+91 98765 43210']) {
          window.__setServer({});
          document.getElementById('checkout-phone').value = typed;
          archivePOSTable('5', { items: { Latte: { price: 100, qty: 1 } }, total: 100, paid: 100 }, 'Cash');
          const s = window.__getServer(); const k = Object.keys(s).find(x => x.indexOf('pos/bills/') === 0);
          out[typed] = k ? s[k].phone : 'no bill';
        }
        return out;
      });
      check('the number kept with the bill for Send Receipt is read the same way — a typo keeps none',
            kept['98765432101'] === null && kept['+91 98765 43210'] === '9876543210', JSON.stringify(kept));
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

    // ============================================ a link's payment names its own bill
    //
    // The customer pays from their seat, so nothing is on screen waiting for that credit, and
    // amount, bank and time cannot say whose a ₹450 is. Every rule that tried — reserve it,
    // offer it to staff — sent somebody's money to the wrong bill in some ordinary sequence.
    // So the link asks for an amount nobody else asks for, and these hold the two halves of
    // that: the sweep books an exact link credit to its table with nobody deciding anything,
    // and nothing else will touch a credit whose paise are not its own.
    const LINKED = async (pg, o) => pg.evaluate((o) => {
      const now = Date.now();
      const t5 = { items: { Latte: { price: 150, qty: 3 } }, total: 450, paid: 0 };
      const t2 = { items: { Mocha: { price: 225, qty: 2 } }, total: 450, paid: 0 };
      window.__setServer({ 'pos/activeTables/5': t5, 'pos/activeTables/2': t2, 'upiRouting/config': {} });
      window.activeTables = { '5': t5, '2': t2 };
      window.checkoutTableID = '5';
      window.getRandomUPI = () => 'first@okicici';
      document.getElementById('checkout-phone').value = '9876543210';
      window.sendBillPayLink();
      const sent = window.__server['pos/activeTables/5'];
      const at = now - (o.sentMinsAgo || 0) * 60000;
      sent.payLink.at = at; sent.payLink.sent.forEach(e => { e.at = at; });
      window.activeTables['5'] = JSON.parse(JSON.stringify(sent));
      const A = sent.payLink.sent[0].amount;
      const credits = {};
      (o.credits || [{ key: 'c1', exact: true, paidMinsAgo: o.paidMinsAgo, payer: o.payer }]).forEach(c => {
        credits[c.key] = { amount: c.amount != null ? c.amount : (c.exact ? A : 450),
                           at: now - (c.paidMinsAgo || 0) * 60000, payer: c.payer || 'LINK PAYER', bank: 'icici' };
      });
      window.__server['payments/incoming'] = credits;
      window._wvClaims = {}; window._linkBooking = {};
      document.getElementById('checkout-phone').value = '';
      return A;
    }, o);
    const sweep = (pg) => pg.evaluate(() => { window._wvCredits = window.__getServer()['payments/incoming']; sweepPayLinks(); });
    const state = (pg) => pg.evaluate(() => {
      const s = window.__getServer();
      const claims = {}; Object.keys(s).filter(k => k.indexOf('payments/claims/') === 0).forEach(k => { claims[k.slice(16)] = s[k]; });
      return { claims, t2: s['pos/activeTables/2'] || null, t5: s['pos/activeTables/5'] || null,
               ledger: Object.keys(s).filter(k => k.indexOf('pos/ledgerEntries/') === 0).map(k => s[k]),
               bills: Object.keys(s).filter(k => k.indexOf('pos/bills/') === 0).map(k => s[k]),
               told: window.__told.slice() };
    });
    const openUPI = (pg, table, amount) => pg.evaluate(([t, a]) => {
      window.checkoutTableID = t; window.getRandomUPI = () => 'other@okaxis';
      window.payWithUPI(a == null ? null : a);
    }, [table, amount == null ? null : amount]);

    // ------------------------------------------------------- the rule every matcher uses
    {
      const { ctx, pg } = await open();
      const r = await pg.evaluate(() => ({
        whole: window.amountFits(450, 450), near: window.amountFits(450, 449.63),
        link: window.amountFits(449.63, 450), share: window.amountFits(116.67, 116.67),
        handTyped: window.amountFits(117, 116.67), off: window.amountFits(450.4, 450), far: window.amountFits(451, 450)
      }));
      check('a whole-rupee credit fits within 50 paise, as it always has',
            r.whole && r.near && r.handTyped && !r.far, JSON.stringify(r));
      check('a credit with paise fits only its exact amount — a ₹450 code is never paid ₹449.63',
            !r.link && !r.off && r.share, JSON.stringify(r));
      await ctx.close();
    }

    // -------------------------------------------- the link is paid: it books itself
    {
      const { ctx, pg } = await open();
      const A = await LINKED(pg, { sentMinsAgo: 5, paidMinsAgo: 3 });
      // before anything books it, another table's ₹450 QR is up
      await openUPI(pg, '2');
      await sleep(1200);
      let r = await state(pg);
      check('another table’s ₹450 QR does not take a ₹' + A + ' link payment',
            !r.claims.c1 && !!r.t2, JSON.stringify(r.claims));
      await pg.evaluate(() => window.cancelUPI());
      // and the web-order matcher will not either
      const web = await pg.evaluate(() => {
        const order = { total: 450, upiId: 'first@okicici', billedAt: Date.now() - 10 * 60000, trackId: 'T1' };
        const m = window.wvFindMatch(order, window.__getServer()['payments/incoming'], {}, Date.now());
        return m && m.ref;
      });
      check('nor does a ₹450 web order billed to the same account', web === null, JSON.stringify(web));

      await sweep(pg);
      await sleep(400);
      r = await state(pg);
      const line = r.ledger.find(e => /Table 5/.test(e.reason || ''));
      check('the sweep books it to Table 5 by itself — claimed, and the bill closed',
            !!r.claims.c1 && /^link-5-/.test(r.claims.c1) && !r.t5, JSON.stringify({ claims: r.claims, t5: r.t5 }));
      check('as a bank-verified line for exactly what arrived',
            !!line && line.state === 'verified' && line.ref === 'c1' && line.amount === A && /pay link/.test(line.reason),
            JSON.stringify(line));
      check('the archived bill keeps the number the link went to, for Send Receipt',
            r.bills.length === 1 && r.bills[0].phone === '9876543210', JSON.stringify(r.bills));
      check('and the till says so', r.told.some(m => /Table 5 paid/.test(m) && /LINK PAYER/.test(m)), r.told.join(' | '));
      await ctx.close();
    }

    // ------------------------------- a walk-in's ₹450.00 while the link is out is the walk-in's
    {
      const { ctx, pg } = await open();
      await LINKED(pg, { sentMinsAgo: 5, credits: [{ key: 'cw', amount: 450, paidMinsAgo: 1, payer: 'WALK IN' }] });
      await sweep(pg);
      await sleep(300);
      let r = await state(pg);
      check('the sweep does not book a whole-rupee ₹450 to Table 5’s link',
            !r.claims.cw && !!r.t5, JSON.stringify(r.claims));
      await openUPI(pg, '2');
      await sleep(2000);
      r = await state(pg);
      const line = r.ledger.find(e => /Table 2/.test(e.reason || ''));
      check('and the walk-in’s own QR takes it, exactly as before pay links existed',
            !!r.claims.cw && !r.t2 && !!line && line.state === 'verified' && line.ref === 'cw', JSON.stringify(r));
      check('with Table 5’s link still out', !!r.t5 && !!r.t5.payLink, JSON.stringify(r.t5));
      const web = await pg.evaluate(() => {
        const order = { total: 450, upiId: 'first@okicici', billedAt: Date.now() - 10 * 60000, trackId: 'T1' };
        const credits = { cw2: { amount: 450, at: Date.now() - 60000, bank: 'icici' } };
        const m = window.wvFindMatch(order, credits, {}, Date.now());
        return m && m.ref;
      });
      check('and a ₹450 web order is not held up by the link either', web === 'cw2', JSON.stringify(web));
      await ctx.close();
    }

    // ------------------------------------- more was ordered after the link went out
    {
      const { ctx, pg } = await open();
      const A = await LINKED(pg, { sentMinsAgo: 5, paidMinsAgo: 2 });
      await pg.evaluate(() => {
        const t5 = window.__server['pos/activeTables/5'];
        t5.items.Cake = { price: 150, qty: 1 }; t5.total = 600;
        window.activeTables['5'] = JSON.parse(JSON.stringify(t5));
      });
      await sweep(pg);
      await sleep(400);
      const r = await state(pg);
      check('a link paid after the bill grew is booked as a part payment, and the table stays open',
            !!r.claims.c1 && !!r.t5 && Math.abs(r.t5.paid - A) < 0.001, JSON.stringify(r.t5));
      check('with that link taken off it', !r.t5.payLink, JSON.stringify(r.t5.payLink));
      await ctx.close();
    }

    // ------------------------------------------- two tills hear the same credit, or two arrive
    //
    // The bill has grown, so the table stays open after the link is paid — the case where a
    // second booking would land rather than abort on a closed table.
    {
      const { ctx, pg } = await open();
      const A = await LINKED(pg, { sentMinsAgo: 5, credits: [{ key: 'c1', exact: true, paidMinsAgo: 2 }, { key: 'c2', exact: true, paidMinsAgo: 1 }] });
      await pg.evaluate(() => {
        const t5 = window.__server['pos/activeTables/5'];
        t5.items.Cake = { price: 150, qty: 1 }; t5.total = 600;
        window.activeTables['5'] = JSON.parse(JSON.stringify(t5));
        // a second till that has not heard of the first one's booking yet
        window._wvCredits = window.__getServer()['payments/incoming'];
        sweepPayLinks(); window._linkBooking = {}; window._wvClaims = {}; sweepPayLinks();
      });
      await sleep(500);
      const r = await state(pg);
      const booked = r.ledger.filter(e => e.ref === 'c1' || e.ref === 'c2');
      check('a link is booked once, however many tills hear it',
            booked.length === 1 && Math.abs(r.t5.paid - A) < 0.001, JSON.stringify({ ledger: r.ledger, paid: r.t5 && r.t5.paid }));
      check('and a second payment of the same link is left unclaimed, to be seen and refunded',
            Object.keys(r.claims).length === 1, JSON.stringify(r.claims));
      await ctx.close();
    }

    // -------------------------------------------- the table closed on another till meanwhile
    {
      const { ctx, pg } = await open();
      await LINKED(pg, { sentMinsAgo: 5, paidMinsAgo: 2 });
      await pg.evaluate(() => { delete window.__server['pos/activeTables/5']; });   // this till still shows it
      await sweep(pg);
      await sleep(400);
      const r = await state(pg);
      check('if the table closed in between, the claim is given back and nothing is booked',
            !r.claims.c1 && r.ledger.length === 0, JSON.stringify(r));
      await ctx.close();
    }

    // ------------------------------------------ settled by hand while the link was out
    {
      const { ctx, pg } = await open();
      const A = await LINKED(pg, { sentMinsAgo: 5, credits: [] });
      const asked = await pg.evaluate(async () => {
        const said = [];
        window.ilaAsk = (t, d) => { said.push(t + ' :: ' + d); return Promise.resolve(true); };
        window.checkoutTableID = '5'; window.payWithUPI(null);
        await window.confirmUPIPayment();
        await new Promise(r => setTimeout(r, 1200));
        return said;
      });
      let r = await state(pg);
      check('marking it received by hand says the link will book itself',
            asked.length === 1 && /pay link for/i.test(asked[0]) && /book itself/.test(asked[0]), asked.join(' | '));
      const line = r.ledger.find(e => /Table 5/.test(e.reason || ''));
      check('and if they go ahead, the line remembers the link that was out',
            !!line && line.state === 'unverified' && Array.isArray(line.linkAmounts) && line.linkAmounts[0] === A && !r.t5,
            JSON.stringify(line));
      // ...and the link's own alert lands late
      await pg.evaluate((A) => {
        const now = Date.now();
        window.__server['payments/incoming'] = { late: { amount: A, at: now - 60000, payer: 'LINK PAYER', bank: 'icici' } };
        window.activeTables = { '2': window.__getServer()['pos/activeTables/2'] };
      }, A);
      await openUPI(pg, '2');
      await sleep(1200);
      r = await state(pg);
      check('no other ₹450 QR takes the late link payment', !r.claims.late && !!r.t2, JSON.stringify(r.claims));
      await pg.evaluate(() => window.cancelUPI());
      const v = await pg.evaluate(() => {
        const s = window.__getServer();
        const map = {}; for (const k in s) if (k.indexOf('pos/ledgerEntries/') === 0 && k.split('/').length === 3) map[k.slice(18)] = Object.assign({}, s[k], { ts: Date.now() - 120000 });
        window.salesLedgerMap = map; window._reconCredits = s['payments/incoming'];
        window._carryUnverified = {}; window._carryKnown = true;
        reconcileLedgerVerification();
        const after = window.__getServer();
        return Object.keys(after).filter(k => /^pos\/ledgerEntries\/[^/]+\/state$/.test(k)).map(k => after[k] + ':' + (after[k.replace(/state$/, 'ref')] || ''));
      });
      check('the reconciler pairs it with the line that was settled by hand', v.join() === 'verified:late', JSON.stringify(v));
      await ctx.close();
    }

    // ---------------------------------------------------- the reconciler, otherwise unchanged
    {
      const { ctx, pg } = await open();
      await LINKED(pg, { sentMinsAgo: 5, credits: [
        { key: 'cdup', amount: 450, paidMinsAgo: 30 }, { key: 'cw', amount: 450, paidMinsAgo: 2 }, { key: 'c1', exact: true, paidMinsAgo: 1 } ] });
      const v = await pg.evaluate(() => {
        window.salesLedgerMap = { EW: { type: 'upi_income', state: 'unverified', amount: 450, ts: Date.now() - 60000, reason: 'Table 2 (UPI)', payId: 'pay-EW' } };
        window._reconCredits = window.__getServer()['payments/incoming'];
        window._carryUnverified = {}; window._carryKnown = true;
        reconcileLedgerVerification();
        const s = window.__getServer();
        return { state: s['pos/ledgerEntries/EW/state'] || null, ref: s['pos/ledgerEntries/EW/ref'] || null };
      });
      check('one ₹450 line and two whole-rupee ₹450 credits stays ambiguous, link or no link',
            v.state === null, JSON.stringify(v));
      await ctx.close();
    }

    // ----------------------------------------------------- paid before the link went out
    {
      const { ctx, pg } = await open();
      await LINKED(pg, { sentMinsAgo: 10, paidMinsAgo: 20 });
      const hits = await pg.evaluate(() => window.linkTablesFor(window.__getServer()['payments/incoming'].c1));
      check('a credit from before the link was sent is not that link’s', Array.isArray(hits) && hits.length === 0, JSON.stringify(hits));
      await ctx.close();
    }

    // ------------------------------------------ a whole-rupee link from before this change
    //
    // A table open when this shipped may hold a link sent under the old rule, for ₹450 flat.
    // That amount names nobody; a ₹450.00 credit is not that link's to take.
    {
      const { ctx, pg } = await open();
      await pg.evaluate(() => {
        const now = Date.now();
        const t5 = { items: { Latte: { price: 150, qty: 3 } }, total: 450, paid: 0,
                     payLink: { vpa: 'first@okicici', amount: 450, at: now - 600000,
                                sent: [{ vpa: 'first@okicici', amount: 450, at: now - 600000 }] } };
        window.__setServer({ 'pos/activeTables/5': t5, 'payments/incoming': { cw: { amount: 450, at: now - 60000, bank: 'icici' } } });
        window.activeTables = { '5': JSON.parse(JSON.stringify(t5)) };
        window._wvClaims = {}; window._linkBooking = {};
        window._wvCredits = window.__getServer()['payments/incoming'];
        sweepPayLinks();
      });
      await sleep(300);
      const r = await state(pg);
      check('a whole-rupee link sent before this change books nothing on its own',
            !r.claims.cw && !!r.t5 && r.ledger.length === 0, JSON.stringify(r.claims));
      await ctx.close();
    }

    // --------------------------------------------- two links out at once never share an amount
    {
      const { ctx, pg } = await open();
      const amts = await pg.evaluate(() => {
        const out = [];
        window.__setServer({}); window.activeTables = {};
        for (const id of ['1', '2', '3', '4', '5', '6']) {
          const t = { items: { Latte: { price: 150, qty: 3 } }, total: 450, paid: 0 };
          window.__server['pos/activeTables/' + id] = t; window.activeTables[id] = JSON.parse(JSON.stringify(t));
          window.checkoutTableID = id; document.getElementById('checkout-phone').value = '9876543210';
          window.sendBillPayLink();
          window.activeTables[id] = window.__getServer()['pos/activeTables/' + id];
          out.push(window.activeTables[id].payLink.amount);
        }
        return out;
      });
      check('six ₹450 links out at once ask for six different amounts',
            new Set(amts.map(a => a.toFixed(2))).size === 6 && amts.every(a => a > 449.5 && a < 450), JSON.stringify(amts));
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
