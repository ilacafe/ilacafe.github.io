// Booking a web order's payment: the claim, and the one thing it may not do twice.
//
// A prepaid web order is matched to a bank credit by sweepWebPayments, and the
// matched credit is CLAIMED first — payments/claims/{ref} is a transaction so two
// tills, or a till and a table QR, cannot both take the same money. Web orders claim
// under a stable token derived from the order (`web-{trackId}`) rather than a random
// one, and claimPayment says why: "If the tab dies between winning the claim and
// writing the booking, the retry recognises its own claim instead of treating the
// credit as taken by someone else and losing the money."
//
// That is what it said and it was not what it did. The update function was
// `curr === null ? token : undefined`, which aborts on ANY value already present —
// its own included. So the retry the comment describes was refused by its own claim:
// cb(false), and the sweep walked away from a credit it had already won. wvFindMatch
// goes on offering that credit to the same order for as long as it is in the window,
// so the order retried on every sweep and was told no every time. The customer had
// paid, the money was in the account, and the order sat "unpaid" on the till for good
// — waiting for somebody to confirm by hand a payment the system had already matched.
//
// Fixing that opens a second question immediately, and it is the more expensive one.
// addLedgerEntry increments pos/upiTotal, so booking a payment twice adds it to the
// day's takings twice. The only thing stopping a second pass is the `o.payment.ref`
// test at the top of the sweep — which reads the ORDER, and the order does not carry
// that field until the write comes back. Every sweep in between sees an unbooked
// order, and a claim that now honours its own token would let it through.
//
// So both are asked here, of the real page, against a stub whose transaction behaves
// the way Firebase's does: a claim held by this order books it, a claim held by
// anyone else does not, and a sweep driven repeatedly across the in-flight write
// books exactly once.
//
// AND THEN THE FIX TURNED OUT TO BE THE NEXT BUG. 'web-{trackId}' names the order and
// nothing else, so it is the same string on both of the café's tills — and a claim a
// caller may re-commit is a claim BOTH of them may re-commit. Each heard the same
// credit, each "won", each booked: every prepaid web order in the cash-up twice
// (test/two-tills-browser.test.js holds that, with two pages on one database).
//
// The token names the till as well now. What this suite has to keep true through
// that is the thing the order-derived token was for:
//
//   this till's own claim      is still re-committed and booked at once — the retry
//   another till's claim       on THIS order is not an immediate win any more, but it
//                              is not somebody else's money either: left a moment for
//                              its holder to book, then taken over and booked once
//   the marker and the line    are one write, so a booking cannot half-land and be
//                              tried again on top of itself

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Web-order booking — the claim, and booking once');

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

// A fixed instant, deliberately, and it stays correct however long from now this runs:
// nothing on the booking path filters on absolute age. wvFindMatch judges a credit
// against the order's own billedAt and against the wall clock only as an upper bound,
// so a fixture pinned to a past evening is as matchable today as it was then. The
// reconciler is the one that does apply an age, and its suite uses real time for it.
const NOW = 1756200000000;
const VPA = 'ila.one@okaxis';
const REF = '412233445566';
const TRACK = 'tk-anil';
const TOTAL = 420;

const CREDIT = { amount: TOTAL, ref: REF, at: NOW - 60000, bankTime: NOW - 90000,
                 bank: 'axis', acct: '8020', payer: 'ANIL' };

const ORDER = {
  orderType: 'Takeaway', tableOrAddress: 'Takeaway — Anil',
  items: { 'Filter Coffee': { qty: 2, price: 120 }, 'Croissant': { qty: 1, price: 180 } },
  total: TOTAL, gated: true, phone: '9990001111', upiId: VPA,
  trackId: TRACK, billedAt: NOW - 4 * 60000, createdAt: NOW - 5 * 60000
};

