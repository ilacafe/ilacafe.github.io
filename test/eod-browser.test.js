// Cash-up, driven through the real pos.html in a browser.
//
// promptEOD is the biggest single money moment of the day: it writes the only
// permanent record of the day's takings to pos/eodArchive and then clears the
// live till for tomorrow. Both used to be fire-and-forget. The reset ran inside
// a .then() while the function carried straight on to `location.href = wa.me/…`,
// and a navigation tears down the socket that un-acked Realtime Database writes
// are still sitting on. On a bad connection that could lose the archive, or the
// reset, or half of the reset — and nothing said so, because the WhatsApp report
// went out either way and the day looked closed.
//
// Nothing tested any of this, so it is tested here rather than read: what the
// page does with promises and a navigation is a question about a browser.
//
// Firebase is stubbed with writes this suite can hold open, so "did the hand-off
// wait" is something it can watch rather than infer. Everything the page records
// is reported OUT of the page as it happens, because the hand-off really does
// navigate — anything left in a page variable dies with the document.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Cash-up — in a browser');

// The PIN salt is read out of the page rather than copied, so a change to it
// fails here loudly instead of leaving a suite that signs in with nothing.
const POS_SRC = fs.readFileSync(path.join(ROOT, 'pos.html'), 'utf8');
const saltMatch = /const PIN_SALT = "([^"]+)"/.exec(POS_SRC);
if (!saltMatch) throw new Error('PIN_SALT not found in pos.html — the cash-up suite signs in with it');
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

const ARCHIVE = 'pos/eodArchive';
const RESET = 'pos';        // the atomic multi-path reset is written at pos itself
const HOLD_ARCHIVE = ARCHIVE + '/*';   // the key under it carries a timestamp

