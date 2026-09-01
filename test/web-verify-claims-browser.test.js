// Which credits the till believes are already spoken for.
//
// A web order's "✓ paid" badge, and the sweep that books the money behind it,
// both ask wvFindMatch whether a bank credit has already been claimed. That
// answer came from one read of payments/claims with limitToLast(150).
//
// payments/claims is keyed by the bank's own reference, and a bank reference is
// not a clock. With no orderBy, limitToLast sorts by KEY — so once more than 150
// credits have ever been claimed, the visible set is a fixed lexicographic slice
// that mostly does not contain today's. A claim missing from that slice reads as
// UNCLAIMED, and the order is shown "✓ paid" against a credit the counter has
// already taken. Staff hand food over on that badge.
//
// This drives the real feed in a real browser against a database stub that sorts
// the way Firebase does, with the recent claims deliberately sorting low. The
// question is what the page ends up believing, which is why it is asked of the
// page rather than of the source.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Web-order payments — which credits are already taken');

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

// Refs beginning 1… are this evening's; refs beginning 9… are the years of
// already-claimed credits behind them. Sorted by key, the 9s win every time.
const recentRef = (n) => '1000000000' + String(n).padStart(2, '0');
const oldRef = (n) => '9000000000' + String(n).padStart(2, '0');

// Sixty credits in the window, alternating claimed and free.
const CREDITS = {};
for (let i = 0; i < 60; i++) {
  CREDITS[recentRef(i)] = { amount: 100 + i, ref: recentRef(i), at: NOW - (60 - i) * 60000, bank: 'yes', acct: '8020' };
}
const CLAIMS = {};
for (let i = 0; i < 300; i++) CLAIMS[oldRef(i)] = 'pos-old-' + i;      // years of settled trade
for (let i = 0; i < 60; i += 2) CLAIMS[recentRef(i)] = 'pos-7-' + i;   // half of tonight's, taken at the counter

