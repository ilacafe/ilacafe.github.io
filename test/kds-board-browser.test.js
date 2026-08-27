// The kitchen board, in a real browser, redrawing only when the board has changed.
//
// WHAT THIS EXISTS TO CATCH
//
// orders/active/<station> is watched with .on('value'), so the callback fires for
// ANY change to any ticket under it — including one that changes nothing anybody
// can see. markOrderDone stamps doneAt on the ticket before it clears it, precisely
// so a second tap on a slow connection is refused; doneAt is not rendered anywhere.
//
// Rebuilding the whole board on that event replaced every card, including the one
// markOrderDone had just started fading out. The fade was wiped, the card snapped
// back to full opacity for the 200ms until the remove landed, and to the person who
// tapped it that reads as the tap not registering — at the exact moment they are
// most likely to tap again. So this is a correctness check that happens to be a
// performance one: the cheapest redraw is the one that does not happen.
//
// It is checked by NODE IDENTITY, not by comparing HTML. Identical markup rebuilt
// from scratch looks the same to any assertion on innerHTML and is the bug: the
// fade lived on the node, and the node is what was thrown away.
//
// Run separately from `npm test` (`npm run test:browser`) because it needs a
// browser. Firebase is stubbed — these pages must run with no credentials, and the
// stub keeps the value listener so the suite can feed it snapshots.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Kitchen board — redrawn when the board changes, not when the node does');

// Injected ahead of the page's own scripts. The CDN files carry SRI hashes, so a
// substituted firebase-*.js is refused by the browser and `firebase` would be
// undefined however convincing the replacement was — the stub has to arrive first
// and simply be there when the page looks.
//
// Arriving first is not enough on its own: firebase-app-compat.js assigns
// window.firebase when it runs, so if it loads at all it overwrites the stub and
// the page goes to the real SDK, finds no session, and shows the login screen
// instead of the board. Every off-origin request is aborted below for that reason.
// Leaving it out passed on a machine whose sandbox happened to block gstatic and
// failed on CI, where the CDN is reachable — the suite has to be the thing that
// stops it, not the network it runs on.
//
// Every ref() is a chaining no-op except the two the page actually needs an answer
// from: orders/active/<station>, which hands its value callback to window.__feed so
// a test can push snapshots through it, and users/<uid>, which must resolve to a
// real role.
//
// users/<uid> has to be a genuine promise, and getting that wrong is what this
// comment is for. A chaining Proxy answers `then` with another callable Proxy, so
// `await` treats it as a thenable, calls it with (resolve, reject), and it does
// nothing with either — the await never settles and the page never gets past the
// role read. That left the seeded localStorage role as the only way in, which is a
// second mechanism to depend on for a suite that is testing neither. It passed on
// one machine and timed out on CI. Both reads answer properly now.
const FIREBASE_STUB = `
(() => {
  const noop = () => {};
  const chain = () => new Proxy(function(){}, { get: () => chain(), apply: () => chain() });
  const snap = (v) => ({ val: () => v, exists: () => v != null, forEach: () => {},
                         numChildren: () => (v ? Object.keys(v).length : 0) });
  window.__feed = null;
  const db = {
    ref: (p) => {
      const path = String(p == null ? '' : p);
      if (path === 'orders/active/chef' || path === 'orders/active/barista') {
        return {
          on: (evt, cb) => { if (evt === 'value') window.__feed = cb; return cb; },
          off: noop, once: () => Promise.resolve(snap(null)),
        };
      }
      if (path.indexOf('users/') === 0) {
        return { once: () => Promise.resolve(snap({ role: 'chef', name: 'Test' })), on: noop, off: noop };
      }
      return chain();
    },
    goOnline: noop, goOffline: noop,
  };
  window.firebase = {
    __stub: true,
    initializeApp: noop,
    apps: [{}],
    database: Object.assign(() => db, { ServerValue: { TIMESTAMP: 0 } }),
    auth: () => ({
      // A signed-in member of staff, so the page admits and startDisplay runs.
      // Which role does not matter: these pages check that there IS one, and
      // database.rules.json is what governs every read behind the screen.
      onAuthStateChanged: (cb) => { setTimeout(() => { try { cb({ uid: 'u1' }); } catch (e) {} }, 0); },
      signInWithEmailAndPassword: () => Promise.resolve({}),
      signOut: () => Promise.resolve(),
      currentUser: { uid: 'u1' },
    }),
    messaging: () => ({ getToken: () => Promise.resolve(null), onMessage: noop }),
  };
})();
`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
                '.png': 'image/png', '.css': 'text/css', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not here');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

const ticket = (dest, items, extra) => Object.assign({
  destination: dest, time: '19:40', source: 'POS', createdAt: 1700000000000, items,
}, extra || {});

