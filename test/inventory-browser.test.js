// The inventory log, rendered by a real browser.
//
// Staff names and item names come from the database, and the row is assembled by
// concatenating strings — so the question is whether a name can stop being a name
// and start being markup. That is a question about what the browser does, and a
// source scan is a poor proxy for it: scanning for escapeHTML( flagged
// `v.deductions ? ...` as a hole and missed `(v.staff || 'unknown')` as one.
//
// This also pins the ordering. Two kinds of key live in that node — millisecond
// timestamps from before the fix, push IDs after it — and the page must list
// newest-first regardless of the order Firebase hands them back in.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Inventory log — in a browser');

const NOW = Date.now();

// Every field the renderer touches carries its own payload, tagged with the field
// it came from. One shared payload is not enough: with the marker only in `action`
// and `item`, dropping escapeHTML from `staff` changed nothing a test could see,
// because the name it was carrying happened to contain no angle bracket.
const payload = (field) => '<img src=x onerror="window.__pwned=\'' + field + '\'">';

// Awkward but entirely legitimate — it has to survive as text, not vanish or arrive
// as &amp;. A café hires people called O'Brien.
const REAL_NAME = "O'Brien & Sons";

const LOGS = {
  '-Na1': { action: 'Delivery Received', item: 'Oat Milk', amount: 12, staff: REAL_NAME,
            at: NOW - 90 * 60000, time: 'x' },
  '-Na2': { action: 'Prepped Batch', item: 'Pizza Dough', yieldAmount: 20, staff: 'Arun',
            deductions: '4 of Flour | 2 of Yeast', at: NOW - 20 * 60000, time: 'x' },
  '-Na3': { action: payload('action'), item: payload('item'), amount: payload('amount'),
            staff: payload('staff'), deductions: payload('deductions'),
            at: NOW - 60000, time: 'x' },
  // written before `at` existed: the key was the timestamp
  '1756000000000': { action: 'Delivery Received', item: 'Coffee', amount: 5, staff: 'Sam',
                     time: '25/08/2026, 10:04' },
};

// Firebase collates integer-like keys ahead of string ones. The page must not
// depend on that, so it is fed both this order and its reverse.
function firebaseOrder(keys) {
  const isInt = (k) => /^-?\d+$/.test(k) && String(parseInt(k, 10)) === k;
  return keys.filter(isInt).sort((a, b) => a - b).concat(keys.filter(k => !isInt(k)).sort());
}

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

function stub(keys) {
  return `
    window.__logs = ${JSON.stringify(LOGS)};
    window.__keys = ${JSON.stringify(keys)};
    const DATA = {
      'inventory/logs': window.__logs,
      'users/u1': { role: 'inventory' },
      'inventory/stock': {}, 'inventory/recipes': {}, 'staff': {},
      'inventory/config/items': { bar: { prepped: ['Cold Brew'], raw: ['Oat Milk'] } },
    };
    const noop = () => {};
    const snapOf = (obj, p) => ({
      val: () => (obj === undefined ? null : obj),
      forEach: (cb) => {
        const ks = (p === 'inventory/logs') ? window.__keys : Object.keys(obj || {});
        ks.forEach(k => cb({ key: k, val: () => obj[k] }));
      },
    });
    const ref = (p) => { const node = {
      limitToLast: () => node, orderByChild: () => node, orderByKey: () => node,
      startAt: () => node, endAt: () => node, equalTo: () => node,
      child: (c) => ref(p + '/' + c), push: () => ({ key: '-GENERATED' }),
      set: () => Promise.resolve(), update: () => Promise.resolve(),
      remove: () => Promise.resolve(), transaction: () => Promise.resolve({}),
      once: () => Promise.resolve(snapOf(DATA[p], p)),
      on: (ev, cb) => { setTimeout(() => cb(snapOf(DATA[p], p)), 10); },
    }; return node; };
    const db = { ref, goOnline: noop, goOffline: noop };
    window.firebase = { initializeApp: noop, apps: [{}],
      database: Object.assign(() => db, { ServerValue: { TIMESTAMP: 0, increment: (n) => ({ __inc: n }) } }),
      auth: () => ({ onAuthStateChanged: (cb) => { setTimeout(() => { try { cb({ uid: 'u1' }); } catch (e) {} }, 0); },
                     signOut: () => Promise.resolve(), currentUser: { uid: 'u1' } }),
      messaging: () => ({ getToken: () => Promise.resolve(null), onMessage: noop }) };
  `;
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(
    fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});

  try {
    const ordered = firebaseOrder(Object.keys(LOGS));
    for (const [label, keys] of [['as Firebase orders them', ordered],
                                 ['and in the opposite order', [...ordered].reverse()]]) {
      const ctx = await browser.newContext({ serviceWorkers: 'block' });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(String(e.message || e).split('\n')[0]));
      await page.addInitScript(stub(keys));
      await page.route('**/*', (route) =>
        route.request().url().startsWith(base) ? route.continue() : route.abort());
      await page.goto(base + '/inventory.html', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#log-list .log-row', { timeout: 5000 }).catch(() => {});

      const out = await page.evaluate(() => ({
        rows: document.querySelectorAll('#log-list .log-row').length,
        whens: [...document.querySelectorAll('#log-list .log-when')].map(n => n.textContent.trim()),
        text: document.getElementById('log-list').innerText,
        pwned: window.__pwned || false,
        injected: !!document.querySelector('#log-list img, #log-list script, #log-list b'),
      }));

      check('every entry is listed ' + label, out.rows === 4, out.rows + ' rows');
      check('newest first, ' + label,
            out.whens[0] === 'just now' && /^20m/.test(out.whens[1] || '') && /^2h/.test(out.whens[2] || ''),
            out.whens.join(' | '));
      check('a row written before `at` existed is still dated ' + label,
            !!out.whens[3] && out.whens[3] !== '' && out.whens[3] !== 'just now',
            out.whens[3]);
      check('no field in a log row can become markup ' + label,
            !out.pwned && !out.injected,
            out.pwned ? ('the payload in `' + out.pwned + '` executed')
                      : 'markup was injected into the page');
      check('and a real name with an apostrophe survives as text ' + label,
            out.text.includes(REAL_NAME),
            'mangled: ' + JSON.stringify(out.text.slice(0, 140)));
      check('the page did not throw ' + label, errors.length === 0, errors.join(' | '));

      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  note('ordering is checked under both key orders because two kinds of key live in');
  note('that node, and the page must not depend on how Firebase collates them');
  done();
})().catch((e) => { server.close(); console.error(e); process.exit(1); });
