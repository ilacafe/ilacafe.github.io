// The fault that used to go nowhere.
//
// The Worker is the component nobody watches, so it is the one that is watched:
// ops/cronFailure for a throw, ops/pushHealth for whether a notification landed,
// ops/cronHeartbeat for whether a scheduled job ran at all, and a GitHub workflow
// reading the last of those from outside.
//
// The tills had none of it. Across the seven pages there are 113 `catch (e) {}` and a
// score of console.error, on devices with no console open, in a café. Every fault
// found in this project so far was found by somebody noticing something odd at the
// counter, or by reading the source afterwards.
//
// The sharpest case is the one that cost money. The ordering page wrote an order, the
// database refused it for being one field too long, and the rejection was attached to
// nothing — an `unhandledrejection`, which the browser raises and nothing was
// listening for. A customer paid for an order that did not exist. So that exact shape
// is the first thing this asks about.
//
// It is a browser test because none of it exists outside one: window.onerror,
// unhandledrejection and document's own error events are the browser's, and a source
// scan can see the handlers are installed without ever finding out whether a real
// throw reaches the database.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Faults on the tills — the ones that used to go nowhere');

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

// Every write reported out, and a signed-in user whose anonymity the test controls —
// that flag is the whole of what decides whether a customer's browser reports.
const STUB = (anonymous) => `
(() => {
  window.__writes = [];
  const rec = (op, p, v) => {
    let value = null;
    try { value = v === undefined ? null : JSON.parse(JSON.stringify(v)); } catch (e) { value = '[x]'; }
    window.__writes.push({ op: op, path: p, value: value });
  };
  const snapOf = (v) => ({ key: null, val: () => (v === undefined ? null : v),
    exists: () => v != null, numChildren: () => 0, hasChild: () => false,
    child: () => snapOf(null), forEach: () => {} });
  const mkRef = (p) => { const self = {
    key: p.split('/').filter(Boolean).pop() || null,
    child: (c) => mkRef(p + '/' + c),
    orderByChild: () => self, orderByKey: () => self, limitToLast: () => self,
    limitToFirst: () => self, startAt: () => self, endAt: () => self, equalTo: () => self,
    on: (e, cb) => { if (cb && (!e || e === 'value')) setTimeout(() => cb(snapOf(null)), 0); return cb; },
    off: () => {},
    once: (_e, cb) => { const s = snapOf(null); if (cb) cb(s); return Promise.resolve(s); },
    push: () => mkRef(p + '/-N'), set: (v) => { rec('set', p, v); return Promise.resolve(); },
    update: (v) => { rec('update', p, v); return Promise.resolve(); },
    remove: () => Promise.resolve(),
    transaction: (f, cb) => { rec('txn', p, null); const s = snapOf(null); if (cb) cb(null, true, s);
                              return Promise.resolve({ committed: true, snapshot: s }); }
  }; return self; };
  const db = { ref: (p) => mkRef(String(p == null ? '' : p).replace(/^\\/+|\\/+$/g, '')),
               goOnline: () => {}, goOffline: () => {} };
  const database = () => db;
  database.ServerValue = { TIMESTAMP: 1756200000000, increment: (n) => ({ '.sv': { increment: n } }) };
  window.firebase = {
    initializeApp: () => ({}), apps: [{}], database: database,
    auth: () => ({ onAuthStateChanged: () => {}, signOut: () => Promise.resolve(),
                   currentUser: { uid: 'u1', isAnonymous: ${anonymous ? 'true' : 'false'},
                                  getIdToken: () => Promise.resolve('t') } })
  };
})();
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});

  // A page, opened with a session that is or is not anonymous. Page errors are NOT
  // collected into a failure list here — throwing on purpose is what this suite does.
  async function open(page, anonymous) {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const pg = await ctx.newPage();
    await pg.addInitScript(STUB(!!anonymous));
    await pg.route('**/*', r =>
      r.request().url().startsWith(base) ? r.continue() : r.abort());
    await pg.goto(base + '/' + page, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(300);
    return { ctx, pg };
  }
  // ROWS, not writes. A report is two writes on purpose — the record, and a
  // transaction on firstAt that only lands if the row is new, so the age of a fault
  // survives every later occurrence overwriting the rest of it. What matters is how
  // many ROWS a burst of faults creates, because that is what the node's length is.
  const reports = (pg) => pg.evaluate(() => {
    const w = window.__writes.filter(x => x.path.indexOf('ops/clientErrors/') === 0);
    const rows = {};
    w.forEach(x => {
      const key = x.path.replace(/\/firstAt$/, '');
      rows[key] = rows[key] || {};
      if (x.op === 'update' && x.value) Object.assign(rows[key], x.value);
    });
    return { keys: Object.keys(rows), values: rows, writes: w.length };
  });

  try {
    // ------------------------------------------------- the rejection nobody was holding
    {
      const { ctx, pg } = await open('pos.html');
      await pg.evaluate(() => {
        // Exactly the shape that lost an order: a database write refused, its rejection
        // attached to nothing at all.
        Promise.reject(new Error('PERMISSION_DENIED: Client doesn\'t have permission'));
      });
      await sleep(300);
      const r = await reports(pg);
      check('an unhandled rejection is reported', r.keys.length === 1, JSON.stringify(r.keys));
      const v = r.values[r.keys[0]] || {};
      check('and says what it was', /PERMISSION_DENIED/.test(String(v.message || '')), JSON.stringify(v.message));
      check('and which page it was on', v.page === 'pos_html', JSON.stringify(v.page));
      check('and which build, so a fixed fault can be told from a live one',
            typeof v.build === 'string' && v.build.length > 0, JSON.stringify(v.build));
      check('and counts, rather than appending a row per occurrence',
            !!(v.count && v.count['.sv'] && v.count['.sv'].increment === 1), JSON.stringify(v.count));
      note('the order that was refused for one long field was exactly this event');
      await ctx.close();
    }

    // ------------------------------------------------------------- an uncaught throw
    {
      const { ctx, pg } = await open('pos.html');
      await pg.evaluate(() => { setTimeout(() => { throw new Error('boom from a timer'); }, 0); });
      await sleep(300);
      const r = await reports(pg);
      const v = r.values[r.keys[0]] || {};
      check('an uncaught throw is reported too', r.keys.length === 1, JSON.stringify(r.keys));
      check('with the message on it', /boom from a timer/.test(String(v.message || '')), JSON.stringify(v.message));
      check('and where it came from', /pos\.html|:\d+/.test(String(v.source || '')), JSON.stringify(v.source));
      await ctx.close();
    }

    // ---------------------------------------------- the same fault, over and over
    //
    // A loop that throws must not become a loop that writes. One row, one signature,
    // and a count — the node is as long as the number of distinct faults.
    {
      const { ctx, pg } = await open('pos.html');
      await pg.evaluate(() => {
        for (let i = 0; i < 25; i++) Promise.reject(new Error('the same thing again'));
      });
      await sleep(400);
      const r = await reports(pg);
      check('twenty-five of one fault is one row, not twenty-five', r.keys.length === 1,
            r.keys.length + ' row(s) for 25 rejections');
      check('and it took a handful of writes, not fifty', r.writes <= 3,
            r.writes + ' write(s)');
      note('the key is a signature, so the hundredth occurrence overwrites the first');
      await ctx.close();
    }

    // ------------------------------------------------------- and a burst of new ones
    {
      const { ctx, pg } = await open('pos.html');
      await pg.evaluate(() => {
        for (let i = 0; i < 40; i++) Promise.reject(new Error('distinct fault number ' + i));
      });
      await sleep(400);
      const r = await reports(pg);
      check('forty different faults are capped rather than flooding the database',
            r.keys.length > 0 && r.keys.length <= 8,
            r.keys.length + ' row(s) for 40 distinct rejections');
      note('a page coming apart must not also fill the node it is reporting into');
      await ctx.close();
    }

    // ----------------------------------------------- the customer page, deliberately not
    //
    // connection.js runs on the ordering page too, and skips an anonymous session on
    // purpose: collecting from a stranger's browser would mean a node the world can
    // write to, on the database that holds the café's takings. The rules say the same
    // thing — see rules-emulator.test.js — and this is the near half of it, so the page
    // does not spend a till's connection on a write that will be refused.
    {
      const { ctx, pg } = await open('index.html', true);
      await pg.evaluate(() => { Promise.reject(new Error('a customer’s browser threw')); });
      await sleep(300);
      const r = await reports(pg);
      check('an anonymous session reports nothing', r.keys.length === 0, JSON.stringify(r.keys));
      note('a real gap in the reporting, and the trade is deliberate');
      await ctx.close();
    }

    // ------------------------------------------------------ every page carries it
    {
      const missing = [];
      for (const page of ['pos.html', 'admin.html', 'analytics.html', 'inventory.html',
                          'chef.html', 'barista.html']) {
        const { ctx, pg } = await open(page);
        await pg.evaluate(() => { Promise.reject(new Error('reaches the database')); });
        await sleep(250);
        if ((await reports(pg)).keys.length === 0) missing.push(page);
        await ctx.close();
      }
      check('every staff page reports its own faults', missing.length === 0,
            missing.join(', ') + ' — connection.js is loaded but nothing arrived');
    }
  } finally {
    await browser.close();
    server.close();
  }

  done();
})();
