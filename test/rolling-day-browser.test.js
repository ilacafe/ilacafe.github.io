// The listener that stays on the day it was bound to.
//
// THE SCREENS ARE NEVER RELOADED, and that is not an accident of use — it is how this
// app is built. A till is a tablet somebody switches on; EOD deliberately does not
// reload the page, because a closing must not lose what is on screen; and the only
// location.reload() on the till is sign-out. So a tab lives for days.
//
// Two nodes are named after a date. Every WRITE to them computed the key fresh, and
// both READS were listeners bound once at boot:
//
//   pos/tips/{day}             Tips are a liability the café owes its staff in cash,
//                              so they survive EOD on purpose. Once the key rolled
//                              (it is a UTC date, so 05:30 IST), new tips went to the
//                              new day and the card went on showing the old one —
//                              already paid out, so the payout button hid itself.
//                              The tips were in the database and were invisible and
//                              unpayable on the screen, with nothing to say why.
//
//   upiRouting/totals/{month}  What is left under each VPA's monthly cap. It is not
//                              just a display: it feeds settings/upiList, which the
//                              ordering page reads to pick the VPA a customer pays.
//
// It is a browser test because the failure is not visible in the source — both call
// sites LOOK right, and what is wrong is that one of them is evaluated once. Only
// running a real page across a real rollover asks the question.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('The day rolls; the listener has to roll with it');

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

// Two days of tips: yesterday settled in full, today collected and owing. That pair is
// the whole finding — a till holding yesterday sees nothing to pay out while today's
// tips sit in the database.
const DAY1 = '2026-09-10', DAY2 = '2026-09-11';
const AT_DAY1 = '2026-09-10T20:00:00Z';   // before the UTC rollover
const AT_DAY2 = '2026-09-11T02:00:00Z';   // after it

