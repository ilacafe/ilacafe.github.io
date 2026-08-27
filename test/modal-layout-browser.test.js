// A closed modal is not laid out, and an open one still fades in.
//
// These overlays are hidden with opacity rather than display so that they can
// fade. What that costs, and what is easy not to notice, is that every closed one
// remains a rendered box with a rendered subtree: on the till there are fourteen
// of them, all laid out on the first paint and again on every reflow after it.
//
// Measured at 4x CPU throttle, nine runs, median:
//
//                    first paint     DOMContentLoaded
//   pos.html          320 -> 208ms     592 -> 428ms
//   index.html        176 -> 140ms     328 -> 302ms
//
// content-visibility:hidden skips layout and paint for the CONTENTS while leaving
// the overlay's own box alone, so the transition still runs and nothing moves.
//
// WHY THIS IS CHECKED BY COMPUTED STYLE AND NOT BY GEOMETRY
//
// The obvious assertion — measure a closed modal's children and expect zero — does
// not work, and looks like it does. Asking for the geometry of a node inside a
// content-visibility:hidden subtree makes the browser lay that subtree out to
// answer, so the measurement creates the very thing it is looking for and comes
// back non-zero on a page where the property is working perfectly. The first
// version of this check reported a problem on all eighteen overlays for that
// reason. Computed style is asked instead, which changes nothing by asking.
//
// The fade is checked too. display:none would also take these out of layout, and
// would be the obvious "simplification" of this rule — it would also delete the
// animation, because an element cannot transition from not being rendered.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Modals — closed ones cost no layout, open ones still fade');

// Off-origin is aborted below so the real SDK cannot load, which leaves the page's
// own script calling into a `firebase` that is not there. Nothing here is about
// Firebase — but a page that throws on its first line has not laid anything out
// the way it would in service, so it is stubbed rather than left broken.
const FIREBASE_STUB = `
(() => {
  const noop = () => {};
  const chain = () => new Proxy(function(){}, { get: () => chain(), apply: () => chain() });
  const snap = (v) => ({ val: () => v, exists: () => v != null, forEach: () => {}, numChildren: () => 0 });
  const db = { ref: () => ({ on: noop, off: noop, once: () => Promise.resolve(snap(null)),
                             push: () => ({ key: 'k' }), set: () => Promise.resolve(),
                             limitToLast: () => chain(), orderByChild: () => chain() }),
               goOnline: noop, goOffline: noop };
  window.firebase = {
    initializeApp: noop, apps: [{}],
    database: Object.assign(() => db, { ServerValue: { TIMESTAMP: 0 } }),
    auth: () => ({ onAuthStateChanged: (cb) => { setTimeout(() => { try { cb(null); } catch (e) {} }, 0); },
                   signInWithEmailAndPassword: () => Promise.resolve({}),
                   signInAnonymously: () => Promise.resolve({}),
                   signOut: () => Promise.resolve(), currentUser: null }),
    messaging: () => ({ getToken: () => Promise.resolve(null), onMessage: noop }),
  };
})();
`;

const PAGES = ['pos.html', 'index.html', 'inventory.html'];

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

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const threw = [];
  let overlaysSeen = 0;

  for (const page of PAGES) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 900, height: 800 } });
    await ctx.addInitScript(FIREBASE_STUB);
    const tab = await ctx.newPage();
    tab.on('pageerror', e => threw.push(page + ': ' + e.message));
    // Same-origin only, so the real SDK cannot load and take the page somewhere else.
    await tab.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await tab.goto(base + '/' + page, { waitUntil: 'domcontentloaded' });

    const r = await tab.evaluate(async () => {
      const ovs = [...document.querySelectorAll('.modal-overlay')];
      const cv = (el) => getComputedStyle(el).contentVisibility;

      const closed = ovs.map(cv);

      // Open every one in turn: contents must become real, then go away again.
      const opened = [], reclosed = [], areas = [], faded = [];
      for (const ov of ovs) {
        const cs = getComputedStyle(ov);
        faded.push(cs.display !== 'none' && /opacity/.test(cs.transitionProperty || ''));
        ov.classList.add('active');
        opened.push(cv(ov));
        await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
        const kids = [...ov.querySelectorAll('*')];
        areas.push(kids.reduce((a, e) => { const b = e.getBoundingClientRect(); return a + b.width * b.height; }, 0));
        ov.classList.remove('active');
        reclosed.push(cv(ov));
      }
      return { n: ovs.length, closed, opened, reclosed, areas, faded,
               withKids: ovs.map(o => o.querySelectorAll('*').length) };
    });

    overlaysSeen += r.n;
    check(page + ' has overlays to check at all', r.n > 0, String(r.n));
    check(page + ' skips every closed modal’s contents',
          r.closed.every(v => v === 'hidden'),
          r.closed.filter(v => v !== 'hidden').length + ' of ' + r.n + ' were not hidden');
    check(page + ' renders them again when opened',
          r.opened.every(v => v === 'visible'), r.opened.join(','));
    check(page + ' and stops again when closed',
          r.reclosed.every(v => v === 'hidden'), r.reclosed.join(','));

    // An open modal whose contents lay out to nothing is a blank screen over a till.
    const empty = r.areas.map((a, i) => (r.withKids[i] > 0 && a === 0) ? i : -1).filter(i => i >= 0);
    check(page + ' opens to something with actual size on screen', empty.length === 0,
          empty.length + ' opened with zero laid-out area');

    // The reason this is content-visibility and not display:none.
    check(page + ' still fades rather than popping',
          r.faded.every(Boolean), r.faded.filter(x => !x).length + ' no longer transition opacity');

    await ctx.close();
  }

  check('no page threw while any of that ran', threw.length === 0, threw.join(' | '));
  note(overlaysSeen + ' overlays checked; computed style, because measuring geometry lays them out');

  await browser.close();
  server.close();
  done();
})();
