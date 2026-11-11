// Two tills, one cash-up: every payment is in it once.
//
// The café runs two tills, and until now every browser suite asked what ONE of them
// does. Each gave the page a database of its own, so the one question that was
// actually breaking the cash-up could not be put: what happens to a payment that
// both tills hear about?
//
// What happened was that it was booked twice. Not through a missing guard — every
// path here had one — but because each guard was a variable in one till's memory, or
// a lock whose key was the same string on both:
//
//   a web order's bank credit   claimed under 'web-{trackId}', which names the order
//                               and not the till. claimPayment lets a caller
//                               re-commit its own token, so both tills "won" the
//                               same claim and both booked: two identical lines in
//                               the cash-up and the payment in the UPI total twice.
//                               With two tills open that is every prepaid web order.
//   accepting a web order       guarded by _webActing, per till. Tapped on both: two
//                               kitchen tickets, a dine-in table with every item on
//                               it twice, two bills, and — confirmed by hand — two
//                               ledger lines.
//   rejecting a paid one        the same guard. Two rows in Refunds Due for one
//                               payment, each with a "Mark refunded" button.
//   cash, or UPI, at the counter the ledger line was written BEFORE the table was
//                               asked, "unconditionally". A bill open on both tills
//                               and settled on both closed once and was booked twice,
//                               and the till that lost said nothing at all.
//   paying out the tips         one request per tap, each with a fresh key. Both
//                               tills, or one till trying again after a timeout:
//                               TIPS OUT twice and the drawer down by double.
//
// So this suite has one database (test/shared-db.js) and two real pages on it, with
// the SDK's own semantics where they matter: writes show locally first, and a
// transaction is re-run against the server's value until it commits or aborts.
//
// The Worker in here is the real handleCashout, lifted out of worker/worker.js and
// pointed at the same database, so a cash-out is followed end to end.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { ROOT, suite, readPage, extractFunction, buildModule } = require('./helpers');
const { createServer } = require('./shared-db');

const { check, note, done } = suite('Two tills — every payment is in the cash-up once');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
                '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const web = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not here');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const VPA = 'ila.one@okaxis';
const PIN = '4821';
const MENU = {
  Coffee: { 'Filter Coffee': { price: 120, routing: 'barista' } },
  Bakes:  { 'Croissant': { price: 180, routing: 'chef' } }
};

// ---- the Worker, for real ---------------------------------------------------------
const wsrc = readPage('worker/worker.js');
const SALT = /const PIN_SALT = '([^']*)';/.exec(wsrc)[1];
const pinHash = (pin) => crypto.createHash('sha256').update(SALT + pin).digest('hex');

function workerFor(srv) {
  const DB = 'https://db.test';
  const fakeFetch = async (url, init) => {
    const u = String(url).replace(DB, '').replace(/\?.*$/, '').replace(/\.json$/, '').replace(/^\/+/, '');
    const method = (init && init.method) || 'GET';
    if (method === 'GET') return { ok: true, json: async () => srv.get(u) };
    if (method === 'PATCH') {
      const body = JSON.parse(init.body);
      const r = srv.writeMany(Object.keys(body).map(k => ({ path: (u ? u + '/' : '') + k, value: body[k] })), 'worker');
      return { ok: r.ok, json: async () => ({}) };
    }
    return { ok: false, json: async () => ({}) };
  };
  return buildModule([
    /const CASHOUT_TYPES = \[[^\]]*\];/.exec(wsrc)[0],
    /const PIN_SALT = '[^']*';/.exec(wsrc)[0],
    extractFunction(wsrc, 'istClock'), extractFunction(wsrc, 'pinToName'), extractFunction(wsrc, 'handleCashout'),
  ], { DB_URL: DB, _enc: new TextEncoder(), crypto, fetch: fakeFetch, getRobotToken: async () => 'robot',
       Date, Math, JSON, String, Number, Object, Array, Uint8Array, isFinite, console }, ['handleCashout']);
}

// ---- the one rule these paths lean on ----------------------------------------------
// database.rules.json: orders/pendingWeb/$orderId validates
// newData.hasChildren(['items','total','orderType']), and a child write is judged
// against it too. So a payment cannot be written onto an order that has gone — which
// is what lets a booking and an accept race without both winning. The emulator suite
// holds the real rule to that; this is its shadow, plus a switch for making one
// table's writes fail.
function rulesFor(state) {
  return (next, _prev, writes) => {
    const pw = (next.orders && next.orders.pendingWeb) || {};
    for (const id of Object.keys(pw)) {
      const o = pw[id];
      if (!o || o.items == null || o.total == null || o.orderType == null) return 'orders/pendingWeb/' + id + ' is not a whole order';
    }
    if (state.failTable && writes.some(w => w.path === 'pos/activeTables/' + state.failTable)) return 'table write refused (test)';
    return null;
  };
}

