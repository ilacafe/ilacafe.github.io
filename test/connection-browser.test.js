// Does a screen say so when it stops talking to the database?
//
// Every device in this café is on café wifi — two tills, two kitchen boards, the
// stock tablet, and a customer's phone at a table — and not one page had a line
// about losing that connection. No navigator.onLine, no listener, nothing, on any
// of the seven.
//
// The failure is silent by construction, which is what makes it worth a suite. The
// Firebase SDK keeps the last data it received on screen and holds new writes in
// memory, so a disconnected till looks completely normal: the bill reads, the
// buttons press, the totals add up. A kitchen board shows the tickets it already
// had and none of the ones sent since. Both are indistinguishable from a quiet ten
// minutes, and the first anyone knows is a customer asking where their food is.
//
// So the check drives the real signal — `.info/connected` going false — through the
// real page, and asks the only question that matters: does something appear that a
// person would see? Not "is the listener registered". A listener that fires and
// paints nothing is the bug this exists to catch.
//
// navigator.onLine is deliberately NOT the signal under test. It only knows whether
// the device has a network interface, which stays true for a phone attached to a
// wifi router whose uplink is down — the exact shape of most café outages.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, readPage, suite } = require('./helpers');

const { check, note, done } = suite('Every screen — says when it has gone quiet');

const PAGES = ['index.html', 'pos.html', 'admin.html', 'analytics.html',
               'barista.html', 'chef.html', 'inventory.html'];

// ------------------------------------------------------- every page carries it
{
  const missing = PAGES.filter(p => !/<script src="\/connection\.js"><\/script>/.test(readPage(p)));
  check('every page loads the connection watcher', missing.length === 0, missing.join(', '));
  note('a till, a kitchen board and a customer’s phone all lose wifi the same way');
}

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

// A stub whose `.info/connected` is under this suite's control, and which answers
// every other path the way the real one would while connected.
const STUB = (initial = true) => `
(() => {
  const snap = (o) => ({ val: () => (o === undefined ? null : o), exists: () => o != null,
                         numChildren: () => 0, forEach: () => {}, key: null });
  window.__conn = { cbs: [], value: ${initial} };
  window.__setConnected = (v) => { window.__conn.value = v;
    window.__conn.cbs.forEach(cb => { try { cb(snap(v)); } catch (e) {} }); };
  const mk = (p) => { const s = {
    key: 'k', child: () => mk(p), orderByChild: () => s, orderByKey: () => s,
    limitToLast: () => s, limitToFirst: () => s, startAt: () => s, endAt: () => s, equalTo: () => s,
    on: (_e, cb) => {
      if (String(p) === '.info/connected') { window.__conn.cbs.push(cb);
        try { cb(snap(window.__conn.value)); } catch (e) {} return cb; }
      try { if (cb) cb(snap(null)); } catch (e) {} return cb;
    },
    off: () => {},
    once: (_e, cb) => { const x = snap(null); if (cb) cb(x); return Promise.resolve(x); },
    push: () => mk(p), set: () => Promise.resolve(), update: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    transaction: (_f, cb) => { const x = snap(null); if (cb) cb(null, false, x); return Promise.resolve({ committed: false, snapshot: x }); }
  }; return s; };
  const database = () => ({ ref: (p) => mk(p || ''), goOnline: () => {}, goOffline: () => {} });
  database.ServerValue = { TIMESTAMP: 1756200000000, increment: (n) => ({ '.sv': { increment: n } }) };
  window.firebase = {
    initializeApp: () => ({}), apps: [{}], database: database,
    auth: () => ({ currentUser: { uid: 'u1' },
                   onAuthStateChanged: (cb) => { setTimeout(() => { try { cb({ uid: 'u1' }); } catch (e) {} }, 0); return () => {}; },
                   signOut: () => Promise.resolve(),
                   signInWithEmailAndPassword: () => Promise.resolve({ user: { uid: 'u1' } }),
                   signInAnonymously: () => Promise.resolve({ user: { uid: 'a' } }) })
  };
  window.Chart = function () { return { destroy(){}, update(){}, data:{datasets:[]}, options:{} }; };
})();
`;

