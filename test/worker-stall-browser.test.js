// The request that never comes back.
//
// Two screens hand work to the Cloudflare Worker rather than writing it themselves:
// the till, for cash leaving the drawer, and the stock tablet, for a delivery or a
// prep. Both are the same shape — disable the button, await a fetch, re-enable it —
// and both were written as though a fetch either succeeds or rejects.
//
// It does neither when the connection is MADE and then goes nowhere, which is the
// shape of nearly every café outage: the tablet is on the wifi, the router answers,
// the uplink is dead. That is the exact case connection.js exists for, and the exact
// case `navigator.onLine` gets wrong. A browser applies no timeout of its own to a
// request like that, so `await fetch(...)` simply never settles.
//
// The consequence is not a slow screen. The button was disabled before the call and
// is re-enabled after it — in the till by the line below the await, on the stock
// tablet by a `finally` — so neither ever runs. The control stays dead, the screen
// says "Recording…" for as long as anyone leaves it there, and the only way out is a
// reload, on a device somebody is in the middle of taking money on.
//
// So this drives both real pages with a fetch that connects and then says nothing,
// and asks the only question that matters: does the screen come back, and does it say
// something a person can act on. It is a browser test because the failure is a UI
// state, and the fix is a timeout that a source scan can see without ever finding out
// whether the button is usable again afterwards.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('The Worker call that never answers');

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

// The timeout the pages set. Read out of them rather than copied, so raising it in a
// page raises it here and a page that quietly drops it fails rather than passing on a
// number this file remembers.
const timeoutIn = (page) => {
  const m = /WORKER_TIMEOUT_MS\s*=\s*(\d+)/.exec(fs.readFileSync(path.join(ROOT, page), 'utf8'));
  return m ? parseInt(m[1], 10) : null;
};

