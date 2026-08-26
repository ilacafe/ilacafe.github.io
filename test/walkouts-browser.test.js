// Bills written off unpaid at cash-up, rendered by a real browser.
//
// security/unpaid has recorded every walkout since that prompt was added — the
// table, what was owed, what had been paid, the items on the bill, and who
// authorised writing it off. Nothing read it. The ledger line shows the money, so
// the amount was never lost; the rest of it — which items walked out — had no
// screen anywhere.
//
// Rendered rather than scanned, for the reason inventory-browser.test.js gives:
// whether a staff name can become markup is a question about the browser, and a
// source scan for escapeHTML( gets it wrong in both directions.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Walkouts — in a browser');

const NOW = Date.now();

// One payload per field, tagged with where it came from: with a single shared
// payload, dropping escapeHTML from a field whose value happened to contain no
// angle bracket changed nothing a test could see.
const payload = (field) => '<img src=x onerror="window.__pwned=\'' + field + '\'">';

const UNPAID = {
  recent: { table: 'Table 4', due: 820, total: 1200, paid: 380, by: 'Priya',
            reason: 'walked out during rush',
            items: { 'Margherita': { qty: 2, price: 400 }, 'Cold Brew': { qty: 1, price: 400 } },
            ts: NOW - 3 * 3600e3 },
  hostile: { table: payload('table'), due: 250, total: 250, paid: 0,
             by: payload('by'), reason: payload('reason'),
             items: { [payload('items')]: { qty: 1, price: 250 } },
             ts: NOW - 5 * 3600e3 },
  // outside a short range, inside All Time
  old: { table: 'Table 9', due: 500, total: 500, paid: 0, by: 'Sam', reason: 'months ago',
         items: null, ts: NOW - 200 * 86400e3 },
  // written before these rows carried a ts at all
  undated: { table: 'Table 1', due: 99, total: 99, paid: 0, by: 'Legacy', reason: 'no ts',
             items: null },
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
                '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/build.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(fs.readFileSync(path.join(ROOT, 'build.json')));
  }
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not here');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

// Chart.js is a CDN script and nothing here leaves the machine, so it is stubbed
// rather than fetched — the chart is not what is under test.
const STUB = `
  window.Chart = class { constructor(){ this.data = { datasets: [] }; this.options = {}; }
                         destroy(){} update(){} resize(){} };
  const DATA = { 'security/unpaid': ${JSON.stringify(UNPAID)}, 'security/voids': {},
    'users/u1': { role: 'admin' }, 'eta/model': {}, 'menu': {}, 'settings': {} };
  const noop = () => {};
  const snapOf = (o) => ({ val: () => (o === undefined ? null : o),
    forEach: (cb) => { Object.keys(o || {}).forEach(k => cb({ key: k, val: () => o[k] })); } });
  const ref = (p) => { const n = {
    limitToLast: () => n, orderByChild: () => n, orderByKey: () => n, startAt: () => n,
    endAt: () => n, equalTo: () => n, child: (c) => ref(p + '/' + c), push: () => ({ key: '-G' }),
    set: () => Promise.resolve(), update: () => Promise.resolve(), remove: () => Promise.resolve(),
    transaction: () => Promise.resolve({}), once: () => Promise.resolve(snapOf(DATA[p])),
    on: (e, cb) => { setTimeout(() => cb(snapOf(DATA[p])), 10); } }; return n; };
  const db = { ref, goOnline: noop, goOffline: noop };
  window.firebase = { initializeApp: noop, apps: [{}],
    database: Object.assign(() => db, { ServerValue: { TIMESTAMP: 0 } }),
    auth: () => ({ onAuthStateChanged: (cb) => { setTimeout(() => { try { cb({ uid: 'u1' }); } catch (e) {} }, 0); },
                   signOut: () => Promise.resolve(), currentUser: { uid: 'u1' } }),
    messaging: () => ({ getToken: () => Promise.resolve(null), onMessage: noop }) };
`;

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(
    fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});

  try {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message || e).split('\n')[0]));
    await page.addInitScript(STUB);
    await page.route('**/*', (route) =>
      route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base + '/analytics.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);

    const look = async (key) => {
      await page.evaluate((k) => {
        const now = Date.now();
        setRange(k === 'all' ? 0 : now - 24 * 3600e3, now + 1, k, k);
        render();
      }, key);
      await page.waitForTimeout(200);
      return page.evaluate(() => ({
        summary: document.getElementById('unpaid-summary').innerText.trim(),
        rows: [...document.querySelectorAll('#unpaid-body tr')]
                .map(tr => tr.innerText.replace(/\s+/g, ' ').trim()),
        byStaff: document.getElementById('unpaid-bystaff').innerText,
        pwned: window.__pwned || false,
        injected: !!document.querySelector('#unpaid-body img, #unpaid-body script, #unpaid-body b'),
      }));
    };

    const day = await look('day');
    check('a short range shows only what falls in it',
          day.rows.length === 2, day.rows.length + ' rows: ' + day.rows.join(' // ').slice(0, 160));
    check('and totals what it is showing, not everything stored',
          /1,070/.test(day.summary), day.summary);
    note('₹820 + ₹250 — the ₹500 from months ago and the undated ₹99 are out of range');

    const all = await look('all');
    check('All Time shows the older ones too', all.rows.length === 4, all.rows.length + ' rows');
    check('including a row written before these carried a timestamp',
          all.rows.some(r => /Legacy/.test(r)),
          'an undated row would otherwise be invisible in every range');
    note('undated rows surface only under All Time, as the void log beside it does');

    check('a partly-paid bill says what was owed of what',
          all.rows.some(r => /820/.test(r) && /1,200/.test(r)),
          'otherwise ₹820 reads as the whole bill');
    check('and the items on it are named',
          all.rows.some(r => /Margherita/.test(r)),
          'which items walked out is the part the ledger line cannot tell you');

    check('no field can become markup',
          !all.pwned && !all.injected,
          all.pwned ? ('the payload in `' + all.pwned + '` executed')
                    : 'markup was injected into the page');
    note('by, table, reason and items each fail this individually when unescaped');

    // The displayed time is the one field a payload cannot reach, because it is
    // computed from the numeric ts rather than read off the record. The void log
    // beside this one does trust a stored `time` string; this deliberately does
    // not, so say so — otherwise it looks like a field that simply went untested.
    const src = fs.readFileSync(path.join(ROOT, 'analytics.html'), 'utf8');
    const compute = src.slice(src.indexOf('function computeUnpaid'),
                              src.indexOf('function unpaidItems'));
    check('the displayed time is derived, not taken from the record',
          /time:\s*dated \? new Date\(u\.ts\)/.test(compute) && !/u\.time/.test(compute),
          'a stored time string would be one more place a payload could arrive');
    check('the page did not throw', errors.length === 0, errors.join(' | '));

    await ctx.close();
  } finally {
    await browser.close();
    server.close();
  }

  done();
})().catch((e) => { server.close(); console.error(e); process.exit(1); });