// A database that keeps the claims node, runs transactions against it the way
// Firebase does, and reports every write out of the page.
//
// __holdPayment makes the write that carries orders/pendingWeb/{id}/payment hang, which is the
// window the double-booking guard lives in: the write is away, the order does not
// carry the marker yet, and the sweep can be driven again in the meantime.
const STUB = `
(() => {
  const out = (kind, data) => { try { window.__ila(kind, data); } catch (e) {} };
  const record = (op, p, v) => {
    let value = null;
    try { value = v === undefined ? null : JSON.parse(JSON.stringify(v)); } catch (e) { value = '[unserialisable]'; }
    out('op', { op: op, path: p, value: value });
  };

  const DATA = {
    'payments/incoming': { ${JSON.stringify(REF)}: ${JSON.stringify(CREDIT)} },
    'payments/claims': {},
    'upiRouting/config': { 'ila_one@okaxis': { id: ${JSON.stringify(VPA)}, label: 'Axis', bank: 'axis 8020', active: true } },
    'pos/unverified': {}, 'pos/ledgerEntries': {}
  };
  window.__DATA = DATA;
  window.__holdPayment = false;
  const listeners = [];

  const valueAt = (p, q) => {
    q = q || {};
    if (Object.prototype.hasOwnProperty.call(DATA, p)) {
      const node = DATA[p];
      let keys = Object.keys(node);
      if (q.orderBy) keys.sort((a, b) => {
        const d = ((node[a] || {})[q.orderBy] || 0) - ((node[b] || {})[q.orderBy] || 0);
        return d !== 0 ? d : (a < b ? -1 : a > b ? 1 : 0);
      });
      else keys.sort();
      if (q.limitToLast) keys = keys.slice(-q.limitToLast);
      const o = {}; keys.forEach(k => { o[k] = node[k]; }); return o;
    }
    const cut = p.lastIndexOf('/');
    const parent = p.slice(0, cut), key = p.slice(cut + 1);
    if (DATA[parent] && Object.prototype.hasOwnProperty.call(DATA[parent], key)) return DATA[parent][key];
    return null;
  };
  const writeAt = (p, v) => {
    const cut = p.lastIndexOf('/');
    const parent = p.slice(0, cut), key = p.slice(cut + 1);
    if (!DATA[parent]) DATA[parent] = {};
    if (v === null) delete DATA[parent][key]; else DATA[parent][key] = v;
  };

  const snapOf = (v) => ({ key: null, val: () => (v === undefined ? null : v),
    exists: () => v != null,
    numChildren: () => (v && typeof v === 'object') ? Object.keys(v).length : 0,
    hasChild: (c) => !!(v && typeof v === 'object' && v[c] != null),
    child: (c) => snapOf(v && typeof v === 'object' ? v[c] : null),
    forEach: (cb) => { Object.keys(v || {}).forEach(k => cb({ key: k, val: () => v[k] })); } });

  const mkRef = (p, q) => {
    q = q || {};
    const self = {
      key: p.split('/').filter(Boolean).pop() || null,
      toString: () => 'stub://' + p,
      child: (c) => mkRef(p + '/' + c, {}),
      orderByChild: (f) => mkRef(p, Object.assign({}, q, { orderBy: f })),
      orderByKey: () => mkRef(p, q),
      limitToLast: (n) => mkRef(p, Object.assign({}, q, { limitToLast: n })),
      limitToFirst: () => self, startAt: () => self, endAt: () => self, equalTo: () => self,
      on: (e, cb) => {
        if (e && e !== 'value') return cb;
        listeners.push({ path: p, q: q, cb: cb });
        setTimeout(() => cb(snapOf(valueAt(p, q))), 0);
        return cb;
      },
      off: (_e, cb) => { for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].cb === cb) listeners.splice(i, 1); },
      once: (_e, cb) => { const s = snapOf(valueAt(p, q)); if (cb) cb(s); return Promise.resolve(s); },
      push: (v) => { if (v !== undefined) record('push', p, v); return mkRef(p + '/-Nstub', {}); },
      set: (v) => { record('set', p, v); return Promise.resolve(); },
      // The booking is ONE root update — the ledger line, the total and the marker on
      // the order — so that is the write to hold away.
      update: (v) => {
        record('update', p, v);
        const marks = Object.keys(v || {}).some(k => /^orders\\/pendingWeb\\/[^/]+\\/payment$/.test(k));
        if (marks && window.__holdPayment) return new Promise(() => {});   // away, and not back yet
        if (marks) Object.keys(v).forEach(k => {
          const m = /^orders\\/pendingWeb\\/([^/]+)\\/payment$/.exec(k);
          if (m && window.pendingWebOrders && window.pendingWebOrders[m[1]]) window.pendingWebOrders[m[1]].payment = v[k];
        });
        return Promise.resolve();
      },
      remove: () => { record('remove', p, null); return Promise.resolve(); },
      // The real thing: run the update function against what is there, write what it
      // returns, abort on undefined, and hand the caller back the resulting value.
      transaction: (fn, cb) => {
        const before = valueAt(p, {});
        let next;
        try { next = fn(before === undefined ? null : before); }
        catch (e) { if (cb) cb(e, false, snapOf(before)); return Promise.reject(e); }
        if (next === undefined) {
          const s = snapOf(before);
          if (cb) cb(null, false, s);
          return Promise.resolve({ committed: false, snapshot: s });
        }
        writeAt(p, next);
        record('txn', p, next);
        const s = snapOf(next);
        if (cb) cb(null, true, s);
        listeners.filter(l => l.path === p).forEach(l => l.cb(snapOf(valueAt(l.path, l.q))));
        return Promise.resolve({ committed: true, snapshot: s });
      }
    };
    return self;
  };

  window.__emit = (prefix) => listeners
    .filter(l => !prefix || l.path === prefix || l.path.indexOf(prefix + '/') === 0)
    .forEach(l => l.cb(snapOf(valueAt(l.path, l.q))));

  const db = { ref: (p) => mkRef(String(p == null ? '' : p).replace(/^\\/+|\\/+$/g, ''), {}),
               goOnline: () => {}, goOffline: () => {} };
  const database = () => db;
  database.ServerValue = { TIMESTAMP: ${NOW}, increment: (n) => ({ '.sv': { increment: n } }) };
  window.firebase = {
    initializeApp: () => ({}), apps: [], database: database,
    auth: () => ({ onAuthStateChanged: () => {}, signOut: () => Promise.resolve(),
                   currentUser: { uid: 'u1', getIdToken: () => Promise.resolve('t') } })
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('workers.dev') !== -1) return Promise.resolve(new Response('ok', { status: 200 }));
    return realFetch(input, init);
  };
})();
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const pageErrors = [];

  // A till with one pending web order, and payments/claims seeded however the case
  // wants it. Everything else is the real page.
  async function till(claims, opts) {
    opts = opts || {};
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const seen = { ops: [] };
    page.on('pageerror', e => pageErrors.push(String(e.message || e).split('\n')[0]));
    await page.exposeFunction('__ila', (kind, data) => { if (kind === 'op') seen.ops.push(data); });
    await page.addInitScript(STUB);
    await page.route('**/*', route =>
      route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base + '/pos.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    await page.evaluate(([cl, order, hold]) => {
      // '@mine' is the claim THIS till would write: only the page knows its own id.
      for (const k of Object.keys(cl)) if (cl[k] === '@mine') cl[k] = window.webClaimToken(order);
      window.__DATA['payments/claims'] = cl;
      window.__holdPayment = !!hold;
      window.salesLedger = []; window.activeTables = {}; window.pastBills = [];
      window.pendingWebOrders = { o1: order };
      window.startVerificationReconciler();
      window.ensureWebVerifyFeeds();
    }, [claims, ORDER, opts.holdPayment]);
    await sleep(400);
    return { ctx, page, seen };
  }

  // The ledger line and the total it moves go in ONE root-level multi-path update, so
  // a line is a KEY inside an update rather than a path written to.
  const ledgerLines = (seen) => {
    const out = [];
    seen.ops.forEach(o => {
      if (o.op !== 'update' || !o.value || typeof o.value !== 'object') return;
      Object.keys(o.value).forEach(k => { if (k.indexOf('pos/ledgerEntries/') === 0) out.push(o.value[k]); });
    });
    return out;
  };
  // The marker rides in the same update as the line it marks.
  const paymentMarkers = (seen) => {
    const out = [];
    seen.ops.forEach(o => {
      if (o.op !== 'update' || !o.value || typeof o.value !== 'object') return;
      Object.keys(o.value).forEach(k => { if (/^orders\/pendingWeb\/[^/]+\/payment$/.test(k)) out.push({ value: o.value[k], withLine: Object.keys(o.value).some(x => x.indexOf('pos/ledgerEntries/') === 0) }); });
    });
    return out;
  };
  const trail = (seen) => seen.ops.map(o => o.op + ' ' + o.path).join(', ') || '(nothing written)';

  try {
    // ------------------------------------ a credit this till already claimed, and dropped
    {
      const { ctx, seen } = await till({ [REF]: '@mine' });
      const lines = ledgerLines(seen);
      const markers = paymentMarkers(seen);
      check('a credit already claimed under this till’s own token is still booked',
            lines.length === 1, lines.length + ' ledger line(s) — ' + trail(seen));
      check('and it is booked as verified, against that credit',
            lines.length === 1 && lines[0].state === 'verified' && String(lines[0].ref) === REF,
            JSON.stringify(lines[0] || null));
      check('and the order is marked paid so a reload does not lose it',
            markers.length === 1 && markers[0].value && String(markers[0].value.ref) === REF,
            JSON.stringify(markers.map(m => m.value)));
      check('in the same write as the ledger line, so neither can land without the other',
            markers.length === 1 && markers[0].withLine === true, trail(seen));
      note('the token names the order precisely so an interrupted booking can be finished');
      await ctx.close();
    }

    // ------------------------------- the same order's claim, in another till's hands
    //
    // 'web-{trackId}' on its own is what a till on the previous build writes; with a
    // '~' and an id after it, it is another till on this one. Either way it is this
    // order's money and somebody else is — or was — in the middle of booking it.
    for (const held of ['web-' + TRACK, 'web-' + TRACK + '~othertill']) {
      const { ctx, page, seen } = await till({ [REF]: held });
      check('a claim held for this order by another till (' + held + ') is not booked on sight',
            ledgerLines(seen).length === 0, ledgerLines(seen).length + ' ledger line(s) — ' + trail(seen));
      note('that was the double: both tills re-committed the one token and both booked');

      const waiting = await page.evaluate(() => Object.keys(window._wvForeign || {}).length);
      check('but it is remembered, and timed', waiting === 1, waiting + ' order(s) being waited on');

      // Twenty seconds on, with nothing booked behind that claim.
      await page.evaluate(() => { for (const id in window._wvForeign) window._wvForeign[id].since -= 60000; sweepWebPayments(); });
      await sleep(300);
      const lines = ledgerLines(seen);
      check('and once its holder has plainly gone, the payment is booked after all',
            lines.length === 1 && lines[0].state === 'verified' && String(lines[0].ref) === REF,
            lines.length + ' ledger line(s) — ' + trail(seen));
      const now = await page.evaluate((ref) => [window.__DATA['payments/claims'][ref], window.webClaimToken(window.pendingWebOrders.o1 || { trackId: 'tk-anil' })], REF);
      check('under this till’s own claim, so the next till to look leaves it alone',
            now[0] === now[1], JSON.stringify(now));
      await ctx.close();
    }

    // ------------------------------------------- a credit somebody else has taken
    {
      const { ctx, seen } = await till({ [REF]: 'pos-Table 7-1756199000000-ab12' });
      const lines = ledgerLines(seen);
      check('a credit claimed by the counter is not taken from it',
            lines.length === 0, lines.length + ' ledger line(s) — ' + trail(seen));
      check('and no payment is written onto the order either',
            paymentMarkers(seen).length === 0, trail(seen));
      note('this is the whole job of payments/claims and it must survive the fix above');
      await ctx.close();
    }

    // ------------------------------------------------- the same money, booked once
    //
    // The order's payment write is held away, so the order never gains the field the
    // sweep skips on. Then the sweep is driven again, the way a claim landing and a
    // credit feed refreshing both drive it.
    {
      const { ctx, page, seen } = await till({}, { holdPayment: true });
      await page.evaluate(() => { window.__emit('payments/incoming'); });
      await sleep(150);
      await page.evaluate(() => { window.__emit('payments/claims'); });
      await sleep(150);
      await page.evaluate(() => { window.__emit('payments/incoming'); });
      await sleep(250);

      const lines = ledgerLines(seen);
      const claim = await page.evaluate((ref) => String(window.__DATA['payments/claims'][ref] || ''), REF);
      check('an unclaimed credit is claimed under a token that names this till',
            claim.indexOf('web-' + TRACK + '~') === 0 && claim.length > ('web-' + TRACK + '~').length, claim);
      check('an unclaimed credit is booked', lines.length >= 1,
            lines.length + ' ledger line(s) — ' + trail(seen));
      check('and driving the sweep again while that write is in flight books it once',
            lines.length === 1, lines.length + ' ledger line(s) — ' + trail(seen));
      note('addLedgerEntry increments pos/upiTotal — a second line is the day’s takings, wrong');

      const upiMoves = seen.ops.filter(o => o.op === 'update' && o.value && o.value['pos/upiTotal']).length;
      check('and the day’s UPI total moves exactly once for it', upiMoves === 1,
            upiMoves + ' increment(s)');
      await ctx.close();
    }

    check('the till threw nothing while any of that ran', pageErrors.length === 0,
          pageErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.close();
  }

  done();
})();
