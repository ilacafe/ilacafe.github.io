// Does a control that is ON look different from the same control OFF?
//
// The till's category strip stopped highlighting anything, and nothing caught it,
// because nothing broke. The markup was right, the JS was right — setActiveChip()
// went on adding and removing `.active` exactly as it always had. What changed was
// underneath it:
//
//     .cat-chip        { … opacity: 0.6; }        ← the contrast pass removed this
//     .cat-chip.active { opacity: 1; }            ← and left this behind
//
// The highlight had never been a mark on the active chip. It was the ABSENCE of a
// dim that every other chip carried, and the dim had to go: white on this brown
// clears 4.5:1 with almost nothing spare, so 0.6 put every category the cashier was
// not on below the line. Removing it was right. Removing it without giving `.active`
// something of its own to say left a rule that still matched, still applied, and
// resolved to the value the chip already had.
//
// That is the shape worth holding, and it is not specific to one strip: a state
// class whose only declaration has quietly become a no-op. No selector fails, no
// element is missing, no console error — the class goes on and nothing happens. The
// only way to see it is the way a cashier sees it, which is in pixels.
//
// So: for each control that has an on-state, screenshot it off, screenshot it on,
// and require the two images to differ. What the difference IS — a rule, a fill, a
// weight — is a design decision and none of this suite's business. That there is
// one is not.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Every on-state — visibly on');

const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
                '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('no');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

const MENU = {
  Coffee: { 'Latte': { hasSizes: true, priceReg: 170, priceLrg: 210, inStock: true, requiresSweetness: true } },
  Food:   { 'Avocado Toast': { price: 340, inStock: true } },
  Bakery: { 'Croissant': { price: 160, inStock: true } },
  Shakes: { 'Banana Shake': { price: 200, inStock: true } },
  Retail: { 'Beans 250g': { price: 600, inStock: true } }
};

const STUB = `
(() => {
  const MENU = ${JSON.stringify(MENU)};
  const snap = (o) => ({ val: () => (o === undefined ? null : o), exists: () => o != null,
                         numChildren: () => 0, forEach: () => {}, key: null });
  const mk = (p) => { const s = {
    key: 'k', child: () => mk(p), orderByChild: () => s, orderByKey: () => s,
    limitToLast: () => s, limitToFirst: () => s, startAt: () => s, endAt: () => s, equalTo: () => s,
    on: (_e, cb) => { try { if (cb) cb(snap(String(p) === 'menu' ? MENU : null)); } catch (e) {} return cb; }, off: () => {},
    once: (_e, cb) => { const x = snap(String(p) === 'menu' ? MENU : null); if (cb) cb(x); return Promise.resolve(x); },
    push: () => mk(p), set: () => Promise.resolve(), update: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    transaction: (_f, cb) => { const x = snap(null); if (cb) cb(null, false, x); return Promise.resolve({ committed: false, snapshot: x }); }
  }; return s; };
  const database = () => ({ ref: (p) => mk(p || ''), goOnline: () => {}, goOffline: () => {} });
  database.ServerValue = { TIMESTAMP: 1756200000000, increment: (n) => ({ '.sv': { increment: n } }) };
  window.firebase = {
    initializeApp: () => ({}), apps: [], database: database,
    auth: () => ({ currentUser: { uid: 'u1' },
                   onAuthStateChanged: (cb) => { setTimeout(() => { try { cb({ uid: 'u1' }); } catch (e) {} }, 0); return () => {}; },
                   signOut: () => Promise.resolve(),
                   signInWithEmailAndPassword: () => Promise.resolve({ user: { uid: 'u1' } }),
                   signInAnonymously: () => Promise.resolve({ user: { uid: 'a' } }) })
  };
  window.Chart = function () { return { destroy(){}, update(){}, data:{datasets:[]}, options:{} }; };
})();
`;

