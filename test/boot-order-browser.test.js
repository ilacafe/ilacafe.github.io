// The SDK moved out of the head. This is what says the pages still start, and that
// moving it bought what it was supposed to buy.
//
// WHY THIS NEEDS THE REAL BUNDLES
//
// Every other browser suite here stubs window.firebase and aborts every off-origin
// request, because what those suites are asking about is the page's own code. That
// is exactly the wrong instrument for this question. The thing that could break by
// moving three script tags is the ORDER the real files execute in relative to the
// page's own script — and a suite that never loads them cannot see it. It would go
// on passing with the tags deleted altogether.
//
// So this one loads them for real: the same bytes, checked against the same
// integrity the pages committed, served into the real pages.
//
// WHAT IT PINS
//
//   the pages still boot        — firebase.apps is non-empty, which happens only if
//                                 the SDK ran AND the page's own script then ran and
//                                 called initializeApp. Both halves, in that order.
//
//   the head no longer blocks   — the SDK is held back deliberately, and while it is
//                                 still in flight the page must ALREADY be parsed and
//                                 painted. With the tags back in the head this fails
//                                 flat: nothing below them exists yet, so there is no
//                                 body to find. That is the whole change, stated as
//                                 something that can fail.
//
// Run separately from `npm test` (`npm run test:browser`) because it needs a browser
// and a download.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { ROOT, readPage, suite } = require('./helpers');

const { check, note, done } = suite('Booting the pages — the real SDK, at the foot of the body');

const PAGES = ['index.html', 'pos.html', 'admin.html', 'analytics.html',
               'chef.html', 'barista.html', 'inventory.html'];

// How long the SDK is held back for. Long enough that "the page was already parsed"
// cannot be a coincidence of timing, short enough not to pad the suite.
const HOLD_MS = 1200;

// ------------------------------------------------ what the pages actually load
const TAG = /<script\b[^>]*?>/gs;
const attr = (name, tag) => (new RegExp(name + '="([^"]*)"', 's').exec(tag) || [])[1];

const wanted = new Map();                       // url -> integrity
for (const page of PAGES) {
  for (const tag of readPage(page).match(TAG) || []) {
    const src = attr('src', tag);
    if (!src || !/firebasejs/.test(src)) continue;
    wanted.set(src, attr('integrity', tag));
  }
}
check('the pages name the SDK bundles with hashes', wanted.size >= 3 &&
      [...wanted.values()].every(Boolean), [...wanted.keys()].join(', '));

const version = (/firebasejs\/([\d.]+)\//.exec([...wanted.keys()][0] || '') || [])[1];

// ------------------------------------------------------- the same bytes, from npm
// Same trick firebase-compat-browser.test.js uses, and for the same reason: the CDN
// is not reachable from every machine this runs on, and the hash check turns "npm
// probably serves the same build" into a fact. It matters more here than there —
// the bytes are handed to a page that will refuse them outright if they are wrong,
// so a mismatch would look like a page that does not boot.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ila-boot-'));
const pack = spawnSync('npm', ['pack', 'firebase@' + version, '--silent'],
                       { cwd: tmp, encoding: 'utf8' });
if (pack.status !== 0) {
  check('firebase ' + version + ' can be fetched from npm', false,
        (pack.stderr || '').split('\n').slice(-3).join(' '));
  done(); process.exit(1);
}
const tgz = fs.readdirSync(tmp).find(f => f.endsWith('.tgz'));
spawnSync('tar', ['xzf', tgz, '-C', tmp], { cwd: tmp });

const bytesFor = new Map();                      // url -> Buffer
const bad = [];
for (const [url, integrity] of wanted) {
  const name = url.slice(url.lastIndexOf('/') + 1);
  const onDisk = path.join(tmp, 'package', name);
  if (!fs.existsSync(onDisk)) { bad.push(name + ' is not in the npm package'); continue; }
  const b = fs.readFileSync(onDisk);
  const got = 'sha384-' + crypto.createHash('sha384').update(b).digest('base64');
  if (got !== integrity) bad.push(name + ' hashes to ' + got + ', pages committed ' + integrity);
  bytesFor.set(url, b);
}
check('every bundle hashes to the integrity the pages committed', bad.length === 0, bad.join('; '));
note('so what the browser is handed below is what it would accept from the CDN');

// ----------------------------------------------------------------------- serving
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
                '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('no');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});

  const threw = [];
  for (const page of PAGES) {
    // serviceWorkers blocked for the reason build-banner-browser.test.js gives: the
    // worker's own request does not go through route, and a page that reloads itself
    // when the worker claims it lands in the middle of these measurements.
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const tab = await ctx.newPage();
    tab.on('pageerror', e => threw.push(page + ': ' + e.message));

    let released = false;
    await tab.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith(base)) return route.continue();
      if (bytesFor.has(url)) {
        await sleep(HOLD_MS);                       // hold the SDK back on purpose
        released = true;
        // crossorigin="anonymous" on the tag means this is a CORS request, and a
        // response the CORS check rejects never reaches the integrity check at all —
        // it would look exactly like a bad hash.
        return route.fulfill({ status: 200, body: bytesFor.get(url),
                               headers: { 'Content-Type': 'text/javascript',
                                          'Access-Control-Allow-Origin': '*' } });
      }
      return route.abort();                          // fonts, chart.js: not this suite's business
    });

    // 'commit' so this returns as soon as the response starts, rather than waiting
    // out the hold — the point is to look at the page WHILE the SDK is in flight.
    await tab.goto(base + '/' + page, { waitUntil: 'commit' });
    await sleep(Math.round(HOLD_MS * 0.6));

    const during = await tab.evaluate(() => ({
      hasBody: !!document.body,
      elements: document.body ? document.body.querySelectorAll('*').length : 0,
      firebase: typeof window.firebase !== 'undefined',
    }));
    check(page + ' is parsed and on screen while the SDK is still in flight',
          during.hasBody && during.elements > 5 && !during.firebase,
          JSON.stringify(during) + (during.firebase ? ' — the SDK ran before the page was built' : ''));

    await tab.waitForLoadState('load');
    const after = await tab.evaluate(() => ({
      released: typeof window.firebase !== 'undefined',
      apps: (window.firebase && window.firebase.apps && window.firebase.apps.length) || 0,
      elements: document.body.querySelectorAll('*').length,
    }));
    check(page + ' then boots: the SDK ran and the page initialised it',
          released && after.released && after.apps > 0, JSON.stringify(after));

    await ctx.close();
  }

  check('no page threw while any of that ran', threw.length === 0, threw.join(' | '));
  note('the first check is the one that fails if the tags go back into the head');

  await browser.close();
  server.close();
  done();
})();