// A database that answers, and a Worker that does not. The fetch resolves its
// connection and then hangs — no response, no error, exactly as a dead uplink behaves
// once the socket is up.
const STUB = `
(() => {
  const snapOf = (v) => ({ key: null, val: () => (v === undefined ? null : v),
    exists: () => v != null, numChildren: () => 0, hasChild: () => false,
    child: () => snapOf(null), forEach: () => {} });
  // Enough for the stock tablet to draw a real row, so the modal is opened by
  // clicking one rather than by setting the state a click would have set.
  const DATA = {
    'inventory/config/items': { bar: { raw: ['Oat Milk'], prepped: [] } },
    'inventory/stock': { 'Oat Milk': 4 }
  };
  const mkRef = (p) => { const self = {
    key: p.split('/').filter(Boolean).pop() || null,
    child: (c) => mkRef(p + '/' + c),
    orderByChild: () => self, orderByKey: () => self, limitToLast: () => self,
    limitToFirst: () => self, startAt: () => self, endAt: () => self, equalTo: () => self,
    // 'value' only. A child_added handler expects one child, and handing it an
    // empty snapshot is a stub bug that reads like a page bug.
    on: (e, cb) => { if (cb && (!e || e === 'value')) setTimeout(() => cb(snapOf(DATA[p])), 0); return cb; },
    off: () => {},
    once: (_e, cb) => { const s = snapOf(DATA[p]); if (cb) cb(s); return Promise.resolve(s); },
    push: () => mkRef(p + '/-Nstub'), set: () => Promise.resolve(),
    update: () => Promise.resolve(), remove: () => Promise.resolve(),
    transaction: (_f, cb) => { const s = snapOf(null); if (cb) cb(null, false, s); return Promise.resolve({ committed: false, snapshot: s }); }
  }; return self; };
  const db = { ref: (p) => mkRef(String(p == null ? '' : p).replace(/^\\/+|\\/+$/g, '')),
               goOnline: () => {}, goOffline: () => {} };
  const database = () => db;
  database.ServerValue = { TIMESTAMP: Date.now(), increment: (n) => ({ '.sv': { increment: n } }) };
  window.firebase = {
    initializeApp: () => ({}), apps: [], database: database,
    auth: () => ({ onAuthStateChanged: () => {}, signOut: () => Promise.resolve(),
                   currentUser: { uid: 'u1', getIdToken: () => Promise.resolve('stub-id-token') } })
  };

  // The uplink is dead: the request goes out and nothing ever comes back. An abort
  // must still reject it, because that is the only thing left that can.
  window.__stalled = 0;
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('workers.dev') !== -1) {
      window.__stalled++;
      return new Promise((_resolve, reject) => {
        const sig = init && init.signal;
        if (!sig) return;                       // no abort signal: this never settles
        if (sig.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        sig.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return realFetch(input, init);
  };

  // Said out loud rather than into an overlay, so the check can read it.
  window.__told = [];
  window.__stubDialogs = () => {
    window.ilaToast = (m) => { window.__told.push(String(m)); };
    window.ilaTell = (t, d) => { window.__told.push(String(t) + ' ' + (d || '')); return Promise.resolve(); };
    window.ilaAsk = () => Promise.resolve(true);
    window.ilaFieldError = (_id, m) => { window.__told.push(String(m)); };
  };
})();
`;

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const pageErrors = [];

  async function open(pageName) {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    page.on('pageerror', e => pageErrors.push(pageName + ': ' + String(e.message || e).split('\n')[0]));
    await page.addInitScript(STUB);
    await page.route('**/*', route =>
      route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base + '/' + pageName, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__stubDialogs());
    return { ctx, page };
  }

  try {
    // ------------------------------------------------------------------ the till
    {
      const budget = timeoutIn('pos.html');
      check('the till bounds how long it will wait for the Worker', !!budget && budget <= 30000,
            'WORKER_TIMEOUT_MS = ' + budget);

      const { ctx, page } = await open('pos.html');
      await page.evaluate(() => {
        window.cashDrawer = 5000;
        document.getElementById('transaction-amount').value = '400';
        document.getElementById('transaction-reason').value = 'Milk run';
        document.getElementById('transaction-pin').value = '4821';
        window.currentTransactionType = 'expense';
        window.__done = false;
        window.confirmTransaction().then(() => { window.__done = true; });
      });
      await page.waitForTimeout(300);

      const during = await page.evaluate(() => ({
        stalled: window.__stalled,
        disabled: document.getElementById('transaction-confirm-btn').disabled,
        label: document.getElementById('transaction-confirm-btn').textContent
      }));
      check('a cash-out reaches the Worker and holds the button while it waits',
            during.stalled === 1 && during.disabled === true, JSON.stringify(during));

      // Past the budget, and not much past it.
      await page.waitForTimeout(budget + 1500);
      const after = await page.evaluate(() => ({
        done: window.__done,
        disabled: document.getElementById('transaction-confirm-btn').disabled,
        label: document.getElementById('transaction-confirm-btn').textContent,
        told: window.__told.join(' | ')
      }));
      check('and it gives up rather than waiting for ever', after.done === true,
            'confirmTransaction never resolved');
      check('the Confirm button is usable again', after.disabled === false && /confirm/i.test(after.label),
            JSON.stringify({ disabled: after.disabled, label: after.label }));
      check('and the cashier is told, in words, that it did not answer',
            /did not answer/i.test(after.told), after.told || '(said nothing)');
      check('and told to CHECK rather than to try again',
            /check/i.test(after.told) && !/try again/i.test(after.told), after.told);
      note('a withdrawal the Worker may already have recorded must not be entered twice');
      await ctx.close();
    }

    // ---------------------------------------------------------- the stock tablet
    {
      const budget = timeoutIn('inventory.html');
      check('the stock tablet bounds it too', !!budget && budget <= 30000,
            'WORKER_TIMEOUT_MS = ' + budget);

      const { ctx, page } = await open('inventory.html');
      // The rows this page builds its buttons from are drawn only after a sign-in
      // resolves, and a sign-in is not what this suite is about — so the two fields
      // are filled directly and the REAL Confirm button is pressed. Everything from
      // that click onwards is the page's own code: confirmAction, invLogToWorker, the
      // request, and the button state that is the whole finding.
      await page.evaluate(() => {
        document.getElementById('modal-qty').value = '12';
        document.getElementById('modal-pin').value = '4821';
      });
      await page.evaluate(() => { document.getElementById('modal-confirm-btn').click(); });
      await page.waitForTimeout(300);

      const during = await page.evaluate(() => ({
        stalled: window.__stalled,
        disabled: document.getElementById('modal-confirm-btn').disabled,
        label: document.getElementById('modal-confirm-btn').textContent
      }));
      check('a stock entry reaches the Worker and holds the button while it waits',
            during.stalled === 1 && during.disabled === true, JSON.stringify(during));

      await page.waitForTimeout(budget + 1500);
      const after = await page.evaluate(() => ({
        disabled: document.getElementById('modal-confirm-btn').disabled,
        label: document.getElementById('modal-confirm-btn').textContent,
        told: window.__told.join(' | ')
      }));
      check('the Confirm button comes back', after.disabled === false && /confirm/i.test(after.label),
            JSON.stringify({ disabled: after.disabled, label: after.label }));
      note('it is re-enabled in a finally, and a promise that never settles never reaches one');
      check('and it says the service did not answer',
            /did not answer/i.test(after.told), after.told || '(said nothing)');
      check('and points at the log rather than at doing it again',
            /log/i.test(after.told), after.told);
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
