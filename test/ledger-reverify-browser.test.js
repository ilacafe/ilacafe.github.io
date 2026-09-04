// One bank credit settles one sale.
//
// reconcileLedgerVerification is what flips a UPI line from unverified to verified
// when the bank's email finally lands. It matches on amount, bank tag and how close
// the credit is to the settlement, and before it does any of that it works out which
// credits are already spoken for — usedRefs. A credit in usedRefs is somebody else's
// money and may not settle a second line.
//
// Two kinds of record can own a credit. Live ledger entries, and the rows EOD parks in
// pos/unverified when the day closes with a payment still unmatched. The parked rows
// were being read for that in the wrong order:
//
//     const c = carry[pid]; if (!c || c.state === 'verified') continue;
//     if (c.ts && c.ts < now - CARRY_AGE) continue;
//     if (c.ref) usedRefs.add(String(c.ref));
//
// The add sat BELOW the skip, so the one kind of parked row that definitely owns a
// credit — the verified one — was the one kind whose ref never reached usedRefs.
//
// And a verified parked row does not vanish when it verifies. The Worker clears it
// only once the correction is demonstrably in the day's archive, which takes two
// hourly runs; until then it sits in pos/unverified owning a credit this function
// reads as free. Any live entry of the same amount and bank then finds exactly one
// candidate — that same credit — the counts line up at one and one, every proximity
// check passes, and one bank credit is booked as settling two different sales. The
// day's takings then agree with the bank on a number the bank only ever paid once.
//
// Driven through the real till, because the reconciler is not exported: it runs off
// the pos/unverified and pos/ledgerEntries listeners, and what is under test is what
// it ends up writing.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Ledger verification — a credit is spent once');

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

// Real time, not a frozen instant: the reconciler drops any ledger entry older than
// ENTRY_AGE (7 days) measured against the till's own clock, so a fixture pinned to a
// past date is discarded before a single credit is compared to it.
const NOW = Date.now();
const AMOUNT = 450;
const REF = '556677889900';

// One credit. It belongs to the parked row — that row already carries its ref.
const CREDIT = { amount: AMOUNT, ref: REF, at: NOW - 30 * 60000, bankTime: NOW - 35 * 60000,
                 bank: 'axis', acct: '8020' };

// Yesterday's ₹450, parked at EOD and since verified against that credit. The Worker
// has not cleared it yet, which is normal: it takes two hourly runs.
const CARRY_VERIFIED = {
  'pay-yesterday': { state: 'verified', ref: REF, amount: AMOUNT, bankTag: 'axis 8020',
                     ts: NOW - 40 * 60000, day: 'yesterday', verifiedAt: NOW - 20 * 60000 }
};

// Today's ₹450 to the same account, still waiting for its own credit. It must not be
// handed the one above.
const LEDGER = {
  'L1': { type: 'upi_income', state: 'unverified', amount: AMOUNT, bankTag: 'axis 8020',
          reason: 'Table 7 (UPI)', date: '07:20 pm', payId: 'pay-today', ts: NOW - 45 * 60000 }
};

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
    'pos/unverified': {},
    'pos/ledgerEntries': {},
    'upiRouting/config': { 'ila_one@okaxis': { id: 'ila.one@okaxis', label: 'Axis', bank: 'axis 8020', active: true } }
  };
  window.__DATA = DATA;
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
      update: (v) => { record('update', p, v); return Promise.resolve(); },
      remove: () => { record('remove', p, null); return Promise.resolve(); },
      transaction: (_fn, cb) => { const s = snapOf(null); if (cb) cb(null, false, s); return Promise.resolve({ committed: false, snapshot: s }); }
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

  // A till holding one live unverified line and whatever is parked in pos/unverified.
  async function till(carry, ledger) {
    ledger = ledger || LEDGER;
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
    await page.evaluate(([cy, ledger]) => {
      window.__DATA['pos/unverified'] = cy;
      window.salesLedgerMap = ledger;
      window.salesLedger = Object.values(ledger);
      window.pendingWebOrders = {};
      window.activeTables = {}; window.pastBills = [];
      window.startVerificationReconciler();
    }, [carry, ledger]);
    await sleep(400);
    return { ctx, page, seen };
  }

  // Every verification is written as one root-level multi-path update, so what was
  // verified is a set of KEYS inside it rather than a path written to.
  const verified = (seen) => {
    const out = [];
    seen.ops.forEach(o => {
      if (o.op !== 'update' || !o.value || typeof o.value !== 'object') return;
      Object.keys(o.value).forEach(k => { if (/\/state$/.test(k) && o.value[k] === 'verified') out.push(k); });
    });
    return out;
  };
  const trail = (seen) => seen.ops.map(o => o.op + ' ' + o.path).join(', ') || '(nothing written)';

  try {
    // ---------------------------- the credit is already spent on a parked row
    {
      const { ctx, seen } = await till(CARRY_VERIFIED);
      const v = verified(seen);
      check('a credit a verified parked row already holds does not verify a second sale',
            v.length === 0, v.join(', ') + ' — ' + trail(seen));
      note('the parked row lives on for two hourly Worker runs after it verifies');
      await ctx.close();
    }

    // ------------------------------- and the same credit, genuinely unspoken for
    //
    // The control. Without it the check above passes just as well on a reconciler
    // that has stopped verifying anything at all.
    {
      const { ctx, seen } = await till({});
      const v = verified(seen);
      check('the same credit with nothing holding it does verify the sale',
            v.length === 1 && v[0] === 'pos/ledgerEntries/L1/state', v.join(', ') + ' — ' + trail(seen));
      check('and binds the line to the credit that settled it',
            seen.ops.some(o => o.op === 'update' && o.value &&
                          String(o.value['pos/ledgerEntries/L1/ref']) === REF), trail(seen));
      await ctx.close();
    }

    // -------------------------- a parked row still waiting is still matched
    //
    // The fix moves the usedRefs add above the skip; it must not also stop an
    // unverified parked row from being settled, which is what pos/unverified is for.
    {
      // The live ledger holds a different amount, so the parked row is the only thing
      // this credit fits. Two entries and one credit is the ambiguous case and stays
      // refused — that is the reconciler working, not this.
      const { ctx, seen } = await till({
        'pay-yesterday': { state: 'unverified', amount: AMOUNT, bankTag: 'axis 8020',
                           ts: NOW - 40 * 60000, day: 'yesterday' }
      }, { 'L2': { type: 'upi_income', state: 'unverified', amount: 320, bankTag: 'axis 8020',
                   reason: 'Table 3 (UPI)', date: '07:40 pm', payId: 'pay-other', ts: NOW - 20 * 60000 } });
      const v = verified(seen);
      check('a parked row that is still waiting is settled by an unspent credit',
            v.length === 1 && v[0] === 'pos/unverified/pay-yesterday/state',
            v.join(', ') + ' — ' + trail(seen));
      note('pos/unverified is what stops a payment being lost when the day closes on it');
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