const STUB = (nowIso) => `
(() => {
  // A clock the test moves. The pages ask for the date with new Date(), so this has to
  // be the constructor, not just Date.now().
  const Real = Date;
  window.__setNow = (iso) => {
    const fixed = Real.parse(iso);
    function Fake(...a){ return a.length ? new Real(...a) : new Real(fixed); }
    Fake.prototype = Real.prototype;
    Fake.now = () => fixed;
    Fake.parse = Real.parse; Fake.UTC = Real.UTC;
    window.Date = Fake;
  };
  window.__setNow(${JSON.stringify(nowIso)});

  window.__bound = [];      // every path a listener was attached to, in order
  window.__unbound = [];    // every path one was detached from
  window.__writes = [];

  const DATA = {
    'pos/tips/${DAY1}': { accrued: 500, paidOut: 500 },   // yesterday: settled
    'pos/tips/${DAY2}': { accrued: 300, paidOut: 0 },     // today: owing
    'pos/tips/lastHeads': 2,
    'upiRouting/totals/2026-09': { a: 1 },
    'upiRouting/totals/2026-10': { b: 2 }
  };
  const snapOf = (v, key) => ({ key: key == null ? null : key,
    val: () => (v === undefined ? null : v),
    exists: () => v != null, numChildren: () => 0, hasChild: () => false,
    child: () => snapOf(null, null), forEach: () => {} });
  const mkRef = (p) => { const self = {
    key: p.split('/').filter(Boolean).pop() || null,
    child: (c) => mkRef(p + '/' + c),
    orderByChild: () => self, orderByKey: () => self, limitToLast: () => self,
    limitToFirst: () => self, startAt: () => self, endAt: () => self, equalTo: () => self,
    on: (e, cb) => {
      if (!e || e === 'value') {
        window.__bound.push(p);
        if (cb) setTimeout(() => cb(snapOf(DATA[p], self.key)), 0);
      }
      return cb;
    },
    off: (e, cb) => { window.__unbound.push(p); },
    once: (_e, cb) => { const s = snapOf(DATA[p], self.key); if (cb) cb(s); return Promise.resolve(s); },
    push: () => mkRef(p + '/-N'),
    set: (v) => { window.__writes.push({ op: 'set', path: p }); return Promise.resolve(); },
    update: (v) => { window.__writes.push({ op: 'update', path: p, value: v }); return Promise.resolve(); },
    remove: () => Promise.resolve(),
    transaction: (f, cb) => { const s = snapOf(null, self.key); if (cb) cb(null, true, s);
                              return Promise.resolve({ committed: true, snapshot: s }); }
  }; return self; };
  const db = { ref: (p) => mkRef(String(p == null ? '' : p).replace(/^\\/+|\\/+$/g, '')),
               goOnline: () => {}, goOffline: () => {} };
  const database = () => db;
  database.ServerValue = { TIMESTAMP: 1757548800000, increment: (n) => ({ '.sv': { increment: n } }) };
  window.firebase = {
    initializeApp: () => ({}), apps: [{}], database: database,
    auth: () => ({ onAuthStateChanged: () => {}, signOut: () => Promise.resolve(),
                   currentUser: { uid: 'u1', isAnonymous: false,
                                  getIdToken: () => Promise.resolve('t') } })
  };
})();
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Only the paths this is about — the pages bind dozens of listeners.
const only = (list, prefix) => list.filter(p => p.indexOf(prefix) === 0);

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const pageErrors = [];

  async function open(page, nowIso, starter) {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const pg = await ctx.newPage();
    pg.on('pageerror', e => pageErrors.push(page + ': ' + String(e.message || e).split('\n')[0]));
    await pg.addInitScript(STUB(nowIso));
    await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await pg.goto(base + '/' + page, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(400);
    // Both feeds are started from behind a sign-in — startAuthedListeners() on the till,
    // loadAdminData() on admin — and a sign-in is not what this suite is about. So auth
    // is left hanging in the stub and the entry point is driven directly, the same way
    // eod-browser.test.js drives promptEOD. Everything from here on is the page's own
    // code: the rolling bind, the rebind, and the render that follows it.
    if (starter) await pg.evaluate((fn) => window[fn] ? window[fn]() : eval(fn + '()'), starter);
    await pg.waitForTimeout(300);
    return { ctx, pg };
  }

  // Move the clock and wake the tab. visibilitychange is the trigger that matters in
  // real life: the tablet was asleep all night, background timers were throttled or
  // suspended, and the first thing that happens is somebody picking it up.
  async function rollTo(pg, iso) {
    await pg.evaluate((t) => { window.__setNow(t); document.dispatchEvent(new Event('visibilitychange')); }, iso);
    await pg.waitForTimeout(250);
  }

  try {
    // ------------------------------------------------------------- the tip pool
    {
      const { ctx, pg } = await open('pos.html', AT_DAY1, 'startTipFeed');

      const first = only(await pg.evaluate(() => window.__bound), 'pos/tips/2');
      check('the till starts on the day it booted', first.includes('pos/tips/' + DAY1),
            JSON.stringify(first));

      const before = await pg.evaluate(() => ({
        pool: window.tipPool,
        payable: (() => { const b = document.getElementById('tip-payout-btn'); return b ? b.style.display !== 'none' : null; })()
      }));
      check('yesterday was settled, so there is nothing to pay out',
            before.pool.accrued === 500 && before.pool.paidOut === 500 && before.payable === false,
            JSON.stringify(before));

      await rollTo(pg, AT_DAY2);

      const after = await pg.evaluate(() => ({
        bound: window.__bound.filter(p => p.indexOf('pos/tips/2') === 0),
        unbound: window.__unbound.filter(p => p.indexOf('pos/tips/2') === 0),
        pool: window.tipPool,
        payable: (() => { const b = document.getElementById('tip-payout-btn'); return b ? b.style.display !== 'none' : null; })()
      }));
      check('when the day rolls the listener moves to it',
            after.bound.includes('pos/tips/' + DAY2), JSON.stringify(after.bound));
      check('and lets go of the day it was on, rather than holding both',
            after.unbound.includes('pos/tips/' + DAY1), JSON.stringify(after.unbound));
      check('the card now shows today’s tips, which were there all along',
            after.pool.accrued === 300 && after.pool.paidOut === 0, JSON.stringify(after.pool));
      check('and the payout button comes back',
            after.payable === true, 'still hidden — staff cannot be paid what they collected');
      note('held on yesterday, the card read "already paid out" and offered no way to pay today');

      // Rebinding is not free if it happens on every check: the check is a string
      // compare, and only a path that CHANGED may touch the network.
      const churn = await pg.evaluate(async () => {
        const n0 = window.__bound.length;
        for (let i = 0; i < 5; i++) document.dispatchEvent(new Event('visibilitychange'));
        await new Promise(r => setTimeout(r, 150));
        return window.__bound.length - n0;
      });
      check('and a check that finds the same day rebinds nothing', churn === 0,
            churn + ' extra listener(s) for 5 checks on an unchanged day');
      await ctx.close();
    }

    // ------------------------------------- and the payout settles the day it displayed
    //
    // The sharper half. Everything between reading the pool and writing it back awaits
    // — a PIN prompt, a drawer warning, a Worker round trip — and that is minutes. If
    // the day turns in the middle, paidOut must still land on the day the money was
    // collected on. Otherwise the drawer pays out a liability that stays on the books
    // and a day nobody collected on is marked settled.
    {
      const { ctx, pg } = await open('pos.html', AT_DAY1, 'startTipFeed');
      await pg.evaluate(() => {
        // A pool with something owing, and a payout that will succeed.
        window.tipPool = { accrued: 500, paidOut: 0, day: '__DAY1__' };
        window.lastTipHeads = 2;
        window.cashDrawer = 10000;
        window.ilaAskText = () => Promise.resolve('4821');
        window.ilaAsk = () => Promise.resolve(true);
        window.ilaTell = () => Promise.resolve();
        window.ilaToast = () => {};
        window.posCashOut = async () => ({ ok: true, by: 'Asha' });
      });
      await pg.evaluate((d) => { window.tipPool.day = d; }, DAY1);

      // The day turns while the cashier is typing.
      const wrote = await pg.evaluate(async (day2) => {
        const p = window.payOutTips();
        window.__setNow(day2);
        await p;
        return window.__writes.filter(w => w.path.indexOf('pos/tips/2') === 0);
      }, AT_DAY2);

      check('the payout is recorded against the day the tips were collected',
            wrote.length === 1 && wrote[0].path === 'pos/tips/' + DAY1,
            JSON.stringify(wrote.map(w => w.path)));
      check('and not against the day it happened to finish on',
            !wrote.some(w => w.path === 'pos/tips/' + DAY2),
            'yesterday’s liability would still be owing and today marked settled');
      await ctx.close();
    }

    // ------------------------------------------------------ the UPI monthly totals
    //
    // Same shape, one unit up, and this one is not only a display: syncPublicUPIList()
    // writes settings/upiList, which the ordering page reads to choose the VPA a
    // customer pays. Frozen on last month, the per-VPA caps stop being enforced.
    {
      const { ctx, pg } = await open('admin.html', '2026-09-20T10:00:00Z', 'loadUPIRouting');

      const first = only(await pg.evaluate(() => window.__bound), 'upiRouting/totals/2026');
      check('the admin screen starts on the month it booted',
            first.includes('upiRouting/totals/2026-09'), JSON.stringify(first));

      await rollTo(pg, '2026-10-01T10:00:00Z');

      const after = await pg.evaluate(() => ({
        bound: window.__bound.filter(p => p.indexOf('upiRouting/totals/2026') === 0),
        unbound: window.__unbound.filter(p => p.indexOf('upiRouting/totals/2026') === 0)
      }));
      check('when the month turns the listener moves to it',
            after.bound.includes('upiRouting/totals/2026-10'), JSON.stringify(after.bound));
      check('and releases the month it was on',
            after.unbound.includes('upiRouting/totals/2026-09'), JSON.stringify(after.unbound));
      note('the caps this feeds decide which VPA the ordering page sends a customer to');
      await ctx.close();
    }

    check('neither page threw while any of that ran', pageErrors.length === 0,
          pageErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.close();
  }

  done();
})();
