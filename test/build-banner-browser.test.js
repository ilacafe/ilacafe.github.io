// The banner, in a real browser, on every page that carries it.
//
// build-freshness.test.js reads the source and checks the shape of the thing.
// It cannot see any of what actually breaks this mechanism in the field:
// document.currentScript returning null so the page never knows its own build,
// the banner rendering underneath a full-screen overlay where nobody can tap it,
// or the whole watcher throwing before it arms.
//
// So this serves the repo, lies about build.json, and looks.
//
// Run separately from `npm test` (`npm run test:browser`) because it needs a
// browser. Firebase is stubbed: these pages must run with no credentials.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Update banner — in a browser, on every screen');

const PAGES = ['index.html', 'pos.html', 'admin.html', 'chef.html', 'barista.html'];
const MINE = JSON.parse(fs.readFileSync(path.join(ROOT, 'build.json'), 'utf8')).build;

// Every ref() method is a chaining no-op, which is all the load-time wiring needs.
// This is injected before the page's own scripts rather than served in place of the
// CDN ones: those carry SRI hashes, so a substituted file is refused by the browser
// and `firebase` would be undefined however convincing the stub was.
const FIREBASE_STUB = `
(() => {
  const noop = () => {};
  const ref = () => new Proxy(function(){}, {
    get: () => ref(),
    apply: () => ref(),
  });
  const db = { ref, goOnline: noop, goOffline: noop };
  window.firebase = {
    initializeApp: noop,
    apps: [{}],
    database: Object.assign(() => db, { ServerValue: { TIMESTAMP: 0 } }),
    auth: () => ({
      onAuthStateChanged: (cb) => { try { cb(null); } catch (e) {} },
      signInWithEmailAndPassword: () => Promise.resolve({}),
      signInAnonymously: () => Promise.resolve({}),
      signOut: () => Promise.resolve(),
      currentUser: null,
    }),
    messaging: () => ({ getToken: () => Promise.resolve(null), onMessage: noop }),
  };
})();
`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
                '.png': 'image/png', '.css': 'text/css', '.webmanifest': 'application/manifest+json' };

// What build.json claims right now. Each test moves it and pokes the page.
let claimed = MINE;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/build.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(claimed === null ? { oops: true } : { build: claimed }));
  }
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not here');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

// The watcher polls on visibilitychange, so a poke is one event and a short wait —
// no test has to sit through the ten-minute interval.
async function poke(page) {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(350);
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const browser = await chromium.launch(
    fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});

  try {
    for (const name of PAGES) {
      // serviceWorkers: 'block' rather than a route rule — Playwright does not send
      // the worker's own script request through page.route, so blocking it there
      // does nothing and the page still reloads itself when the worker claims it.
      const ctx = await browser.newContext({ serviceWorkers: 'block' });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(String(e.message || e).split('\n')[0]));

      // Nothing leaves the machine: everything not served from here is refused,
      // rather than quietly waited on until the test times out.
      await page.addInitScript(FIREBASE_STUB);
      await page.route('**/*', (route) =>
        route.request().url().startsWith(base) ? route.continue() : route.abort());

      claimed = MINE;
      await page.goto(base + '/' + name, { waitUntil: 'domcontentloaded' });

      check(name + ' knows which build it is',
            await page.evaluate(() => window.ILA_BUILD) === MINE,
            'document.currentScript did not resolve — the watcher can never fire');

      await poke(page);
      check(name + ' stays quiet when the build has not moved',
            await page.evaluate(() => !document.getElementById('ila-update-banner')));

      claimed = '2099-01-01.1';
      await poke(page);
      const banner = await page.evaluate(() => {
        const b = document.getElementById('ila-update-banner');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        // Who actually receives a tap in the middle of the "Reload now" button?
        const btn = document.getElementById('ila-update-now').getBoundingClientRect();
        const hit = document.elementFromPoint(btn.left + btn.width / 2, btn.top + btn.height / 2);
        return {
          text: b.textContent,
          onTop: !!hit && hit.id === 'ila-update-now',
          hitId: hit ? (hit.id || hit.tagName) : 'nothing',
          onScreen: r.width > 0 && r.bottom <= window.innerHeight + 1,
        };
      });
      check(name + ' shows the banner when a newer build appears', !!banner);
      check(name + ' names the new build in it',
            !!banner && banner.text.includes('2099-01-01.1'), banner && banner.text);
      check(name + ' puts Reload now where a finger reaches it',
            !!banner && banner.onTop && banner.onScreen,
            banner ? 'the tap lands on: ' + banner.hitId : 'no banner');

      await page.click('#ila-update-later');
      check(name + ' can be dismissed',
            await page.evaluate(() => !document.getElementById('ila-update-banner')));

      claimed = null;   // build.json without a build field, as from an error page
      await poke(page);
      check(name + ' treats a broken build.json as no news',
            await page.evaluate(() => !document.getElementById('ila-update-banner')));

      check(name + ' loaded without throwing', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  note('the tap test is the one that matters: the sign-in overlay is z-index 99999');
  done();
})().catch((e) => { server.close(); console.error(e); process.exit(1); });
