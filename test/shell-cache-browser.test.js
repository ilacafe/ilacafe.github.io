// The service worker really does hold Chart.js, and really does serve it back.
//
// shell-cache.test.js checks the rules — the host is on the allowlist, the pinned URL
// counts as immutable, the unpinned one does not, and the page's own tag agrees. This
// one checks the consequence, because a rule that is right and a cache that is empty
// look identical from the outside.
//
// jsdelivr is fulfilled locally by the test rather than fetched: what is under test is
// the service worker's decision to store an off-origin file and answer from it, not
// anyone's CDN. The second load happens with that route ABORTED, so anything the page
// gets can only have come out of the cache.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('The shell cache — proved against a real service worker');

const PINNED = 'https://cdn.jsdelivr.net/npm/chart.js@4.5.1';
const LIB = 'window.__chartLibLoaded = true;';

// A page whose only job is to register the real sw.js and pull the pinned URL in.
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title></head><body>
<script src="${PINNED}"></script>
<script>
  window.__ready = navigator.serviceWorker.register('/sw.js')
    .then(r => navigator.serviceWorker.ready).then(() => true).catch(e => String(e));
</script>
</body></html>`;

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json' };
const server = http.createServer((req,res)=>{
  const u = new URL(req.url,'http://x');
  if (u.pathname === '/t.html'){ res.writeHead(200,{'Content-Type':'text/html'}); return res.end(PAGE); }
  const f = path.join(ROOT, u.pathname.slice(1));
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('no');}
  res.writeHead(200,{'Content-Type':TYPES[path.extname(f)]||'application/octet-stream'});
  res.end(fs.readFileSync(f));
});

(async () => {
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const base = 'http://127.0.0.1:'+server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE)?{executablePath:PRE}:{});
  // serviceWorkers must be allowed — this suite is about one.
  const ctx = await browser.newContext({ serviceWorkers: 'allow' });

  let serveLib = true, cdnHits = 0;
  await ctx.route('https://cdn.jsdelivr.net/**', route => {
    cdnHits++;
    if (!serveLib) return route.abort();                    // the CDN is unreachable now
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: LIB });
  });

  // THREE LOADS, AND THE FIRST ONE IS NOT A MISTAKE
  //
  // A worker does not control the page that registered it. On a device's very first
  // visit the subresources are already in flight before the worker exists, so they go
  // straight to the network and nothing is stored — which is why the first version of
  // this suite found an empty cache and read it as a broken rule. The second load is
  // the one the worker sees, fetches and stores. The third is the one that gets it
  // back. That is the real shape of the shell cache for every file in it.
  const tab = await ctx.newPage();
  await tab.goto(base + '/t.html', { waitUntil: 'load' });
  const reg = await tab.evaluate(() => window.__ready);
  check('the real service worker registers and takes control', reg === true, String(reg));
  check('the library ran on the first load', await tab.evaluate(() => window.__chartLibLoaded === true));
  note('nothing is cached yet — a worker does not control the load that registered it');
  await tab.close();

  // ---- second load: this one goes through the worker
  const tab2 = await ctx.newPage();
  await tab2.goto(base + '/t.html', { waitUntil: 'load' });
  check('the library ran on the second load too',
        await tab2.evaluate(() => window.__chartLibLoaded === true));
  await tab2.waitForTimeout(800);
  const cached = await tab2.evaluate(async (url) => {
    for (const n of await caches.keys()){
      const hit = await (await caches.open(n)).match(url);
      if (hit) return n;
    }
    return null;
  }, PINNED);
  check('and the worker stored it in the shell cache', !!cached,
        'not found in ' + JSON.stringify(await tab2.evaluate(() => caches.keys())));
  note('cache: ' + cached);
  await tab2.close();

  // ---- third load, with the CDN taken away entirely
  serveLib = false;
  const before = cdnHits;
  const tab3 = await ctx.newPage();
  await tab3.goto(base + '/t.html', { waitUntil: 'load' });
  const ranOffline = await tab3.evaluate(() => window.__chartLibLoaded === true);
  check('with the CDN unreachable, the library still runs', ranOffline,
        'the page could not get Chart.js from anywhere');
  note('this is the open that used to show blank charts on a flaky connection');
  check('and the worker did not go back to the network for it', cdnHits === before,
        (cdnHits - before) + ' requests reached the CDN on that load');
  note('a pinned url can only ever answer with one file, so asking again is a request spent');

  await browser.close();
  server.close();
  done();
})();