// A database that sorts the way Firebase does, and says so when it is asked for a
// whole node: limitToLast with no orderBy is a limit on KEYS, not on time.
const STUB = `
(() => {
  const DATA = {
    'payments/incoming': ${JSON.stringify(CREDITS)},
    'payments/claims': ${JSON.stringify(CLAIMS)},
    'pos/unverified': {}, 'pos/ledgerEntries': {}, 'upiRouting/config': {}
  };
  window.__DATA = DATA;
  window.__reads = [];                 // { path, orderBy, limit } — every read the page opened
  const listeners = [];                // { path, q, cb }

  const valueAt = (p, q) => {
    if (Object.prototype.hasOwnProperty.call(DATA, p)) {
      const node = DATA[p];
      let keys = Object.keys(node);
      if (q.orderBy) keys.sort((a, b) => {
        const d = ((node[a] || {})[q.orderBy] || 0) - ((node[b] || {})[q.orderBy] || 0);
        return d !== 0 ? d : (a < b ? -1 : a > b ? 1 : 0);
      });
      else keys.sort();                                 // no orderBy: Firebase orders by key
      if (q.limitToLast) keys = keys.slice(-q.limitToLast);
      const out = {};
      keys.forEach(k => { out[k] = node[k]; });
      return out;
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
      // 'value' only. A child_added handler expects one child, and handing it the
      // whole node is a stub bug that reads like a page bug.
      on: (e, cb) => {
        if (e && e !== 'value') return cb;
        window.__reads.push({ path: p, orderBy: q.orderBy || null, limit: q.limitToLast || null });
        const rec = { path: p, q: q, cb: cb };
        listeners.push(rec);
        setTimeout(() => cb(snapOf(valueAt(p, q))), 0);
        return cb;
      },
      off: (_e, cb) => {
        for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].cb === cb) listeners.splice(i, 1);
      },
      once: (_e, cb) => {
        window.__reads.push({ path: p, orderBy: q.orderBy || null, limit: q.limitToLast || null });
        const s = snapOf(valueAt(p, q)); if (cb) cb(s); return Promise.resolve(s);
      },
      push: () => mkRef(p + '/-Nstub', {}),
      set: () => Promise.resolve(), update: () => Promise.resolve(), remove: () => Promise.resolve(),
      transaction: (_fn, cb) => { const s = snapOf(null); if (cb) cb(null, false, s); return Promise.resolve({ committed: false, snapshot: s }); }
    };
    return self;
  };

  window.__liveListeners = () => listeners.map(l => l.path);
  // Only the listeners on the node that changed, the way a database would.
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
})();
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const pageErrors = [];

  try {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    page.on('pageerror', e => pageErrors.push(String(e.message || e).split('\n')[0]));
    await page.addInitScript(STUB);
    await page.route('**/*', route =>
      route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base + '/pos.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);

    await page.evaluate(() => { window.startVerificationReconciler(); window.ensureWebVerifyFeeds(); });
    await sleep(500);

    const state = await page.evaluate(() => ({
      credits: Object.keys(window._wvCredits),
      claims: window._wvClaims,
      watched: Object.keys(window._wvClaimWatch || {}),
      reads: window.__reads
    }));

    check('the sixty credits in the window are the ones being matched against',
          state.credits.length === 60, state.credits.length + ' credit(s)');

    // The claim on each of those credits, as the database actually holds it.
    const truth = {};
    state.credits.forEach(ref => { if (CLAIMS[ref]) truth[ref] = CLAIMS[ref]; });
    const missed = Object.keys(truth).filter(ref => state.claims[ref] !== truth[ref]);
    check('every credit already taken is known to be taken', missed.length === 0,
          missed.length + ' claimed credit(s) look free: ' + missed.slice(0, 3).join(', '));
    note('limitToLast(150) on a node keyed by bank reference returned none of these');

    const invented = state.credits.filter(ref => !CLAIMS[ref] && state.claims[ref] != null);
    check('and no free credit is reported as taken', invented.length === 0, invented.slice(0, 3).join(', '));

    const whole = state.reads.filter(r => r.path === 'payments/claims');
    check('the whole claims node is never read', whole.length === 0,
          JSON.stringify(whole.slice(0, 2)));
    note('it grows by one child per credit ever claimed and is never pruned');

    check('one leaf watch per credit in the window, and no more',
          state.watched.length === 60, state.watched.length + ' watch(es)');

    // The real matcher, against the real belief.
    const matched = await page.evaluate(([now]) => {
      const taken = Object.keys(window._wvCredits).find(r => window._wvClaims[r]);
      const free = Object.keys(window._wvCredits).find(r => !window._wvClaims[r]);
      // Billed to a VPA the café actually offers — which is what an order carries,
      // since the ordering page picks it off the same routing list this till reads.
      const ours = (window.activeUPIs || [])[0];
      const order = (ref, vpa) => ({ total: window._wvCredits[ref].amount, upiId: vpa || ours,
                                     billedAt: window._wvCredits[ref].at - 60000, trackId: 'tk1' });
      return {
        taken: taken, free: free, ours: ours,
        onTaken: window.wvFindMatch(order(taken), window._wvCredits, window._wvClaims, now),
        onFree: window.wvFindMatch(order(free), window._wvCredits, window._wvClaims, now),
        // The same free credit, wanted by an order billed to somebody else's VPA.
        onStranger: window.wvFindMatch(order(free, 'attacker@ybl'), window._wvCredits, window._wvClaims, now)
      };
    }, [NOW]);
    check('a credit the counter has taken is not offered to a web order',
          matched.onTaken === null || matched.onTaken.ref !== matched.taken,
          'offered ' + JSON.stringify(matched.onTaken && matched.onTaken.ref));
    check('and one nobody has taken still is',
          !!matched.onFree && matched.onFree.ref === matched.free,
          'got ' + JSON.stringify(matched.onFree && matched.onFree.ref));

    // The VPA on a web order is written by the customer's own browser, so it proves
    // nothing by itself. An order billed to a VPA the café does not hand out would
    // otherwise take the next credit of its amount from whoever actually paid it —
    // upiBankMatch cannot stop it, because an unknown VPA fail-opens by design.
    check('an order billed to a VPA the café does not own is offered nothing',
          matched.onStranger === null,
          'offered ' + JSON.stringify(matched.onStranger && matched.onStranger.ref));
    note('the customer picks the VPA now; this is what makes that safe');

    // WHICH CLOCK DECIDES.
    //
    // A credit carries `at` — when the Worker ingested the bank's alert — and
    // bankTime, when the bank says the money actually moved. A bank alert can sit in
    // a queue for hours, so judged on `at` alone a payment made an hour BEFORE this
    // customer had even ordered still looked like it could be theirs, purely because
    // its email happened to land afterwards. That is somebody else's money.
    const clocks = await page.evaluate(([now]) => {
      const ours = (window.activeUPIs || [])[0];
      const askedAt = now - 10 * 60000;                       // code shown 10 minutes ago
      const order = { total: 777, upiId: ours, billedAt: askedAt, trackId: 'tk-clock' };
      // same credit every time; only the bank's stated time moves. `at` is always
      // recent, which is what a delayed email looks like.
      const credit = (bankTime) => ({ CLK1: { amount: 777, ref: 'CLK1', at: now - 60000, bankTime: bankTime } });
      return {
        before: window.wvFindMatch(order, credit(now - 70 * 60000), {}, now),
        after:  window.wvFindMatch(order, credit(askedAt + 60000), {}, now),
        none:   window.wvFindMatch(order, credit(null), {}, now)
      };
    }, [NOW]);
    check('a payment made before the customer ordered is not theirs, however late the email',
          clocks.before === null, 'offered ' + JSON.stringify(clocks.before && clocks.before.ref));
    check('one made after they were asked still is, however late the email',
          !!clocks.after && clocks.after.ref === 'CLK1', JSON.stringify(clocks.after));
    check('and a credit with no bank clock falls back to the ingest one, as before',
          !!clocks.none && clocks.none.ref === 'CLK1', JSON.stringify(clocks.none));
    note('bankTime is null whenever the Worker was unsure of the format — that path is the old one');

    // billedAt used to be called payLinkSentAt. Rules deploy separately from pages, so
    // for as long as a customer's browser might still hold the older page, orders
    // arrive under the old name — and an order the till cannot read the billing time
    // off is an order it will not match to any credit at all.
    const legacy = await page.evaluate(([now]) => {
      const ours = (window.activeUPIs || [])[0];
      const askedAt = now - 10 * 60000;
      const credits = { LEG1: { amount: 778, ref: 'LEG1', at: now - 60000, bankTime: askedAt + 60000 } };
      return {
        old: window.wvFindMatch({ total: 778, upiId: ours, payLinkSentAt: askedAt, trackId: 'tk-old' }, credits, {}, now),
        neither: window.wvFindMatch({ total: 778, upiId: ours, trackId: 'tk-none' }, credits, {}, now)
      };
    }, [NOW]);
    check('an order billed under the old field name still matches',
          !!legacy.old && legacy.old.ref === 'LEG1', JSON.stringify(legacy.old));
    check('and one billed under neither still matches nothing',
          legacy.neither === null, JSON.stringify(legacy.neither));

    // A claim landing now, from another till, has to reach this one.
    const late = await page.evaluate(() => {
      const free = Object.keys(window._wvCredits).find(r => !window._wvClaims[r]);
      window.__DATA['payments/claims'][free] = 'pos-other-till';
      window.__emit('payments/claims');
      return free;
    });
    await sleep(200);
    const afterLate = await page.evaluate(([ref]) => window._wvClaims[ref] || null, [late]);
    check('a claim made at another till reaches this one while it watches',
          afterLate === 'pos-other-till', String(afterLate));
    note('a one-shot read would have left this credit looking free all evening');

    // Credits roll out of the window as the evening goes on.
    const rolled = await page.evaluate(([now]) => {
      const dropped = Object.keys(window._wvCredits).slice(0, 10);
      dropped.forEach(r => { delete window.__DATA['payments/incoming'][r]; });
      for (let i = 0; i < 10; i++) {
        const r = '2000000000' + String(i).padStart(2, '0');
        window.__DATA['payments/incoming'][r] = { amount: 500 + i, ref: r, at: now + i * 1000, bank: 'yes', acct: '8020' };
      }
      window.__emit('payments/incoming');
      return dropped;
    }, [NOW]);
    await sleep(300);
    const after = await page.evaluate(([dropped]) => ({
      watched: Object.keys(window._wvClaimWatch || {}).length,
      credits: Object.keys(window._wvCredits).length,
      stale: dropped.filter(r => window._wvClaims[r] != null || (window._wvClaimWatch || {})[r]),
      live: window.__liveListeners().filter(p => p.indexOf('payments/claims/') === 0).length
    }), [rolled]);
    check('a credit that falls out of the window is stopped being watched',
          after.stale.length === 0, after.stale.slice(0, 3).join(', '));
    check('and the watch count follows the window rather than growing',
          after.watched === after.credits && after.live === after.credits,
          after.watched + ' watched, ' + after.live + ' live, for ' + after.credits + ' credits');
    note('otherwise a till open all day accumulates one listener per credit of the day');

    check('the page threw no errors while any of that ran', pageErrors.length === 0,
          pageErrors.slice(0, 3).join(' | '));
    await ctx.close();
  } finally {
    await browser.close();
    server.close();
  }

  done();
})();
