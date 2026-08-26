// What the monthly refit did, rendered by a real browser.
//
// The refit has four ways to end and records all four to eta/recalMeta. The
// Worker records failing cron jobs to ops/cronFailure. Until now the only way to
// read either was to open the Firebase console — so a model that had quietly
// stopped being retrained looked exactly like one that was fine, and the push
// that reports each run is gone the moment it is swiped away.
//
// Rendered rather than scanned, for the reason inventory-browser.test.js gives.
// The cron error string is worth the same care as a staff name: it is whatever a
// failure threw, and it goes on a page.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('The wait-time model — in a browser');

const D = 86400e3;
const NOW = Date.now();

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

function stub(recal, cron) {
  return `
    window.Chart = class { constructor(){ this.data = { datasets: [] }; this.options = {}; }
                           destroy(){} update(){} resize(){} };
    const DATA = { 'eta/recalMeta': ${JSON.stringify(recal)}, 'ops/cronFailure': ${JSON.stringify(cron)},
      'security/voids': {}, 'security/unpaid': {}, 'users/u1': { role: 'admin' },
      'eta/model': {}, 'menu': {}, 'settings': {} };
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
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(
    fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});

  const look = async (recal, cron) => {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message || e).split('\n')[0]));
    await page.addInitScript(stub(recal, cron));
    await page.route('**/*', (route) =>
      route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base + '/analytics.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    // The card lives on the Demand Map view, which is hidden until you switch to
    // it. Reading it while hidden would pass on text nobody can actually see.
    await page.click('#view-demand').catch(() => {});
    await page.waitForTimeout(300);
    const out = await page.evaluate(() => ({
      recal: document.getElementById('recal-summary').innerText.replace(/\s+/g, ' ').trim(),
      cron: document.getElementById('cron-health').innerText.replace(/\s+/g, ' ').trim(),
      injected: !!document.querySelector('#worker-card script, #worker-card img, #worker-card b'),
      visible: !!(document.getElementById('worker-card') || {}).offsetParent,
    }));
    await ctx.close();
    return { ...out, errors };
  };

  try {
    const never = await look(null, null);
    check('with no refit recorded it says so, and says when the first one runs',
          /No refit has been recorded/.test(never.recal) && /1st/.test(never.recal),
          never.recal);

    const ok = await look({ lastRunAt: NOW - 3 * D, lastResult: 'updated', version: 2, orders: 4120 }, null);
    check('an accepted refit names the version it produced',
          /Refitted/.test(ok.recal) && /version 2/.test(ok.recal) && /4120/.test(ok.recal),
          ok.recal);

    const rej = await look({ lastRunAt: NOW - 2 * D, lastResult: 'rejected',
                             reasons: ['pizzaBase swing 61%', 'margin.chef out of bounds'] }, null);
    check('a rejected refit says the old model is still in use',
          /rejected/i.test(rej.recal) && /still in use/.test(rej.recal), rej.recal);
    check('and gives every reason it was rejected for',
          /pizzaBase swing 61%/.test(rej.recal) && /margin\.chef out of bounds/.test(rej.recal),
          rej.recal);
    note('a rejection is the guardrail working, so it has to read as that, not as a fault');

    const skip = await look({ lastRunAt: NOW - 40 * D, lastResult: 'updated', version: 2,
                              lastSkippedAt: NOW - D, lastSkippedFresh: 830 }, null);
    check('a skipped refit says how many orders it has and how many it needs',
          /Skipped/.test(skip.recal) && /830/.test(skip.recal) && /1,500/.test(skip.recal),
          skip.recal);
    note('"nothing happened again" becomes a number instead of a mystery');

    const bad = await look({ lastRunAt: NOW - 3 * D, lastResult: 'updated', version: 2 },
                           { monitor: { consecutive: 7, failingSince: NOW - 7 * 3600e3,
                                        lastError: 'robot token: 401 <script>window.__pwned=1</script>' } });
    check('a failing cron job is named, with how long it has been failing',
          /monitor/.test(bad.cron) && /7 time/.test(bad.cron) && /7 hours ago/.test(bad.cron),
          bad.cron);
    check('and the error it threw cannot become markup',
          !bad.injected && /<script>/.test(bad.cron),
          bad.injected ? 'markup was injected' : 'the error text was swallowed: ' + bad.cron);
    note('that string is whatever a failure threw, and it goes on a page');

    check('the card is actually on screen, not just in the DOM',
          never.visible && ok.visible,
          'it sits on the Demand Map view — a hidden card would pass a text check and help nobody');

    const allErrors = [never, ok, rej, skip, bad].flatMap(r => r.errors);
    check('none of these threw', allErrors.length === 0, allErrors.join(' | '));
  } finally {
    await browser.close();
    server.close();
  }

  done();
})().catch((e) => { server.close(); console.error(e); process.exit(1); });
