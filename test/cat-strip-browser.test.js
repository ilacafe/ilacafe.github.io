// The category strip on the till, and the mark that says which one you are in.
//
// The strip is how the counter gets from the pizzas to the coffees without scrolling
// past forty rows, and the only thing telling a cashier where they are in a menu that
// is longer than the screen is the 2px rule under the chip they last tapped. That
// rule went out on its own.
//
// HOW. Tapping a chip does two things: it marks the chip, and it starts a smooth
// scroll. The spy that keeps the mark in step with scrolling would fight that
// animation, so it is locked out for 900ms while it runs. Separately, any change to
// the menu re-renders it — and the render rebuilds the strip's chips from scratch,
// dropping the class with them, leaving posSpy() to put it back. Inside those 900ms
// posSpy() is the one thing that will not run. So a render landing in that window
// cleared the highlight and nothing restored it until the next scroll: the strip
// showed nothing selected, on a menu the cashier was in the middle of.
//
// It is not a narrow window either. renderPOSMenu runs on every menu edit, every
// stock toggle, every category or item reorder, and every reconnect — all of which
// happen while the till is open, because the iPad the menu is edited on is on the
// same counter.
//
// This drives the page's own renderer and the page's own jump handler, and asks the
// strip what it is showing afterwards. Nothing here is a copy.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('The till’s category strip — the mark stays on the category you are in');

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

const STUB = `
(() => {
  const snap = (o) => ({ val: () => (o === undefined ? null : o), exists: () => o != null,
                         numChildren: () => 0, forEach: () => {}, key: null });
  const mk = () => { const s = {
    key: 'k', child: () => mk(), orderByChild: () => s, orderByKey: () => s,
    limitToLast: () => s, limitToFirst: () => s, startAt: () => s, endAt: () => s, equalTo: () => s,
    on: (_e, cb) => { try { if (cb) cb(snap(null)); } catch (e) {} return cb; }, off: () => {},
    once: (_e, cb) => { const x = snap(null); if (cb) cb(x); return Promise.resolve(x); },
    push: () => mk(), set: () => Promise.resolve(), update: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    transaction: (_f, cb) => { const x = snap(null); if (cb) cb(null, false, x); return Promise.resolve({ committed: false, snapshot: x }); }
  }; return s; };
  const database = () => ({ ref: () => mk(), goOnline: () => {}, goOffline: () => {} });
  database.ServerValue = { TIMESTAMP: 1756200000000, increment: (n) => ({ '.sv': { increment: n } }) };
  window.firebase = {
    initializeApp: () => ({}), apps: [], database: database,
    auth: () => ({ currentUser: null, onAuthStateChanged: () => () => {},
                   signInAnonymously: () => Promise.resolve({ user: { uid: 'a' } }),
                   signOut: () => Promise.resolve() })
  };
})();
`;