// A held path stays pending until the suite releases it — a write in flight, which
// is the only state in which "did the page wait for this" means anything. A held
// entry is one exact path, or a subtree when it ends in /* : the archive key carries
// a timestamp, and holding all of `pos` would hold the archive under it too.
const STUB = `
(() => {
  window.__held = [];
  window.__gates = {};
  const heldBy = (p) => window.__held.find(h =>
    h.slice(-2) === '/*' ? p.indexOf(h.slice(0, -2) + '/') === 0 : p === h) || null;
  const out = (kind, data) => { try { window.__ila(kind, data); } catch (e) {} };

  const record = (op, p, v) => {
    let value = null;
    try { value = v === undefined ? null : JSON.parse(JSON.stringify(v)); } catch (e) { value = '[unserialisable]'; }
    out('op', { op: op, path: p, value: value });
    const h = heldBy(p);
    if (!h) return Promise.resolve();
    return new Promise((resolve, reject) => { window.__gates[h] = { resolve: resolve, reject: reject }; });
  };

  const snapOf = (o) => ({ key: null, val: () => (o === undefined ? null : o),
                           exists: () => o != null, forEach: () => {} });
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
  database.ServerValue = { TIMESTAMP: 1756200000000, increment: (n) => ({ '.sv': { increment: n } }) };
  window.firebase = {
    initializeApp: () => ({}), apps: [],
    database: database,
    auth: () => ({
      onAuthStateChanged: () => {},            // left hanging: the suite drives promptEOD itself
      signInWithEmailAndPassword: () => Promise.resolve({}),
      signOut: () => Promise.resolve(),
      currentUser: { uid: 'u1', getIdToken: () => Promise.resolve('stub-id-token') }
    })
  };

  // Real dialogs block the page and Playwright dismisses them, which would turn
  // every confirm() into a "no". These answer deterministically and report the
  // text, which is half of what this suite is checking.
  window.alert = (m) => { out('dialog', { kind: 'alert', text: String(m) }); };
  window.confirm = (m) => { out('dialog', { kind: 'confirm', text: String(m) }); return true; };
  window.prompt = (m) => { out('dialog', { kind: 'prompt', text: String(m) }); return ${JSON.stringify(PIN)}; };

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

// The state a till carries into cash-up: a day's takings, two bills, one expense,
// and no open tables — the walkout branch has its own prompt and its own suite.
const SEED = `
  window.staffPins = { ${JSON.stringify(PIN_HASH)}: 'Priya' };
  window.activeTables = {};
  window.tipPool = { accrued: 0, paidOut: 0 };
  window.upiReviewMap = {};
  window.cashDrawer = 3100;
  window.upiTotal = 8400;
  window.pastBills = [{ id: 1, total: 5200 }, { id: 2, total: 3200 }];
  window.salesLedger = [
    { type: 'upi_income', amount: 8400, reason: 'Table 3 (UPI)', payId: 'pay-1', state: 'unverified', ts: 1 },
    { type: 'cash_income', amount: 3100, reason: 'Table 5 (Cash)', ts: 2 },
    { type: 'expense', amount: 450, reason: 'milk (Priya)', ts: 3 }
  ];
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const pageErrors = [];

  // One till, freshly opened, with `held` paths left in flight.
  async function freshTill(held) {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const seen = { ops: [], dialogs: [], pushes: [], handoffs: [] };
    page.on('pageerror', e => pageErrors.push(String(e.message || e).split('\n')[0]));
    await page.exposeFunction('__ila', (kind, data) => {
      if (kind === 'op') seen.ops.push(data);
      else if (kind === 'dialog') seen.dialogs.push(data);
      else if (kind === 'push') seen.pushes.push(data.body);
    });
    await page.addInitScript(STUB);
    // The hand-off is a real top-level navigation, and letting it run replaces the
    // document — which is exactly why nothing is kept inside the page.
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(base)) return route.continue();
      if (url.indexOf('wa.me') !== -1) seen.handoffs.push(url);
      return route.abort();
    });
    await page.goto(base + '/pos.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    await page.evaluate(([seed, hold]) => {
      window.__held = hold;
      (0, eval)(seed);
    }, [SEED, held || []]);
    return { ctx, page, seen };
  }

  const startEOD = (page) => page.evaluate(() => { window.__eod = window.promptEOD(); });
  const release = (page, prefix, how) => page.evaluate(([p, h]) => {
    const g = window.__gates[p];
    if (!g) throw new Error('nothing is waiting on ' + p);
    if (h === 'reject') g.reject(new Error('permission_denied')); else g.resolve();
  }, [prefix, how || 'resolve']);
  const resets = (seen) => seen.ops.filter(o => o.path === RESET && o.op === 'update');
  const alerts = (seen) => seen.dialogs.filter(d => d.kind === 'alert').map(d => d.text).join('\n');
  const trail = (seen) => seen.ops.filter(o => o.op !== 'push').map(o => o.op + ' ' + o.path).join(', ') || '(nothing written)';
  // The hand-off replaces the document, so waiting on the promise is not an option.
  async function settle(seen, ms) {
    const until = Date.now() + (ms || 4000);
    while (Date.now() < until) {
      if (seen.handoffs.length || seen.dialogs.some(d => d.kind === 'alert')) return;
      await sleep(50);
    }
  }

  try {
    // -------------------------------------------------- 1. waiting for the archive
    {
      const { ctx, page, seen } = await freshTill([HOLD_ARCHIVE]);
      await startEOD(page);
      await sleep(400);

      const archive = seen.ops.find(o => o.path.indexOf(ARCHIVE + '/') === 0);
      check('the day is written to pos/eodArchive', !!archive, trail(seen));
      check('and the archive carries the day’s totals, its bills and its ledger',
            !!archive && archive.value.upi === 8400 && archive.value.cash === 3100 &&
            (archive.value.bills || []).length === 2 && (archive.value.ledger || []).length === 3 &&
            archive.value.closedBy === 'Priya');

      check('nothing is cleared while that write is still in flight', resets(seen).length === 0, trail(seen));
      check('and the WhatsApp hand-off has not fired either', seen.handoffs.length === 0,
            seen.handoffs.join(', '));
      note('the hand-off tears down the socket an un-acked write is sitting on');

      await release(page, HOLD_ARCHIVE);
      await settle(seen);
      check('once the archive lands, the till is cleared', resets(seen).length === 1, trail(seen));
      check('and only then does the report go out', seen.handoffs.length === 1, trail(seen));
      await ctx.close();
    }

    // ------------------------------------------------- 2. one write, not four
    {
      const { ctx, page, seen } = await freshTill([]);
      await startEOD(page);
      await settle(seen);

      const reset = resets(seen)[0];
      const separately = seen.ops.filter(o => o.op !== 'push' &&
        ['pos/ledgerEntries', 'pos/bills', 'pos/activeTables', 'pos/upiTotal'].includes(o.path));
      check('the reset is a single multi-path update, not four separate writes',
            !!reset && separately.length === 0, trail(seen));
      note('four writes can land as three; one update cannot half-happen');
      check('it clears the ledger, the bills and the open tables',
            !!reset && reset.value.ledgerEntries === null && reset.value.bills === null &&
            reset.value.activeTables === null, JSON.stringify(reset && reset.value));
      check('it zeroes the day’s UPI total', !!reset && reset.value.upiTotal === 0);
      check('and it leaves the cash drawer alone — the notes are still in it',
            !!reset && !('cashDrawer' in reset.value), JSON.stringify(reset && reset.value));

      const carried = seen.ops.find(o => o.path === 'pos/unverified');
      check('a payment still unverified at closing is parked before the wipe',
            !!carried && !!carried.value['pay-1'], trail(seen));

      const body = seen.pushes.map(b => { try { return JSON.parse(b).notification.body; } catch (e) { return ''; } }).join(' ');
      check('the owner’s notification counts the day, not the emptied till',
            /2 bills/.test(body) && /450/.test(body), body || '(no push sent)');
      note('both are read off arrays that the reset’s own listeners empty');
      await ctx.close();
    }

    // ------------------------------------------- 3. an archive that never lands
    {
      const { ctx, page, seen } = await freshTill([HOLD_ARCHIVE]);
      await startEOD(page);
      await sleep(400);
      await release(page, HOLD_ARCHIVE, 'reject');
      await settle(seen);

      check('an archive that fails leaves the till untouched', resets(seen).length === 0, trail(seen));
      check('the cashier is told the day is still open', /still open/i.test(alerts(seen)),
            alerts(seen) || '(silent)');
      check('and no report goes out saying otherwise', seen.handoffs.length === 0, seen.handoffs.join(', '));
      note('the old code sent the report either way — the day looked closed regardless');
      await ctx.close();
    }

    // ---------------------------------------------- 4. a reset that never lands
    {
      const { ctx, page, seen } = await freshTill([RESET]);
      await startEOD(page);
      await sleep(600);

      check('the hand-off waits on the reset as well as the archive',
            seen.handoffs.length === 0, seen.handoffs.join(', '));
      await release(page, RESET, 'reject');
      await settle(seen);
      const said = alerts(seen);
      check('a failed reset says the day IS archived', /archived/i.test(said), said || '(silent)');
      check('and says not to start tomorrow on this screen', /reload/i.test(said), said);
      await ctx.close();
    }

    // ------------------------------------------------------ 5. a dead connection
    {
      // A Realtime Database write that cannot reach the server neither resolves nor
      // rejects — the SDK queues it and waits. Unbounded, awaiting one would leave
      // the cash-up on a frozen screen with nothing to read.
      const { ctx, page, seen } = await freshTill([HOLD_ARCHIVE]);
      await startEOD(page);
      await sleep(1500);
      check('a write that never answers does not end the cash-up early',
            seen.dialogs.every(d => d.kind !== 'alert') && seen.handoffs.length === 0, trail(seen));
      note('waiting out the bound — about 20s, once, deliberately');
      await settle(seen, 30000);
      check('but it does not leave the till waiting forever either',
            seen.dialogs.some(d => d.kind === 'alert'), '(no message after 30s)');
      check('the cashier is told the till never heard back',
            /did not hear back/i.test(alerts(seen)), alerts(seen) || '(silent)');
      check('and an unconfirmed archive still clears nothing', resets(seen).length === 0, trail(seen));
      await ctx.close();
    }

    check('the page threw no errors while any of that ran', pageErrors.length === 0,
          pageErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.close();
  }

  done();
})();
