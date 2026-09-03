// Nothing is made before the money is confirmed — driven through the real till.
//
// Takeaway and delivery are prepaid. There is no table to settle at afterwards, so
// an order that is cooked and never paid for is the food, gone. The till used to ask
// about that with a confirmation box: "Payment for this order is NOT yet verified.
// Start preparing anyway?" — with an OK on it, in front of a queue.
//
// A box in the way of a queue gets cleared. That is not a criticism of anyone on the
// counter; it is what a dismissible warning IS, and it is why this is now a refusal
// with two named ways past it rather than a question with a default.
//
// So the thing worth testing is not the wording. It is whether the till can be talked
// into dispatching an unconfirmed order at all — which is why every dialog in this
// suite answers YES to everything. Under the old code that was enough to start the
// kitchen. If it is ever enough again, these checks fail.
//
// It runs in a browser against the real page for the same reason the cash-up suite
// does: acceptWebOrder is a long async function with several awaits in it, and what
// is under test is what it ends up WRITING.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Prepaid web orders — the kitchen waits for the money');

// The PIN salt comes out of the page rather than being copied, so changing it fails
// here loudly instead of leaving a suite that confirms payments with nothing.
const POS_SRC = fs.readFileSync(path.join(ROOT, 'pos.html'), 'utf8');
const saltMatch = /const PIN_SALT = "([^"]+)"/.exec(POS_SRC);
if (!saltMatch) throw new Error('PIN_SALT not found in pos.html — this suite confirms a payment with it');
const PIN = '4821';
const PIN_HASH = crypto.createHash('sha256').update(saltMatch[1] + PIN).digest('hex');

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

const NOW = 1756200000000;

// Every write is reported out of the page as it happens, and every question is
// answered with the most permissive answer available.
const STUB = `
(() => {
  const out = (kind, data) => { try { window.__ila(kind, data); } catch (e) {} };
  const record = (op, p, v) => {
    let value = null;
    try { value = v === undefined ? null : JSON.parse(JSON.stringify(v)); } catch (e) { value = '[unserialisable]'; }
    out('op', { op: op, path: p, value: value });
    return Promise.resolve();
  };
  const snapOf = (o) => ({ key: null, val: () => (o === undefined ? null : o),
                           exists: () => o != null, numChildren: () => 0,
                           hasChild: () => false, child: () => snapOf(null), forEach: () => {} });
  const mkRef = (p) => {
    const self = {
      key: p.split('/').filter(Boolean).pop() || null,
      toString: () => 'stub://' + p,
      child: (c) => mkRef(p + '/' + c),
      orderByChild: () => self, orderByKey: () => self, limitToLast: () => self,
      limitToFirst: () => self, startAt: () => self, endAt: () => self, equalTo: () => self,
      on: (_e, cb) => cb, off: () => {},
      once: (_e, cb) => { const s = snapOf(null); if (cb) cb(s); return Promise.resolve(s); },
      push: (v) => { if (v !== undefined) record('push', p, v); return mkRef(p + '/-Nstub'); },
      set: (v) => record('set', p, v),
      update: (v) => record('update', p, v),
      remove: () => record('remove', p, null),
      transaction: (_fn, cb) => { const s = snapOf(null); if (cb) cb(null, false, s); return Promise.resolve({ committed: false, snapshot: s }); }
    };
    return self;
  };
  const db = { ref: (p) => mkRef(String(p == null ? '' : p).replace(/^\\/+|\\/+$/g, '')),
               goOnline: () => {}, goOffline: () => {} };
  const database = () => db;
  database.ServerValue = { TIMESTAMP: ${NOW}, increment: (n) => ({ '.sv': { increment: n } }) };
  window.firebase = {
    initializeApp: () => ({}), apps: [], database: database,
    auth: () => ({ onAuthStateChanged: () => {}, signOut: () => Promise.resolve(),
                   currentUser: { uid: 'u1', getIdToken: () => Promise.resolve('stub-id-token') } })
  };

  // EVERY QUESTION IS ANSWERED YES.
  //
  // That is the point of the suite, not a convenience: a gate that a dialog can talk
  // its way through is the gate that was here before. Stubbed after load, for the
  // same reason the cash-up suite does it — this is an init script, and /dialogs.js
  // would put the real overlays straight back over the top.
  window.__stubDialogs = () => {
    window.ilaToast = (m) => { out('dialog', { kind: 'toast', text: String(m) }); };
    window.ilaTell = (t, d) => { out('dialog', { kind: 'tell', text: String(t) + (d ? ' ' + d : '') }); return Promise.resolve(); };
    window.ilaAsk = (t, d) => { out('dialog', { kind: 'ask', text: String(t) + (d ? ' ' + d : '') }); return Promise.resolve(true); };
    window.ilaAskText = (t, d) => { out('dialog', { kind: 'asktext', text: String(t) + (d ? ' ' + d : '') }); return Promise.resolve(window.__pin); };
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('workers.dev') !== -1) {
      out('push', { body: String((init && init.body) || '') });
      return Promise.resolve(new Response('ok', { status: 200 }));
    }
    return realFetch(input, init);
  };
})();
`;