// Every class in these pages that means "this one is the one you are on". The
// on-state is named separately from the control because the pages use both words:
// a tab strip is `.active`, a picker is `.selected`.
const STATES = [
  { page: 'pos.html',       sel: '.cat-chip',  on: 'active',   says: 'which category the till is scrolled to' },
  { page: 'inventory.html', sel: '.tab-btn',   on: 'active',   says: 'which tab the page is showing' },
  { page: 'analytics.html', sel: '.range-btn', on: 'active',   says: 'which date range the numbers are for' },
  { page: 'index.html',     sel: '.type-btn',  on: 'selected', says: 'dine-in or takeaway' },
  { page: 'index.html',     sel: '.table-btn', on: 'selected', says: 'which table the order is for' },
  { page: 'index.html',     sel: '.choice-btn', on: 'selected', says: 'which option was picked' },
  { page: 'pos.html',       sel: '.choice-btn', on: 'selected', says: 'which option the cashier picked' },
];

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE) ? { executablePath: PRE } : {});
  const threw = [], unreachable = [];
  let covered = 0;

  for (const s of STATES) {
    // Reduce Motion, so the state lands on its final pixels in one frame rather than
    // 200ms later — and so a highlight that only exists DURING a transition, which a
    // cashier with motion turned down would never see, cannot pass this.
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 },
                                           hasTouch: true, reducedMotion: 'reduce' });
    await ctx.addInitScript(STUB);
    const pg = await ctx.newPage();
    pg.on('pageerror', e => threw.push(s.page + ': ' + String(e.message || e).split('\n')[0]));
    await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await pg.goto(base + '/' + s.page, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(700);

    // Get the control onto the screen. Most of these live behind something: a login
    // overlay, a modal that is content-visibility:hidden until opened, a section the
    // page hides while the shop is shut. None of that is what is under test — we are
    // photographing one control's own two states, and both photographs are taken
    // under identical conditions, so revealing it does not tilt the comparison.
    const found = await pg.evaluate((sel) => {
      const o = document.getElementById('login-overlay'); if (o) o.style.display = 'none';
      const el = document.querySelector(sel);
      if (!el) return false;
      const ov = el.closest('.modal-overlay');
      if (ov) { ov.classList.add('active'); ov.style.display = 'flex'; }
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (getComputedStyle(n).display === 'none') n.style.display = 'block';
      }
      el.setAttribute('data-state-probe', '1');
      return el.getBoundingClientRect().width > 0;
    }, s.sel);

    if (!found) { unreachable.push(s.page + ' ' + s.sel); await ctx.close(); continue; }

    const probe = pg.locator('[data-state-probe="1"]');
    await probe.scrollIntoViewIfNeeded();
    const set = (on) => pg.evaluate(([cls, want]) => {
      const el = document.querySelector('[data-state-probe="1"]');
      el.classList.toggle(cls, want);
    }, [s.on, on]);

    await set(false); await pg.waitForTimeout(120);
    const off = await probe.screenshot();
    await pg.waitForTimeout(120);
    const offAgain = await probe.screenshot();
    await set(true); await pg.waitForTimeout(120);
    const on = await probe.screenshot();

    // The control first. Two photographs of an unchanged control must match, or a
    // difference below proves nothing — it could be the renderer wobbling. This is
    // the half that makes the next check mean something.
    const steady = check('an unchanged ' + s.sel + ' on ' + s.page + ' photographs the same twice',
                         offAgain.equals(off), 'the render is not stable; the comparison below is not evidence');

    if (steady) {
      covered++;
      check('.' + s.on + ' on ' + s.sel + ' shows ' + s.says,
            !on.equals(off),
            'adding .' + s.on + ' changed nothing on screen — the rule for it resolves to what the control already had');
    }
    await ctx.close();
  }

  if (unreachable.length) note('not on screen without a flow to drive: ' + unreachable.join(', '));

  // A suite that finds nothing passes, and a screenshot comparison is exactly the
  // kind that can quietly stop finding anything — one renamed class and the .find()
  // above returns undefined for every case. Say how many it actually photographed.
  check('every on-state that can be reached was actually photographed', covered >= 6,
        'only ' + covered + ' of ' + STATES.length + ' — a renamed class makes this suite quietly stop looking');
  check('no page threw while any of that ran', threw.length === 0, threw.join(' | '));

  await browser.close();
  server.close();
  done();
})();