// Long enough that the categories do not all fit on one screen, which is the only
// situation in which any of this matters.
const MENU = {
  Pizza:     { Margherita: { price: 320, inStock: true }, Farmhouse: { price: 380, inStock: true },
               Pepperoni: { price: 420, inStock: true }, Marinara: { price: 300, inStock: true } },
  Sides:     { 'Garlic Bread': { price: 140, inStock: true }, Fries: { price: 120, inStock: true } },
  Coffee:    { Cappuccino: { price: 150, inStock: true }, Americano: { price: 140, inStock: true } },
  Beverages: { 'Iced Tea': { price: 130, inStock: true }, Lemonade: { price: 120, inStock: true } },
  Dessert:   { Brownie: { price: 180, inStock: true }, Tiramisu: { price: 240, inStock: true } }
};
const ORDER = ['Pizza', 'Sides', 'Coffee', 'Beverages', 'Dessert'];

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE) ? { executablePath: PRE } : {});
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 },
                                         isMobile: true, hasTouch: true });
  await ctx.addInitScript(STUB);
  const pg = await ctx.newPage();
  const threw = [];
  pg.on('pageerror', e => threw.push(String(e.message || e).split('\n')[0]));
  await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
  await pg.goto(base + '/pos.html', { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(300);

  // The page's own renderer builds the strip.
  const built = await pg.evaluate(([menu, order]) => {
    window.renderPOSMenu(menu, order);
    return { chips: [...document.querySelectorAll('.cat-chip')].map(c => c.getAttribute('data-cat')),
             heads: [...document.querySelectorAll('h2[id^="cat-"]')].map(h => h.id) };
  }, [MENU, ORDER]);

  check('the page’s own renderer produced a chip per category',
        built.chips.length === ORDER.length && built.heads.length === ORDER.length,
        JSON.stringify(built));
  note(built.chips.join(' '));

  const marked = () => pg.evaluate(() =>
    [...document.querySelectorAll('.cat-chip.active')].map(c => c.getAttribute('data-cat')));

  // ------------------------------------------------------ a tap marks what was tapped
  await pg.evaluate(() => window.jumpToCategory('cat-Coffee'));
  await pg.waitForTimeout(120);
  let now = await marked();
  check('tapping a category marks that category, and only that one',
        now.length === 1 && now[0] === 'cat-Coffee', JSON.stringify(now));

  // ------------------------------------------ and a re-render mid-scroll does not lose it
  // This is the bug. 120ms in, the smooth scroll is still running and the spy is
  // still locked out — which is exactly when a menu edit from the admin iPad used to
  // land and take the highlight with it.
  await pg.evaluate(([menu, order]) => window.renderPOSMenu(menu, order), [MENU, ORDER]);
  await pg.waitForTimeout(60);
  now = await marked();
  check('a menu re-render while the jump is still animating keeps the mark',
        now.length === 1 && now[0] === 'cat-Coffee',
        now.length ? JSON.stringify(now) : 'nothing is marked — the strip went blank');
  note('the render rebuilds every chip, and posSpy() — which used to be the only thing');
  note('that put the mark back — is deliberately locked out for 900ms after a tap');

  // ----------------------------------------------- and it is still right once it settles
  await pg.waitForTimeout(1100);
  now = await marked();
  check('and the spy still has the last word once the scroll has finished',
        now.length === 1, JSON.stringify(now));

  // ------------------------------------------------------- a render on its own is safe too
  await pg.evaluate(() => window.scrollTo(0, 0));
  await pg.waitForTimeout(300);
  await pg.evaluate(([menu, order]) => window.renderPOSMenu(menu, order), [MENU, ORDER]);
  await pg.waitForTimeout(120);
  now = await marked();
  check('a render with no jump in flight leaves exactly one category marked',
        now.length === 1, JSON.stringify(now));
  note('a strip that marks nothing is a menu with no "you are here" on it');

  // ------------------------------------------- and it stays put after the jump lands
  //
  // Reported from the counter again: the category heading "fading". A jump lands its
  // heading ON the spy's line — scroll-margin-top is the same number — and layout rounds:
  // a heading resting at 67.19 against a line of 67 read as "not reached", so the first
  // scroll event after the 900ms lock moved the mark to the category above, and the
  // underline faded out of the chip just tapped. OFFLINE MODE coming or going in the
  // header is enough to cause that event; so is a finger on the glass. Every category,
  // tapped and then nudged, on the phone and on the iPad the tills are.
  for (const [label, w, h] of [['phone', 390, 844], ['iPad', 1180, 820], ['iPad portrait', 820, 1180]]) {
    const c2 = await browser.newContext({ serviceWorkers: 'block', viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
    await c2.addInitScript(STUB);
    const p2 = await c2.newPage();
    p2.on('pageerror', e => threw.push(label + ': ' + String(e.message || e).split('\n')[0]));
    await p2.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await p2.goto(base + '/pos.html', { waitUntil: 'domcontentloaded' });
    await p2.waitForTimeout(300);
    const heads = await p2.evaluate(([menu, order]) => {
      window.renderPOSMenu(menu, order);
      return [...document.querySelectorAll('h2[id^="cat-"]')].map(h => h.id);
    }, [MENU, ORDER]);
    const mark = () => p2.evaluate(() => [...document.querySelectorAll('.cat-chip.active')].map(c => c.getAttribute('data-cat')));
    const drifted = [];
    for (const id of heads) {
      await p2.evaluate(id => window.jumpToCategory(id), id);
      await p2.waitForTimeout(1100);                       // landed, and the lock is over
      await p2.evaluate(() => window.scrollBy(0, -2));     // two pixels of nothing much
      await p2.waitForTimeout(150);
      const m = await mark();
      if (!(m.length === 1 && m[0] === id)) drifted.push(id + ' → ' + (m[0] || 'nothing'));
    }
    check(label + ': a tapped category stays marked when the page moves a pixel or two after it lands',
          drifted.length === 0, drifted.join(', '));
    // Scrolled to the bottom by hand, with no tap, the last category is the one marked —
    // what the bottom rule was for, and kept.
    await p2.evaluate(() => window.scrollTo(0, 0));
    await p2.waitForTimeout(300);
    await p2.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await p2.waitForTimeout(250);
    const end = await mark();
    check(label + ': scrolled to the bottom by hand, the last category is the one marked',
          end.length === 1 && end[0] === heads[heads.length - 1], JSON.stringify(end));
    // ...and when OFFLINE MODE comes up in the header above the menu, as it does on café wifi
    const mid = heads[Math.floor(heads.length / 2)];
    await p2.evaluate(id => window.jumpToCategory(id), mid);
    await p2.waitForTimeout(1100);
    await p2.evaluate(() => { document.getElementById('offline-indicator').style.display = 'block'; });
    await p2.waitForTimeout(250);
    const m = await mark();
    check(label + ': and when OFFLINE MODE comes up in the header above it',
          m.length === 1 && m[0] === mid, JSON.stringify(m));
    await c2.close();
  }

  // ------------------------------------------ mid-menu, where only the rounding is at work
  //
  // A menu long enough that the tapped category is nowhere near the bottom, so the bottom
  // rule cannot be what keeps or loses the mark — only the line can.
  {
    const LONG = {}; const ORD = [];
    [['Pizza', 10], ['Pasta', 6], ['Sides', 4], ['Coffee', 8], ['Cold Coffee', 5], ['Tea', 4],
     ['Beverages', 6], ['Shakes', 3], ['Dessert', 3], ['Add-ons', 2]].forEach(([c, n]) => {
      LONG[c] = {}; ORD.push(c);
      for (let i = 0; i < n; i++) LONG[c][c + ' ' + i] = { price: 100 + i * 10, inStock: true };
    });
    const c3 = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await c3.addInitScript(STUB);
    const p3 = await c3.newPage();
    p3.on('pageerror', e => threw.push('long menu: ' + String(e.message || e).split('\n')[0]));
    await p3.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await p3.goto(base + '/pos.html', { waitUntil: 'domcontentloaded' });
    await p3.waitForTimeout(300);
    await p3.evaluate(([menu, order]) => window.renderPOSMenu(menu, order), [LONG, ORD]);
    const drifted = [];
    for (const id of ['cat-Pasta', 'cat-Sides', 'cat-Coffee', 'cat-Tea']) {
      await p3.evaluate(id => window.jumpToCategory(id), id);
      await p3.waitForTimeout(1100);
      const r = await p3.evaluate(() => {
        const atBottom = (innerHeight + scrollY) >= (document.documentElement.scrollHeight - 4);
        window.scrollBy(0, -2);
        return atBottom;
      });
      await p3.waitForTimeout(150);
      const m = await p3.evaluate(() => [...document.querySelectorAll('.cat-chip.active')].map(c => c.getAttribute('data-cat')));
      if (r) drifted.push(id + ' was at the bottom — this check needs a longer menu');
      else if (!(m.length === 1 && m[0] === id)) drifted.push(id + ' → ' + (m[0] || 'nothing'));
    }
    check('mid-menu, a tapped category is still marked after the page moves two pixels',
          drifted.length === 0, drifted.join(', '));
    note('the jump lands the heading on the very line the spy measures — rounding used to decide');
    await c3.close();
  }

  check('no page threw while any of that ran', threw.length === 0, threw.join(' | '));

  await browser.close();
  server.close();
  done();
})();