(async () => {
  await new Promise(r => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  // The environment ships a browser at a fixed path; a bare launch() looks for a
  // download this repo deliberately does not make a precondition of running.
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  let threw = [];

  for (const [page, station] of [['chef.html', 'chef'], ['barista.html', 'barista']]) {
    const item = station === 'chef' ? 'Margherita' : 'Latte';
    // serviceWorkers: 'block' for the reason build-banner-browser.test.js gives —
    // the worker's own script request does not go through page.route, so a route
    // rule does not stop it, and a page that reloads itself when the worker claims
    // it takes the board's DOM with it mid-assertion.
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    await ctx.addInitScript(FIREBASE_STUB);
    const tab = await ctx.newPage();
    tab.on('pageerror', e => threw.push(page + ': ' + e.message));

    // Same-origin only. This is what keeps the real Firebase SDK off the page, and
    // what makes the run independent of whether the machine can reach a CDN.
    await tab.route('**/*', route =>
      route.request().url().startsWith(base) ? route.continue() : route.abort());

    await tab.goto(base + '/' + page, { waitUntil: 'load' });

    // Checked before anything else, because when it is false everything after it
    // fails as an unexplained timeout waiting for a board that was never going to
    // be drawn. False means the real firebase-app-compat.js loaded and replaced
    // the stub, so the page went to the real SDK, found no session and put up the
    // login screen. It has broken this suite twice; it says so now.
    const stubbed = await tab.evaluate(() => !!(window.firebase && window.firebase.__stub));
    check(page + ' is talking to the stubbed SDK, not the real one', stubbed,
          'the CDN script loaded and overwrote the stub — the off-origin abort is not holding');

    await tab.waitForFunction(() => !!window.__feed, null, { timeout: 5000 });

    // Feed one order in, then the same order again with doneAt stamped on it.
    const send = (orders) => tab.evaluate(o => window.__feed({
      val: () => o, exists: () => o != null, numChildren: () => o ? Object.keys(o).length : 0,
    }), orders);

    const ORDERS = { o1: ticket('Table 6', { [item]: { qty: 1, price: 400 } }) };
    await send(ORDERS);
    await tab.waitForTimeout(60);

    const drew = await tab.evaluate(() => !!document.getElementById('ticket-o1'));
    check(page + ' draws the ticket it is given', drew);

    // Mark the node so a rebuild is detectable: a replaced node has no property.
    await tab.evaluate(() => { const c = document.getElementById('ticket-o1'); if (c) c.__same = true; });

    // ---- the event that used to wipe the fade ----
    const WITH_DONE = { o1: ticket('Table 6', { [item]: { qty: 1, price: 400 } }, { doneAt: 1700000009999 }) };
    await send(WITH_DONE);
    await tab.waitForTimeout(60);

    const survived = await tab.evaluate(() => {
      const c = document.getElementById('ticket-o1');
      return !!(c && c.__same);
    });
    check(page + ' leaves the card alone when only doneAt changed', survived,
          'the card was rebuilt — a fade-out started by markOrderDone is wiped by this');

    // ---- and still redraws when something real changes ----
    const TWO = {
      o1: ticket('Table 6', { [item]: { qty: 1, price: 400 } }, { doneAt: 1700000009999 }),
      o2: ticket('Table 9', { [item]: { qty: 2, price: 800 } }),
    };
    await send(TWO);
    await tab.waitForTimeout(60);

    const both = await tab.evaluate(() => ({
      one: !!document.getElementById('ticket-o1'),
      two: !!document.getElementById('ticket-o2'),
      cards: document.querySelectorAll('.ticket-card').length,
    }));
    check(page + ' draws a new ticket when one arrives', both.one && both.two && both.cards === 2,
          JSON.stringify(both));

    // A quantity change is in the markup, so it must redraw.
    const CHANGED = {
      o1: ticket('Table 6', { [item]: { qty: 3, price: 1200 } }, { doneAt: 1700000009999 }),
      o2: ticket('Table 9', { [item]: { qty: 2, price: 800 } }),
    };
    await send(CHANGED);
    await tab.waitForTimeout(60);
    const qty = await tab.evaluate(() => {
      const c = document.getElementById('ticket-o1');
      return c ? c.innerText.replace(/\s+/g, ' ') : '';
    });
    check(page + ' redraws when a ticket’s items change', /3x/.test(qty), qty.slice(0, 90));

    // ---- the board emptying ----
    await send(null);
    await tab.waitForTimeout(60);
    const empty = await tab.evaluate(() => ({
      cards: document.querySelectorAll('.ticket-card').length,
      state: document.querySelectorAll('.empty-state').length,
      tickets: Object.keys(window.kdsTickets || {}).length,
    }));
    check(page + ' clears to the empty state when the last ticket goes',
          empty.cards === 0 && empty.state === 1 && empty.tickets === 0, JSON.stringify(empty));

    // ---- the elapsed clock still runs ----
    // The per-second pass only writes when the minute changes, so the way this
    // optimisation fails is a guard that never lets the FIRST write through and
    // leaves every card reading blank all service. A ticket four minutes old must
    // say four minutes within a second of arriving.
    //
    // The card text is uppercased by CSS, so innerText comes back as "4M" — matched
    // case-insensitively rather than by reaching for textContent, because what is on
    // the card is the thing being checked.
    await send({ o1: ticket('Table 6', { [item]: { qty: 1, price: 400 } }, { createdAt: Date.now() - 4 * 60000 }) });
    await tab.waitForTimeout(1300);
    const elapsed = await tab.evaluate(() => {
      const el = document.getElementById('elapsed-o1');
      return el ? el.innerText : null;
    });
    check(page + ' still fills in the elapsed time on a card', /^\s*4m/i.test(elapsed || ''),
          String(elapsed));

    await ctx.close();
  }

  check('no page threw while any of that ran', threw.length === 0, threw.join(' | '));
  note('identity, not innerHTML: a rebuild that produces the same markup is the bug');

  await browser.close();
  server.close();
  done();
})();