const BAR = '#ila-offline-bar';

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE) ? { executablePath: PRE } : {});
  const threw = [];

  for (const page of PAGES) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true });
    await ctx.addInitScript(STUB(true));
    const pg = await ctx.newPage();
    pg.on('pageerror', e => threw.push(page + ': ' + String(e.message || e).split('\n')[0]));
    await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await pg.goto(base + '/' + page, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(900);
    await pg.evaluate(() => { const o = document.getElementById('login-overlay'); if (o) o.style.display = 'none'; });

    // Connected: nothing on screen. A bar that is always there is wallpaper.
    const quietWhileConnected = await pg.evaluate((sel) => !document.querySelector(sel), BAR);
    check(page + ' says nothing while it is connected', quietWhileConnected,
          'the bar is on screen when there is nothing wrong with the connection');

    // Now lose it.
    await pg.evaluate(() => window.__setConnected(false));

    // Not straight away: .info/connected is false for the first moment of every
    // load and flickers false on any blip, and a bar that flashes on every open is
    // one everybody learns to ignore.
    await pg.waitForTimeout(600);
    const notYet = await pg.evaluate((sel) => !document.querySelector(sel), BAR);
    check(page + ' does not flash it at the first blip', notYet, 'it appeared within 600ms');

    // But it does arrive, and it is genuinely visible — painted, on screen, with
    // words in it. Existing in the DOM is not the same as being seen.
    let seen = null;
    try {
      await pg.waitForSelector(BAR, { state: 'visible', timeout: 4000 });
      seen = await pg.evaluate((sel) => {
        const el = document.querySelector(sel); if (!el) return null;
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top),
                 text: (el.textContent || '').trim(), opacity: cs.opacity,
                 onScreen: r.top >= 0 && r.top < window.innerHeight && r.width > 0 && r.height > 0,
                 role: el.getAttribute('role') };
      }, BAR);
    } catch (e) { /* seen stays null */ }

    check(page + ' shows the bar once the connection is really gone', !!seen && seen.onScreen,
          seen ? JSON.stringify(seen) : 'it never appeared at all');
    if (seen) {
      check('and it says something, rather than being an empty strip', seen.text.length > 10, seen.text);
      check('and announces itself to VoiceOver and TalkBack', seen.role === 'status', 'role=' + seen.role);
    }

    // And it goes away again. A warning that outlives the fault is the same bug.
    await pg.evaluate(() => window.__setConnected(true));
    await pg.waitForTimeout(300);
    const cleared = await pg.evaluate((sel) => !document.querySelector(sel), BAR);
    check(page + ' takes it down again when the connection returns', cleared,
          'it is still on screen after reconnecting');

    await ctx.close();
  }

  // ------------------------------------------------------- and a restart is not one
  // Every check above starts CONNECTED and then loses it, which is a fault. A page
  // that has just opened has not lost anything — the socket is simply still being
  // opened, and `.info/connected` reports that as false too. Timing both the same way
  // meant a till reopened on good wifi announced an outage that had already fixed
  // itself: "When POS restarts it shows offline", which is where this block came from.
  //
  // The distinction is not cosmetic. A warning that appears on every ordinary open is
  // one everybody learns to scroll past, and then it is not there when it matters.
  for (const page of PAGES) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true });
    await ctx.addInitScript(STUB(false));            // opening, not yet connected
    const pg = await ctx.newPage();
    pg.on('pageerror', e => threw.push('cold ' + page + ': ' + String(e.message || e).split('\n')[0]));
    await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await pg.goto(base + '/' + page, { waitUntil: 'domcontentloaded' });

    // Watch every frame, not the end state. A bar that goes up at 2.5s and comes down
    // when the socket opens has cleared itself long before any settled check looks —
    // which is exactly the thing being complained about, and exactly what a check of
    // the end state cannot see.
    await pg.evaluate((sel) => {
      window.__barEver = false;
      (function tick() {
        if (document.querySelector(sel)) window.__barEver = true;
        requestAnimationFrame(tick);
      })();
    }, BAR);

    // Well past the 2.5s a real disconnect gets, and past any connect worth waiting on.
    await pg.waitForTimeout(3200);
    const quiet = await pg.evaluate((sel) => !document.querySelector(sel), BAR);
    check(page + ' does not report an outage while it is still opening', quiet,
          'the bar appeared during a restart that had not failed at anything');

    // The socket comes up, as it does on nearly every restart.
    await pg.evaluate(() => window.__setConnected(true));
    await pg.waitForTimeout(200);
    const everSaid = await pg.evaluate(() => window.__barEver);
    check(page + ' gets through a restart having said nothing at any point', !everSaid,
          'the bar was on screen at some point during a restart that worked');
    await ctx.close();
  }

  // But a start that really has failed is still a fault, and still gets said. This is
  // the half that would be easy to lose while making the other half quiet.
  {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true });
    await ctx.addInitScript(STUB(false));
    const pg = await ctx.newPage();
    pg.on('pageerror', e => threw.push('never: ' + String(e.message || e).split('\n')[0]));
    await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await pg.goto(base + '/pos.html', { waitUntil: 'domcontentloaded' });
    let arrived = true;
    try { await pg.waitForSelector(BAR, { state: 'visible', timeout: 9000 }); }
    catch (e) { arrived = false; }
    check('a till that opens and never connects is still told so', arrived,
          'the bar never appeared, so an outage at opening time would go unmentioned');
    note('quiet while it might still work; not quiet once it plainly has not');
    await ctx.close();
  }

  check('no page threw while any of that ran', threw.length === 0, threw.join(' | '));

  await browser.close();
  server.close();
  done();
})();
