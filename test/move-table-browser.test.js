// Merging two bills, without losing whatever landed on the other one.
//
// Everywhere else in pos.html a table is changed with a field-level increment or inside
// a transaction. The note above calculateDailyCups says why: "writing the node from a
// local snapshot is what lost orders; don't reintroduce it." confirmMoveTable
// reintroduced it — it merged the two bills in JavaScript out of window.activeTables and
// wrote the result over the destination node whole. Anything that reached that table
// between the local read and the server applying the write was erased: an item another
// till added, a web order accepted onto it, a payment.
//
// AND THE WINDOW IS NOT A FEW MILLISECONDS. The SDK queues writes while the connection
// is down — the whole premise of connection.js. An increment or a transaction still
// resolves correctly whenever it lands; a whole-node write does not. A till that merges
// two tables on dead café wifi and reconnects ten minutes later overwrites everything
// the other till did to that table in between.
//
// So the stub below keeps a SERVER state that deliberately differs from what the page
// has in window.activeTables. That difference is the entire test: code that merges from
// the local copy cannot see the extra item, and code that merges on the server cannot
// miss it.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Moving a table onto another one');

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

// A database that actually holds state, so a transaction means something: the update
// function is applied to the CURRENT value, and returning undefined aborts.
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
// Reaching into a merged bill has to survive the merge having gone wrong: against the
// old code the line simply is not there, and a check that throws reports nothing and
// stops every check after it.
const at = (o, ...ks) => ks.reduce((a, k) => (a == null ? undefined : a[k]), o);

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
    // The dialogs answer themselves, and the two view calls are stubbed so this stays
    // about the merge rather than about rendering a checkout screen.
    await pg.evaluate(() => {
      window.__told = [];
      window.ilaAsk = () => Promise.resolve(true);
      window.ilaTell = (t, d) => { window.__told.push(String(t) + ' ' + (d || '')); return Promise.resolve(); };
      window.ilaToast = (m) => { window.__told.push(String(m)); };
      window.closeModal = () => {};
      window.openCheckout = () => {};
    });
    return { ctx, pg };
  }

  try {
    // ---------------------------------------------- the item that arrived in the meantime
    //
    // Table 7 already has a Cake on the server. This screen's window.activeTables does
    // not know about it — which is precisely the state a till is in when another device
    // rang it up a moment ago, or when this one has been offline.
    {
      const { ctx, pg } = await open();
      await pg.evaluate(() => {
        window.__setServer({
          'pos/activeTables/5': { items: { Latte: { price: 100, qty: 1 } }, total: 100, paid: 0 },
          'pos/activeTables/7': { items: { Cake:  { price: 200, qty: 1 } }, total: 200, paid: 0 }
        });
        // The stale local view: table 7 looks empty from here.
        window.activeTables = {
          '5': { items: { Latte: { price: 100, qty: 1 } }, total: 100, paid: 0 },
          '7': { items: {}, total: 0, paid: 0 }
        };
        window.checkoutTableID = '5';
      });
      await pg.evaluate(() => window.confirmMoveTable('7'));
      await sleep(400);

      const s = await pg.evaluate(() => window.__getServer());
      const dst = s['pos/activeTables/7'] || {};
      check('the bill that was already on the other table survives the merge',
            !!(dst.items && dst.items.Cake), JSON.stringify(dst.items));
      check('and the moved bill is on it too',
            !!(dst.items && dst.items.Latte), JSON.stringify(dst.items));
      check('the total is both bills, not just the one this screen could see',
            dst.total === 300, JSON.stringify(dst.total));
      check('and the old table is let go of', s['pos/activeTables/5'] === undefined,
            JSON.stringify(s['pos/activeTables/5']));
      note('merged from the local snapshot, the Cake is simply overwritten and gone');
      await ctx.close();
    }

    // ------------------------------------------------------ an empty table just receives
    {
      const { ctx, pg } = await open();
      await pg.evaluate(() => {
        window.__setServer({ 'pos/activeTables/5': { items: { Latte: { price: 100, qty: 2 } }, total: 200, paid: 50 } });
        window.activeTables = { '5': { items: { Latte: { price: 100, qty: 2 } }, total: 200, paid: 50 } };
        window.checkoutTableID = '5';
      });
      await pg.evaluate(() => window.confirmMoveTable('9'));
      await sleep(400);
      const s = await pg.evaluate(() => window.__getServer());
      const dst = s['pos/activeTables/9'] || {};
      check('moving onto a free table carries the whole bill',
            dst.total === 200 && dst.paid === 50 && at(dst, 'items', 'Latte', 'qty') === 2,
            JSON.stringify(dst));
      check('and nothing is left behind', s['pos/activeTables/5'] === undefined);
      await ctx.close();
    }

    // ------------------------------------------- the same item on both bills adds up
    //
    // += on a value read back from a database is how a quantity becomes a string. Every
    // qty is written with ServerValue.increment so both sides are numbers, but the merge
    // is the one place that adds two of them together by hand.
    {
      const { ctx, pg } = await open();
      await pg.evaluate(() => {
        window.__setServer({
          'pos/activeTables/5': { items: { Latte: { price: 100, qty: 2, paidAmt: 100 } }, total: 200, paid: 100 },
          'pos/activeTables/7': { items: { Latte: { price: 100, qty: 3, paidAmt: 50 } }, total: 300, paid: 50 }
        });
        window.activeTables = { '5': { items: {}, total: 0 }, '7': { items: {}, total: 0 } };
        window.checkoutTableID = '5';
      });
      await pg.evaluate(() => window.confirmMoveTable('7'));
      await sleep(400);
      const dst = (await pg.evaluate(() => window.__getServer()))['pos/activeTables/7'] || {};
      check('two of the same line make one line with the quantities added',
            at(dst, 'items', 'Latte', 'qty') === 5, JSON.stringify(at(dst, 'items', 'Latte')));
      check('and it is a number, not two numbers stuck together',
            typeof at(dst, 'items', 'Latte', 'qty') === 'number',
            typeof at(dst, 'items', 'Latte', 'qty'));
      check('what was already paid against that line travels with it',
            at(dst, 'items', 'Latte', 'paidAmt') === 150,
            JSON.stringify(at(dst, 'items', 'Latte', 'paidAmt')));
      check('and the table totals add up', dst.total === 500 && dst.paid === 150,
            JSON.stringify({ total: dst.total, paid: dst.paid }));
      note('a part-paid line arriving as unpaid would disagree with the table’s own paid figure');
      await ctx.close();
    }

    // ------------------------------------------------ a move that cannot be saved says so
    //
    // The old version's only failure handler was console.error, on a tablet with no
    // console: the screen had already been mutated to show the merge, so a move that
    // never happened looked like one that had.
    {
      const { ctx, pg } = await open();
      await pg.evaluate(() => {
        window.__setServer({ 'pos/activeTables/5': { items: { Latte: { price: 100, qty: 1 } }, total: 100 } });
        window.activeTables = { '5': { items: { Latte: { price: 100, qty: 1 } }, total: 100 } };
        window.checkoutTableID = '5';
        // The destination refuses the write, the way a rules failure or a dead uplink does.
        const realRef = window.firebase.database().ref;
        window.firebase.database().ref = (p) => {
          const r = realRef(p);
          if (p === 'pos/activeTables/9') {
            r.transaction = (fn, cb) => { if (cb) cb(new Error('PERMISSION_DENIED'), false, null); return Promise.resolve({ committed: false }); };
          }
          return r;
        };
      });
      await pg.evaluate(() => window.confirmMoveTable('9'));
      await sleep(400);
      const r = await pg.evaluate(() => ({ told: window.__told.join(' | '), server: window.__getServer() }));
      check('a refused move tells the cashier, rather than only a console',
            /did not move/i.test(r.told), r.told || '(said nothing)');
      check('and says where the bill still is',
            /table 5/i.test(r.told), r.told);
      check('and the bill really is still there',
            !!r.server['pos/activeTables/5'], JSON.stringify(r.server));
      await ctx.close();
    }

    // ------------------------------------- and the cache that used to stop the till starting
    //
    // window.staffPins and window.cart were restored with a bare JSON.parse on the boot
    // path. JSON.parse(null) is null rather than a throw, so a missing key was never the
    // hazard — a corrupt one is, and there the inline script stops at that line and the
    // till never opens at all. ilaStored drops the bad value, reports it, and carries on.
    {
      const ctx = await browser.newContext({ serviceWorkers: 'block' });
      const pg = await ctx.newPage();
      pg.on('pageerror', e => pageErrors.push('corrupt-cache: ' + String(e.message || e).split('\n')[0]));
      await pg.addInitScript(STUB);
      await pg.addInitScript(() => {
        try {
          localStorage.setItem('ila_cached_staff', '{"1234":"Asha"');   // truncated
          localStorage.setItem('ila_pos_cart', 'not json at all');
        } catch (e) {}
      });
      await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
      await pg.goto(base + '/pos.html', { waitUntil: 'domcontentloaded' });
      await pg.waitForTimeout(500);

      const r = await pg.evaluate(() => ({
        booted: typeof window.confirmMoveTable === 'function',
        pins: window.staffPins, cart: window.cart,
        left: (() => { try { return localStorage.getItem('ila_cached_staff'); } catch (e) { return 'x'; } })()
      }));
      check('a corrupt cache does not stop the till opening', r.booted === true,
            'the inline script threw and never finished');
      check('and the bad value is replaced with an empty one, not left half-read',
            JSON.stringify(r.pins) === '{}' && JSON.stringify(r.cart) === '{}',
            JSON.stringify({ pins: r.pins, cart: r.cart }));
      check('and discarded, so the next open is not the same failure', r.left === null,
            JSON.stringify(r.left));
      note('it is reported too — a page that fell back silently looks like a page with no cart');
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