// A till with a menu loaded and nothing else going on. The menu prices match what the
// orders were placed at, so the repricing confirmation never opens and what happens
// next is only ever about the money.
const SEED = `
  window.staffPins = { ${JSON.stringify(PIN_HASH)}: 'Priya' };
  window.itemPriceMap = { 'Filter Coffee': 120, 'Croissant': 180 };
  window.itemRoutingMap = { 'Filter Coffee': 'barista', 'Croissant': 'chef' };
  window.activeTables = {}; window.pastBills = []; window.salesLedger = [];
  window._wvCredits = {}; window._wvClaims = {}; window._wvMatch = {}; window._wvBooking = {};
  window.__pin = ${JSON.stringify(PIN)};
`;

const ITEMS = { 'Filter Coffee': { qty: 2, price: 120 }, 'Croissant': { qty: 1, price: 180 } };
const TOTAL = 420;
const ORDER = (extra) => Object.assign({
  orderType: 'Takeaway', tableOrAddress: 'Takeaway — Anil', items: JSON.parse(JSON.stringify(ITEMS)),
  total: TOTAL, gated: true, phone: '9990001111', upiId: 'sraveen.chirania-1@okaxis',
  trackId: 'tk-anil', billedAt: NOW - 4 * 60000, createdAt: NOW - 5 * 60000
}, extra);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const pageErrors = [];

  async function till(orders) {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const seen = { ops: [], dialogs: [], pushes: [] };
    page.on('pageerror', e => pageErrors.push(String(e.message || e).split('\n')[0]));
    await page.exposeFunction('__ila', (kind, data) => {
      if (kind === 'op') seen.ops.push(data);
      else if (kind === 'dialog') seen.dialogs.push(data);
      else if (kind === 'push') seen.pushes.push(data.body);
    });
    await page.addInitScript(STUB);
    await page.route('**/*', route =>
      route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base + '/pos.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    await page.evaluate(([seed, os]) => {
      window.__stubDialogs();                    // after /dialogs.js, not before it
      (0, eval)(seed);
      window.pendingWebOrders = os;
    }, [SEED, orders]);
    return { ctx, page, seen };
  }

  const dispatched = (seen) => seen.ops.filter(o => o.path.indexOf('orders/active/') === 0);
  // A ledger line and the total it moves go in ONE root-level multi-path update, so the
  // line is not a write to a path — it is a KEY inside one. Reading it any other way
  // makes a check that passes because it never found anything.
  const ledgerLines = (seen) => {
    const out = [];
    seen.ops.forEach(o => {
      if (o.op !== 'update' || !o.value || typeof o.value !== 'object') return;
      Object.keys(o.value).forEach(k => { if (k.indexOf('pos/ledgerEntries/') === 0) out.push(o.value[k]); });
    });
    return out;
  };
  const trail = (seen) => seen.ops.map(o => o.op + ' ' + o.path).join(', ') || '(nothing written)';
  const said = (seen) => seen.dialogs.map(d => d.text).join('\n');

  try {
    // --------------------------------------- an unconfirmed order does not start
    {
      const { ctx, page, seen } = await till({ o1: ORDER() });
      await page.evaluate(() => window.openWebOrders());
      await sleep(200);

      const card = await page.evaluate(() => ({
        accept: (() => { const b = document.getElementById('acc-o1'); return b ? { disabled: b.disabled } : null; })(),
        badge: (document.getElementById('wv-o1') || {}).textContent || '',
        offer: (document.getElementById('pay-o1') || {}).textContent || ''
      }));
      check('an order whose money has not arrived cannot be accepted from the card',
            !!card.accept && card.accept.disabled === true, JSON.stringify(card.accept));
      check('and the badge says so rather than leaving it to be inferred',
            /unpaid/i.test(card.badge), JSON.stringify(card.badge));

      // A refusal with no way out is a queue that stops. The way out is on the card,
      // under the button it disabled, and it is the one that gets recorded.
      check('and the way past it is offered right there',
            /payment received/i.test(card.offer), JSON.stringify(card.offer));

      await page.evaluate(() => window.acceptWebOrder('o1'));
      await sleep(400);
      check('and pressing Accept anyway dispatches nothing to the kitchen',
            dispatched(seen).length === 0, trail(seen));
      note('every dialog in this suite answers yes — under the old confirm() that was enough');
      check('nor is the order taken off the pending list',
            !seen.ops.some(o => o.op === 'remove' && o.path === 'orders/pendingWeb/o1'), trail(seen));
      check('nor is anything written to the books',
            ledgerLines(seen).length === 0, JSON.stringify(ledgerLines(seen)));
      check('and the till says why, and what to do about it',
            /payment received/i.test(said(seen)), said(seen));
      await ctx.close();
    }

    // ------------------------------------------ a bank credit releases it, as always
    {
      const { ctx, page, seen } = await till({ o1: ORDER({ payment: { ref: '512345', amount: TOTAL, at: NOW } }) });
      await page.evaluate(() => window.acceptWebOrder('o1'));
      await sleep(400);
      check('an order the bank has confirmed goes to the kitchen',
            dispatched(seen).length > 0, trail(seen));
      check('and is not booked a second time — the credit booked it when it matched',
            ledgerLines(seen).length === 0, JSON.stringify(ledgerLines(seen)));
      await ctx.close();
    }

    // ----------------------------------- a person confirming it releases it too
    {
      const { ctx, page, seen } = await till({ o1: ORDER() });
      await page.evaluate(() => window.openWebOrders());
      await sleep(150);
      await page.evaluate(() => window.markWebOrderPaid('o1'));
      await sleep(400);

      const wrote = seen.ops.find(o => o.path === 'orders/pendingWeb/o1/manualPaid');
      check('a confirmation by hand is recorded against the order',
            !!wrote, trail(seen));
      check('with the name of whoever gave it, not just that somebody did',
            !!wrote && wrote.value && wrote.value.by === 'Priya', JSON.stringify(wrote && wrote.value));
      check('and where it was given, so a phone and a counter are told apart',
            !!wrote && wrote.value && wrote.value.via === 'pos', JSON.stringify(wrote && wrote.value));

      // The customer has spent the wait on a screen still asking them to pay for
      // something they have already paid for. It watches this and nothing else.
      const toldPhone = seen.ops.find(o => o.path === 'orders/track/tk-anil/paymentVerified');
      check('and the customer’s phone is told the payment is in',
            !!toldPhone && toldPhone.value === true, trail(seen));

      // Now the same order, released.
      await page.evaluate(() => {
        window.pendingWebOrders.o1.manualPaid = { by: 'Priya', at: Date.now(), via: 'pos' };
        window.renderWebVerifyBadges();
      });
      const after = await page.evaluate(() => ({
        disabled: (document.getElementById('acc-o1') || {}).disabled,
        badge: (document.getElementById('wv-o1') || {}).textContent || ''
      }));
      check('the order can be accepted once it has been confirmed', after.disabled === false,
            JSON.stringify(after));
      check('and the badge names who confirmed it, so there is someone to ask',
            /Priya/.test(after.badge), JSON.stringify(after.badge));

      await page.evaluate(() => window.acceptWebOrder('o1'));
      await sleep(400);
      check('and it reaches the kitchen', dispatched(seen).length > 0, trail(seen));

      // THE BOOKS STILL SAY WHAT IS TRUE. A person saying they saw the money is not
      // the bank saying so, and the ledger keeps the difference: the reconciler flips
      // this to verified when a credit matches, and the Worker's 2-hour check asks
      // about it if none ever does.
      const booked = ledgerLines(seen)[0];
      check('the money goes on the books as unverified, not as a confirmed credit',
            !!booked && booked.state === 'unverified' && !booked.ref,
            JSON.stringify(booked));
      await ctx.close();
    }

    // --------------------------------------------- a wrong PIN confirms nothing
    {
      const { ctx, page, seen } = await till({ o1: ORDER() });
      await page.evaluate(() => { window.__pin = '0000'; });
      await page.evaluate(() => window.markWebOrderPaid('o1'));
      await sleep(300);
      check('a PIN nobody owns records no confirmation',
            !seen.ops.some(o => o.path === 'orders/pendingWeb/o1/manualPaid'), trail(seen));
      check('and does not tell the customer their payment has landed',
            !seen.ops.some(o => o.path.indexOf('orders/track/') === 0), trail(seen));
      await ctx.close();
    }

    // ------------------------------------------------- dine-in is not prepaid
    {
      // A dine-in web order settles at the table on the counter's own QR, like any
      // walk-in. Holding it for a payment nobody has asked for yet would stop the
      // kitchen for no reason at all.
      const { ctx, page, seen } = await till({
        o1: ORDER({ orderType: 'Dine-in', tableOrAddress: 'Table 4', gated: false,
                    upiId: null, billedAt: null })
      });
      await page.evaluate(() => window.acceptWebOrder('o1'));
      await sleep(400);
      check('a dine-in web order still starts without any payment at all',
            dispatched(seen).length > 0, trail(seen));
      check('and opens a table rather than being written into the day’s takings',
            seen.ops.some(o => o.path.indexOf('pos/activeTables/4') === 0) &&
            ledgerLines(seen).length === 0, trail(seen));
      await ctx.close();
    }

    check('the page raised no errors of its own', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.close();
  }

  done();
})();