(async () => {
  await new Promise(r => web.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + web.address().port;
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const pageErrors = [];

  // A café: one database, and as many tills as the case opens on it.
  async function cafe(seed) {
    const state = { failTable: null };
    const srv = createServer(Object.assign({
      users: { u1: { role: 'cashier', name: 'Counter' } },
      menu: MENU,
      settings: { upiList: [VPA] },
      upiRouting: { config: { 'ila_one@okaxis': { id: VPA, label: 'Axis', bank: 'axis 8020', active: true } } },
      staff: { [pinHash(PIN)]: 'Priya' },
      pos: { cashDrawer: 1000, upiTotal: 0 }
    }, seed || {}), { rules: rulesFor(state) });
    srv.writeMany = (writes, by) => srv.commit(writes, by);
    const worker = workerFor(srv);
    const tills = [];

    async function till(name) {
      const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1180, height: 820 } });
      const page = await ctx.newPage();
      page.on('pageerror', e => pageErrors.push(name + ': ' + String(e.message || e).split('\n')[0]));
      await srv.attach(page, name);
      // The Worker's answer can be tampered with on the way back, which is what a
      // timeout is: the request arrived and the reply did not.
      const t = { ctx, page, name, loseReplies: 0 };
      await page.exposeBinding('__workerRpc', async (_src, body) => {
        const data = JSON.parse(body);
        if (data.action !== 'cashout') return { status: 200, body: { ok: true } };
        const r = await worker.handleCashout(data, { sub: 'u1' });
        if (t.loseReplies > 0) { t.loseReplies--; return { status: 504, body: { error: 'reply lost (test)' } }; }
        return r;
      });
      await page.addInitScript(() => {
        window.__worker = (_url, init) => window.__workerRpc(init.body)
          .then(r => new Response(JSON.stringify(r.body), { status: r.status }));
      });
      await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
      await page.goto(base + '/pos.html', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.currentStaff && window.currentStaff.role, null, { timeout: 15000 });
      await page.waitForTimeout(350);
      // Dialogs answer themselves, and say what they said.
      await page.evaluate((pin) => {
        window.__told = [];
        window.ilaToast = (m) => { window.__told.push(String(m)); };
        window.ilaTell = (t2, d) => { window.__told.push(String(t2) + ' — ' + (d || '')); return Promise.resolve(); };
        window.ilaAsk = () => Promise.resolve(true);
        window.ilaAskText = () => Promise.resolve(pin);
        const real = window.showToast;
        window.showToast = function (title, details) { window.__told.push(String(title) + ' — ' + (details || '')); try { return real.apply(this, arguments); } catch (e) {} };
        // function declarations are global here; rebinding the name reaches every caller
        try { showToast = window.showToast; } catch (e) {}
      }, PIN);
      tills.push(t);
      return t;
    }
    const quiet = async (ms) => { await sleep(ms || 500); await srv.settle(); await sleep(60); await srv.settle(); };
    const close = async () => { for (const t of tills) await t.ctx.close(); };
    const lines = () => Object.values(srv.get('pos/ledgerEntries') || {});
    const told = (t) => t.page.evaluate(() => window.__told.slice());
    return { srv, state, till, quiet, close, lines, told };
  }

  const NOW = Date.now();
  const takeaway = (over) => Object.assign({
    orderType: 'Takeaway', tableOrAddress: 'Takeaway — Anil',
    items: { 'Filter Coffee': { qty: 2, price: 120 }, 'Croissant': { qty: 1, price: 180 } },
    total: 420, gated: true, phone: '9990001111', upiId: VPA, trackId: 'tk-anil',
    billedAt: NOW - 60000, createdAt: NOW - 90000
  }, over || {});
  const credit = (ref, amount, over) => Object.assign(
    { amount: amount, ref: ref, at: Date.now(), bankTime: Date.now() - 5000, bank: 'axis', acct: '8020', payer: 'ANIL' }, over || {});
  const show = (ls) => ls.map(e => e.type + ' ₹' + e.amount + ' "' + e.reason + '"' + (e.state ? ' ' + e.state : '')).join(' | ') || '(no lines)';

  try {
    // ================================================= a web order's payment, heard twice
    {
      const c = await cafe();
      const A = await c.till('A'), B = await c.till('B');
      c.srv.write('orders/pendingWeb/o1', takeaway());
      await c.quiet(300);
      c.srv.write('payments/incoming/412233445566', credit('412233445566', 420));
      await c.quiet(900);

      const ls = c.lines();
      check('one web order paid once is one line in the cash-up, with two tills open',
            ls.length === 1, ls.length + ' line(s): ' + show(ls));
      check('and the day’s UPI total moves by it once', c.srv.get('pos/upiTotal') === 420,
            '₹' + c.srv.get('pos/upiTotal') + ' for a ₹420 payment');
      note('this was two lines and ₹840: the claim named the order, so both tills held it');
      const claim = String(c.srv.get('payments/claims/412233445566') || '');
      const ids = await Promise.all([A, B].map(t => t.page.evaluate(() => window._tillId)));
      check('the claim on the credit names the till that booked it, not just the order',
            /^web-tk-anil~/.test(claim) && ids.some(id => claim === 'web-tk-anil~' + id), claim);
      const o = c.srv.get('orders/pendingWeb/o1') || {};
      check('and the order carries the payment, so neither till books it again after a reload',
            !!(o.payment && o.payment.ref === '412233445566'), JSON.stringify(o.payment || null));

      // ...and it stays once, however often the feed wakes the sweep afterwards.
      c.srv.write('payments/incoming/499999999999', credit('499999999999', 75, { payer: 'SOMEONE ELSE' }));
      await c.quiet(500);
      check('a later, unrelated credit waking both sweeps again adds nothing',
            c.lines().length === 1 && c.srv.get('pos/upiTotal') === 420, show(c.lines()));
      await c.close();
    }

    // ============================================ a claim left behind by a till that died
    //
    // The reason the token ever named the order: a till that wins the claim and dies
    // before the booking must not strand the customer's money. That still has to work,
    // and it has to work ONCE — two tills finding the same orphan must not both adopt it.
    {
      const c = await cafe({ payments: { claims: { '412233445566': 'web-tk-anil~deadtill' } } });
      const A = await c.till('A'), B = await c.till('B');
      c.srv.write('orders/pendingWeb/o1', takeaway());
      await c.quiet(300);
      c.srv.write('payments/incoming/412233445566', credit('412233445566', 420));
      await c.quiet(700);
      check('a credit claimed for this order by another till is left alone at first',
            c.lines().length === 0, show(c.lines()));
      note('a live holder books in the same tick it wins the claim — it only needs a moment');

      // Twenty seconds later, on both tills at once.
      await Promise.all([A, B].map(t => t.page.evaluate(() => {
        for (const id in window._wvForeign) window._wvForeign[id].since -= 60000;
        sweepWebPayments();
      })));
      await c.quiet(900);
      const ls = c.lines();
      check('once it has plainly been abandoned, the payment is booked after all',
            ls.length >= 1 && ls[0].state === 'verified', show(ls));
      check('and by one till, not by each that noticed',
            ls.length === 1 && c.srv.get('pos/upiTotal') === 420,
            ls.length + ' line(s), ₹' + c.srv.get('pos/upiTotal'));
      check('the claim has passed to the till that did it',
            String(c.srv.get('payments/claims/412233445566')) !== 'web-tk-anil~deadtill',
            String(c.srv.get('payments/claims/412233445566')));
      await c.close();
    }

    // ==================================== the bank answers while the order is being accepted
    //
    // The customer showed their phone, a member of staff confirmed the payment by hand,
    // and Accept is tapped just as the bank's alert arrives. One till is writing the
    // verified booking; the other is writing the unverified line that a hand-confirmed
    // accept writes. Both used to land.
    {
      const c = await cafe();
      const A = await c.till('A'), B = await c.till('B');
      c.srv.write('orders/pendingWeb/o1', takeaway({ manualPaid: { by: 'Priya', at: NOW, via: 'pos' } }));
      await c.quiet(300);

      // Hold the booking between the till and the server, and accept in the gap.
      let release; const held = new Promise(r => { release = r; });
      let holder = null;
      c.srv.gate = async (req, client) => {
        if (req.op === 'write' && req.writes.some(w => /^orders\/pendingWeb\/o1\/payment$/.test(w.path))) { holder = client.name; await held; }
      };
      c.srv.write('payments/incoming/412233445566', credit('412233445566', 420));
      await c.quiet(500);
      check('(the booking is in flight on one till)', holder === 'A' || holder === 'B', String(holder));
      const other = holder === 'A' ? B : A;
      await other.page.evaluate(() => window.acceptWebOrder('o1'));
      await c.quiet(500);
      release(); c.srv.gate = null;
      await c.quiet(900);

      const ls = c.lines();
      check('an order accepted while its payment is being booked is still one line',
            ls.length === 1, ls.length + ' line(s): ' + show(ls));
      check('and one amount in the UPI total', c.srv.get('pos/upiTotal') === 420, '₹' + c.srv.get('pos/upiTotal'));
      check('the booking that lost did not leave half an order behind in the queue',
            c.srv.get('orders/pendingWeb') === null, JSON.stringify(c.srv.get('orders/pendingWeb')));
      note('the rules refuse a payment written onto an order that has gone, and the line rides with it');
      await c.close();
    }

    // ============================================================ accepted on both tills
    {
      const c = await cafe();
      const A = await c.till('A'), B = await c.till('B');
      c.srv.write('orders/pendingWeb/d1', { orderType: 'Dine-in', tableOrAddress: 'Table 4',
        items: { 'Filter Coffee': { qty: 2, price: 120 } }, total: 240, trackId: 'tk-din', createdAt: NOW - 90000 });
      await c.quiet(300);
      await Promise.all([A, B].map(t => t.page.evaluate(() => window.acceptWebOrder('d1'))));
      await c.quiet(700);

      const t4 = c.srv.get('pos/activeTables/4') || {};
      check('a dine-in web order accepted on both tills is on the table once',
            t4.total === 240 && t4.items && t4.items['Filter Coffee'].qty === 2, JSON.stringify(t4));
      note('it was four coffees and ₹480 — a bill of double the order');
      const tickets = Object.keys((c.srv.get('orders/active') || {}).barista || {}).length;
      check('and the kitchen gets one ticket', tickets === 1, tickets + ' ticket(s)');
      const said = (await c.told(A)).concat(await c.told(B)).join(' ¦ ');
      check('the till that was second is told, rather than left to wonder',
            /already been dealt with/.test(said), said || '(nothing said)');
      await c.close();
    }
    {
      const c = await cafe();
      const A = await c.till('A'), B = await c.till('B');
      c.srv.write('orders/pendingWeb/o1', takeaway({ manualPaid: { by: 'Priya', at: NOW, via: 'pos' } }));
      await c.quiet(300);
      await Promise.all([A, B].map(t => t.page.evaluate(() => window.acceptWebOrder('o1'))));
      await c.quiet(800);
      const ls = c.lines();
      check('a takeaway confirmed by hand and accepted on both tills is one line',
            ls.length === 1 && ls[0].state === 'unverified' && c.srv.get('pos/upiTotal') === 420,
            ls.length + ' line(s), ₹' + c.srv.get('pos/upiTotal') + ': ' + show(ls));
      const bills = Object.keys(c.srv.get('pos/bills') || {}).length;
      const hist = Object.keys((c.srv.get('orders') || {}).history || {}).length;
      check('and one bill, and one row in the order history', bills === 1 && hist === 1, bills + ' bill(s), ' + hist + ' history row(s)');
      await c.close();
    }

    // ============================================================ rejected on both tills
    {
      const paid = { ref: '412233445566', amount: 420, at: NOW, payId: 'web_tk-anil', bankTag: 'axis 8020' };
      const c = await cafe();
      const A = await c.till('A'), B = await c.till('B');
      c.srv.write('orders/pendingWeb/o1', takeaway({ payment: paid }));
      await c.quiet(300);
      await Promise.all([A, B].map(t => t.page.evaluate(() => window.rejectWebOrder('o1'))));
      await c.quiet(700);
      const due = Object.values((c.srv.get('orders') || {}).refundsDue || {});
      check('a paid order rejected on both tills is one refund owed, not two',
            due.length === 1 && due[0].amount === 420, due.length + ' refund(s) due');
      note('each row has its own "Mark refunded" button, and each writes a refund to the ledger');
      await c.close();
    }
    // ...and the payment that lands while the question is on screen.
    {
      const c = await cafe();
      const A = await c.till('A');
      c.srv.write('orders/pendingWeb/o1', takeaway());
      await c.quiet(300);
      // The till has the order as unpaid. Underneath it, the server books the payment.
      await A.page.evaluate(() => {
        const real = window.ilaAsk;
        window.ilaAsk = () => new Promise(r => { window.__answer = () => { window.ilaAsk = real; r(true); }; });
        window.__rejecting = window.rejectWebOrder('o1');
      });
      c.srv.commit([
        { path: 'orders/pendingWeb/o1/payment', value: { ref: '412233445566', amount: 420, at: NOW, payId: 'web_tk-anil' } }
      ], 'other till');
      await c.quiet(200);
      await A.page.evaluate(() => { window.__answer(); return window.__rejecting; });
      await c.quiet(500);
      const due = Object.values((c.srv.get('orders') || {}).refundsDue || {});
      check('an order paid while "Reject?" was on screen is rejected as PAID',
            due.length === 1 && due[0].amount === 420 && due[0].ref === '412233445566',
            due.length + ' refund(s) due — ' + JSON.stringify(due[0] || null));
      note('it was rejected as unpaid: the money in the account and no refund owed to anybody');
      const said = (await c.told(A)).join(' ¦ ');
      check('and the person who rejected it is told it had been paid', /just been PAID/.test(said), said || '(nothing said)');
      await c.close();
    }

    // =========================================================== cash, taken on both tills
    {
      const c = await cafe({ pos: { cashDrawer: 1000, upiTotal: 0,
        activeTables: { 5: { items: { 'Filter Coffee': { qty: 2, price: 120 } }, total: 240 } } } });
      const A = await c.till('A'), B = await c.till('B');
      for (const t of [A, B]) await t.page.evaluate(() => window.openCheckout('5'));
      await Promise.all([A, B].map(t => t.page.evaluate(() => window.payWithCash(null))));
      await c.quiet(700);

      const ls = c.lines();
      check('one bill settled in cash on both tills is one line', ls.length === 1, ls.length + ' line(s): ' + show(ls));
      check('and the drawer goes up by the bill, once', c.srv.get('pos/cashDrawer') === 1240, '₹' + c.srv.get('pos/cashDrawer') + ' from ₹1000 for a ₹240 bill');
      note('it was two lines and a drawer over by ₹240, and neither till said a word');
      const bills = Object.keys(c.srv.get('pos/bills') || {}).length;
      check('with one bill in History', bills === 1, bills + ' bill(s)');
      const said = (await c.told(A)).concat(await c.told(B)).join(' ¦ ');
      check('and the till whose payment was turned away says so, and that it was NOT recorded',
            /already settled/.test(said) && /NOT recorded/.test(said), said || '(nothing said)');
      await c.close();
    }

    // ============================================ a split bill: two shares, two tills at once
    //
    // Not every double tap is a duplicate. Two people paying their halves at two tills
    // is two payments, and both must stand.
    {
      const c = await cafe({ pos: { cashDrawer: 1000, upiTotal: 0,
        activeTables: { 6: { items: { 'Filter Coffee': { qty: 2, price: 120 } }, total: 240 } } } });
      const A = await c.till('A'), B = await c.till('B');
      for (const t of [A, B]) await t.page.evaluate(() => window.openCheckout('6'));
      await Promise.all([A, B].map(t => t.page.evaluate(() => window.payWithCash(120))));
      await c.quiet(700);
      const ls = c.lines();
      check('two half shares of one bill, paid at two tills, are both booked',
            ls.length === 2 && c.srv.get('pos/cashDrawer') === 1240, ls.length + ' line(s), drawer ₹' + c.srv.get('pos/cashDrawer'));
      check('and between them they close the table', c.srv.get('pos/activeTables/6') === null, JSON.stringify(c.srv.get('pos/activeTables/6')));
      await c.close();
    }

    // ============================================== the table write fails: nothing is booked
    {
      const c = await cafe({ pos: { cashDrawer: 1000, upiTotal: 0,
        activeTables: { 7: { items: { 'Croissant': { qty: 1, price: 180 } }, total: 180 } } } });
      const A = await c.till('A');
      c.state.failTable = '7';
      await A.page.evaluate(() => { window.openCheckout('7'); window.payWithCash(null); });
      await c.quiet(600);
      check('a payment the table could not take is not in the cash-up',
            c.lines().length === 0 && c.srv.get('pos/cashDrawer') === 1000, show(c.lines()) + ', drawer ₹' + c.srv.get('pos/cashDrawer'));
      const said = (await c.told(A)).join(' ¦ ');
      check('and the till says NOT RECORDED, not "recorded, re-open the bill"', /NOT RECORDED/.test(said) && !/is recorded/.test(said), said || '(nothing said)');
      note('re-opening the bill offered exactly one thing: taking the payment again');

      // The cashier does what the message says.
      c.state.failTable = null;
      await sleep(2100);                               // past the double-tap guard
      await A.page.evaluate(() => { window.openCheckout('7'); window.payWithCash(null); });
      await c.quiet(600);
      check('taking it again then books it once', c.lines().length === 1 && c.srv.get('pos/cashDrawer') === 1180,
            show(c.lines()) + ', drawer ₹' + c.srv.get('pos/cashDrawer'));
      await c.close();
    }

    // ======================================== the wifi blinks with the payment in the air
    //
    // The SDK cancels a transaction it has sent and not heard back about, with an error
    // that is the same whether the server applied it or never saw it. Taking that as
    // "recorded" is how a payment was taken twice; taking it as "not recorded" loses
    // the sale when it did land. The payment is made again instead — it carries its
    // own id onto the table, so again is safe — and is in the cash-up once either way.
    for (const how of ['landed', 'lost']) {
      const c = await cafe({ pos: { cashDrawer: 1000, upiTotal: 0,
        activeTables: { 5: { items: { 'Filter Coffee': { qty: 2, price: 120 } }, total: 240 } } } });
      const A = await c.till('A');
      await A.page.evaluate((h) => {
        window.__cutTxn = { prefix: 'pos/activeTables/', list: [h] };
        window.openCheckout('5'); window.payWithCash(null);
      }, how);
      await c.quiet(1500);
      const ls = c.lines();
      check('a cash payment cut off in the air (' + (how === 'landed' ? 'it had landed' : 'it never arrived') + ') is in the cash-up once',
            ls.length === 1 && ls[0].amount === 240 && c.srv.get('pos/cashDrawer') === 1240,
            ls.length + ' line(s), drawer ₹' + c.srv.get('pos/cashDrawer') + ': ' + show(ls));
      const bills = Object.keys(c.srv.get('pos/bills') || {}).length;
      check('and its bill is closed and in History once',
            c.srv.get('pos/activeTables/5') === null && bills === 1, bills + ' bill(s), table: ' + JSON.stringify(c.srv.get('pos/activeTables/5')));
      const said = (await c.told(A)).join(' ¦ ');
      check('the cashier is told the till is checking, and then that it went through',
            /Checking/.test(said) && /Do not take it again/.test(said) && /Recorded/.test(said), said || '(nothing said)');
      await c.close();
    }
    {
      // A part payment that landed: found on the table, not added to it again.
      const c = await cafe({ pos: { cashDrawer: 1000, upiTotal: 0,
        activeTables: { 5: { items: { 'Filter Coffee': { qty: 2, price: 120 } }, total: 240 } } } });
      const A = await c.till('A');
      await A.page.evaluate(() => {
        window.__cutTxn = { prefix: 'pos/activeTables/', list: ['landed'] };
        window.openCheckout('5'); window.payWithCash(100);
      });
      await c.quiet(1500);
      const t = c.srv.get('pos/activeTables/5') || {};
      check('a part payment that landed and was reported as an error is on the bill once',
            t.paid === 100 && c.lines().length === 1 && c.srv.get('pos/cashDrawer') === 1100,
            'paid ₹' + t.paid + ', ' + c.lines().length + ' line(s), drawer ₹' + c.srv.get('pos/cashDrawer'));
      await c.close();
    }

    // ================================================ a complimentary bill closes with no line
    {
      const c = await cafe({ pos: { cashDrawer: 1000, upiTotal: 0,
        activeTables: { 8: { items: { 'Water': { qty: 1, price: 0 } }, total: 0 } } } });
      const A = await c.till('A');
      await A.page.evaluate(() => { window.openCheckout('8'); window.payWithCash(null); });
      await c.quiet(500);
      check('a bill with nothing due still closes on Cash', c.srv.get('pos/activeTables/8') === null, JSON.stringify(c.srv.get('pos/activeTables/8')));
      check('without a ₹0 line in the cash-up', c.lines().length === 0, show(c.lines()));
      await c.close();
    }

    // ========================================================= UPI at the counter, two tills
    {
      const c = await cafe({ pos: { cashDrawer: 1000, upiTotal: 0,
        activeTables: { 3: { items: { 'Filter Coffee': { qty: 2, price: 120 } }, total: 240 } } } });
      const A = await c.till('A'), B = await c.till('B');
      for (const t of [A, B]) await t.page.evaluate(() => { window.openCheckout('3'); window.payWithUPI(null); });
      await c.quiet(300);
      c.srv.write('payments/incoming/600000000001', credit('600000000001', 240));
      await c.quiet(1800);                              // the tick stays up for 900ms
      const ls = c.lines();
      check('one UPI payment with the bill’s code up on both tills is one line',
            ls.length === 1 && ls[0].state === 'verified' && c.srv.get('pos/upiTotal') === 240,
            ls.length + ' line(s), ₹' + c.srv.get('pos/upiTotal') + ': ' + show(ls));
      await c.close();
    }

    // ================================== the code left up for a bill the other till closed
    {
      const c = await cafe({ pos: { cashDrawer: 1000, upiTotal: 0,
        activeTables: { 3: { items: { 'Filter Coffee': { qty: 2, price: 120 } }, total: 240 } } } });
      const A = await c.till('A'), B = await c.till('B');
      await A.page.evaluate(() => { window.openCheckout('3'); window.payWithUPI(null); });
      await c.quiet(300);
      const up = () => A.page.evaluate(() => ({
        modal: document.getElementById('upi-modal').classList.contains('active'),
        code: document.getElementById('qr-image').style.display !== 'none'
      }));
      const before = await up();
      check('(till A has the bill’s payment code on screen)', before.modal && before.code, JSON.stringify(before));
      await B.page.evaluate(() => { window.openCheckout('3'); window.payWithCash(null); });
      await c.quiet(600);
      const after = await up();
      check('a bill settled on the other till takes its payment code down here',
            after.modal === false && after.code === false, JSON.stringify(after));
      note('left up, the customer scans it and pays a closed bill — their money, twice');
      const said = (await c.told(A)).join(' ¦ ');
      check('and this till says why the screen went', /has been settled/.test(said), said || '(nothing said)');
      check('with the one payment booked once', c.lines().length === 1 && c.srv.get('pos/cashDrawer') === 1240, show(c.lines()));
      // the bill has gone; a stale tap on UPI must not throw
      await A.page.evaluate(() => { window.payWithUPI(null); });
      await c.close();
    }

    // ============================================ a till reopened offline, showing its memory
    //
    // The floor on screen can be this till's own cache of it (see TABLE_CACHE_KEY): the
    // till was reopened with no connection. The SDK has nothing for that table, so the
    // settlement aborts on the spot without asking anybody — and the cash line used to
    // be written anyway, for a bill the server still had open and would show again.
    {
      const c = await cafe();
      const A = await c.till('A');
      await A.page.evaluate(() => {
        window.activeTables = { 4: { items: { 'Croissant': { qty: 1, price: 180 } }, total: 180 } };
        window.tablesFromCacheAt = Date.now() - 5 * 60000;
        window.openCheckout('4'); window.payWithCash(null);
      });
      await c.quiet(500);
      check('a bill this till only remembers cannot be settled into the cash-up',
            c.lines().length === 0 && c.srv.get('pos/cashDrawer') === 1000, show(c.lines()) + ', drawer ₹' + c.srv.get('pos/cashDrawer'));
      const said = (await c.told(A)).join(' ¦ ');
      check('and the till says it has not reconnected, rather than that someone else closed it',
            /NOT RECORDED/.test(said) && /not reconnected/.test(said), said || '(nothing said)');
      await c.close();
    }

    // ============================================ the customer taps a tip as the payment lands
    //
    // The UPI screen is in the customer's hand, with four tip buttons on it. A payment
    // is matched; the tick shows for 900ms; a thumb lands on +₹10 in that window.
    {
      const c = await cafe({ pos: { cashDrawer: 1000, upiTotal: 0,
        activeTables: { 2: { items: { 'Filter Coffee': { qty: 2, price: 120 } }, total: 240 },
                        9: { items: { 'Croissant': { qty: 1, price: 180 } }, total: 180 } } } });
      const A = await c.till('A');
      await A.page.evaluate(() => { window.openCheckout('2'); window.payWithUPI(null); });
      await c.quiet(300);
      c.srv.write('payments/incoming/600000000002', credit('600000000002', 240));
      await A.page.waitForFunction(() => window.upiSettling === true, null, { timeout: 5000 });
      await A.page.evaluate(() => window.setTip(10));
      await c.quiet(1600);
      const ls = c.lines();
      check('a tip tapped after the payment matched does not change what is booked',
            ls.length === 1 && ls[0].amount === 240 && !ls[0].tip, show(ls) + ' tip=' + (ls[0] && ls[0].tip));
      note('it was booked at ₹250 with a ₹10 tip nobody paid, against a ₹240 credit');
      check('and no tip is owed to the staff for it', c.srv.get('pos/tips') === null, JSON.stringify(c.srv.get('pos/tips')));

      // Same window, different thumb: cancel, and open another bill.
      await A.page.evaluate(() => { window.openCheckout('9'); window.payWithUPI(null); });
      await c.quiet(300);
      c.srv.write('payments/incoming/600000000003', credit('600000000003', 180));
      await A.page.waitForFunction(() => window.upiSettling === true, null, { timeout: 5000 });
      await A.page.evaluate(() => { window.cancelUPI(); });
      await c.quiet(1600);
      const after = c.lines();
      check('a payment that matched is booked even if the screen is closed on it',
            after.length === 2 && after.some(e => /Table 9/.test(e.reason) && e.amount === 180), show(after));
      check('and it closed the bill it was for', c.srv.get('pos/activeTables/9') === null, JSON.stringify(c.srv.get('pos/activeTables/9')));
      await c.close();
    }

    // ================================================================ tips out, both tills
    {
      const day = new Date().toISOString().slice(0, 10);
      const c = await cafe({ pos: { cashDrawer: 1000, upiTotal: 600, tips: { lastHeads: 3, [day]: { accrued: 90, paidOut: 0 } } } });
      const A = await c.till('A'), B = await c.till('B');
      await c.quiet(300);
      await Promise.all([A, B].map(t => t.page.evaluate(() => window.payOutTips())));
      await c.quiet(900);
      const outs = c.lines().filter(e => e.type === 'tip_payout');
      check('the tips paid out on both tills at once are one TIPS OUT line',
            outs.length === 1, outs.length + ' line(s): ' + show(outs));
      check('and the drawer goes down by them once', c.srv.get('pos/cashDrawer') === 910, '₹' + c.srv.get('pos/cashDrawer') + ' from ₹1000 for ₹90 of tips');
      check('and the pool reads as paid once, not twice',
            c.srv.get('pos/tips/' + day + '/paidOut') === 90, '₹' + c.srv.get('pos/tips/' + day + '/paidOut') + ' marked paid of ₹90');
      note('marked twice, the next ₹90 of tips would have read as already handed over');
      await c.close();
    }

    // ============================================= an expense whose answer never came back
    {
      const c = await cafe();
      const A = await c.till('A');
      A.loseReplies = 1;                                // recorded, and the reply is lost
      await A.page.evaluate(() => {
        window.openCashManagement(); window.openTransactionModal('expense');
        document.getElementById('transaction-amount').value = '450';
        document.getElementById('transaction-reason').value = 'milk';
        const pin = document.getElementById('transaction-pin');
        if (window.ilaPin) { pin.value = '4821'; pin.dispatchEvent(new Event('input', { bubbles: true })); } else pin.value = '4821';
        return window.confirmTransaction();
      });
      await c.quiet(400);
      const first = c.lines().filter(e => e.type === 'expense');
      check('(the expense was recorded, and the till was told it failed)',
            first.length === 1 && c.srv.get('pos/cashDrawer') === 550, first.length + ' line(s), drawer ₹' + c.srv.get('pos/cashDrawer'));
      const open = await A.page.evaluate(() => document.getElementById('transaction-modal').classList.contains('active'));
      check('the form is still up, as filled in, to be confirmed again', open === true, String(open));
      await A.page.evaluate(() => window.confirmTransaction());
      await c.quiet(400);
      const second = c.lines().filter(e => e.type === 'expense');
      check('confirming it again does not record it again',
            second.length === 1 && c.srv.get('pos/cashDrawer') === 550, second.length + ' line(s), drawer ₹' + c.srv.get('pos/cashDrawer'));
      note('it was a second ₹450 out of the drawer for one carton of milk');

      // The next expense, same amount, same reason, is a different expense.
      await A.page.evaluate(() => {
        window.openCashManagement(); window.openTransactionModal('expense');
        document.getElementById('transaction-amount').value = '450';
        document.getElementById('transaction-reason').value = 'milk';
        const pin = document.getElementById('transaction-pin');
        if (window.ilaPin) { pin.value = '4821'; pin.dispatchEvent(new Event('input', { bubbles: true })); } else pin.value = '4821';
        return window.confirmTransaction();
      });
      await c.quiet(400);
      const third = c.lines().filter(e => e.type === 'expense');
      check('and a second expense for the same amount and reason is still recorded',
            third.length === 2 && c.srv.get('pos/cashDrawer') === 100, third.length + ' line(s), drawer ₹' + c.srv.get('pos/cashDrawer'));
      await c.close();
    }

    check('neither till threw anything while any of that ran', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '));
  } finally {
    await browser.close();
    web.close();
  }

  done();
})().catch(e => { console.error(e); process.exit(1); });
