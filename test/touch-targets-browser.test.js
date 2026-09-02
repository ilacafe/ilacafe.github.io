// The two buttons every order goes through.
//
// On the ordering page, + and - are how a customer builds a cart. Every item the
// café sells is added by one of them, and adding four of something is four taps in
// the same spot. Drawn, they are 32x32 for the standalone + and 26x32 inside the
// quantity control — where the - and the + sit 24px apart with the count between.
//
// A thumb's contact patch is around 45px across. Apple and Google both ask for 44,
// and WCAG's AAA target size is the same number. So the tap that misses here is the
// one that lands on - when it meant +, on a control whose only feedback is a number
// moving by one in either direction — which looks the same whichever way it went.
//
// The size is a real part of how the menu reads: a 44px button on every row would
// double the height of a sixty-row list. So the fix does not change the drawing, it
// changes the TARGET — a transparent ::after centred on each button, sized to 44px,
// is what the finger actually hits.
//
// WHY THIS IS ASKED WITH elementFromPoint AND NOT BY MEASURING
//
// getBoundingClientRect on the button returns the box it is DRAWN as, which is the
// thing this deliberately leaves alone; it cannot see a pseudo-element at all. The
// question worth asking is the one the browser answers on a touch: at this point on
// the glass, which control is pressed? So the points are asked directly, and a
// regression that removes the rule shows up as the answer changing rather than as a
// number being off.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('The ordering page — a target a thumb can hit');

const TARGET = 44;   // Apple HIG, Material, and WCAG 2.5.5 all land on this

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
  const mk = (_p) => { const s = {
    key: 'k', child: () => mk(_p), orderByChild: () => s, orderByKey: () => s,
    limitToLast: () => s, limitToFirst: () => s, startAt: () => s, endAt: () => s, equalTo: () => s,
    on: (_e, cb) => { try { if (cb) cb(snap(null)); } catch (e) {} return cb; }, off: () => {},
    once: (_e, cb) => { const x = snap(null); if (cb) cb(x); return Promise.resolve(x); },
    push: () => mk(_p), set: () => Promise.resolve(), update: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    transaction: (_f, cb) => { const x = snap(null); if (cb) cb(null, false, x); return Promise.resolve({ committed: false, snapshot: x }); }
  }; return s; };
  const database = () => ({ ref: (p) => mk(p || ''), goOnline: () => {}, goOffline: () => {} });
  database.ServerValue = { TIMESTAMP: 1756200000000, increment: (n) => ({ '.sv': { increment: n } }) };
  window.firebase = {
    initializeApp: () => ({}), apps: [], database: database,
    auth: () => ({ currentUser: null, onAuthStateChanged: () => () => {},
                   signInAnonymously: () => Promise.resolve({ user: { uid: 'a' } }),
                   signOut: () => Promise.resolve() })
  };
})();
`;

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE) ? { executablePath: PRE } : {});
  // A phone, because that is the only device this page is opened on.
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 },
                                         deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await ctx.addInitScript(STUB);
  const pg = await ctx.newPage();
  const threw = [];
  pg.on('pageerror', e => threw.push(String(e.message || e).split('\n')[0]));
  await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
  await pg.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(300);

  // The page's own renderer builds the controls, from the page's own CSS. Nothing
  // here is a copy: renderInlineControls is what draws every row of the live menu.
  const built = await pg.evaluate(() => {
    window.cart = { 'Flat White': { price: 180, qty: 2 } };
    const host = document.createElement('div');
    host.innerHTML =
      '<div class="menu-row"><span class="item-name">Flat White</span>' +
      '<div class="swap-container" data-item="Flat White" data-price="180" data-sweet="false"></div></div>' +
      '<div class="menu-row"><span class="item-name">Cold Brew</span>' +
      '<div class="swap-container" data-item="Cold Brew" data-price="220" data-sweet="false"></div></div>';
    document.querySelector('.container').prepend(host);
    window.renderInlineControls();
    return { qty: document.querySelectorAll('.qty-btn').length,
             add: document.querySelectorAll('.add-btn').length };
  });
  check('the page’s own renderer produced controls to measure',
        built.qty === 2 && built.add === 1, JSON.stringify(built));

  // ------------------------------------------------------ the drawing has not moved
  const drawn = await pg.evaluate(() => {
    const box = (sel) => { const r = document.querySelector(sel).getBoundingClientRect();
                           return [Math.round(r.width), Math.round(r.height)]; };
    return { qty: box('.qty-btn'), add: box('.add-btn') };
  });
  // 30 and not 32: the button fills the height of a .qty-ctrl that is 32px including
  // its own 1px border, which is where the two pixels go.
  check('the quantity buttons are still drawn at 26x30',
        drawn.qty[0] === 26 && drawn.qty[1] === 30, drawn.qty.join('x'));
  check('and the standalone + still at 32x32',
        drawn.add[0] === 32 && drawn.add[1] === 32, drawn.add.join('x'));
  note('the fix is a bigger target, not a bigger button — a 44px button on every');
  note('row would double the height of a sixty-row menu');

  // -------------------------------------------------- what the glass actually hits
  // Eight points around each button at the edge of a 44px box centred on it. Each
  // has to resolve to that button and not to its neighbour, the page, or nothing.
  const hits = await pg.evaluate((T) => {
    const r = T / 2 - 1;                       // just inside the edge of the target
    const out = [];
    const btns = [...document.querySelectorAll('.qty-btn, .add-btn')];
    for (const btn of btns) {
      const b = btn.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const label = (btn.getAttribute('aria-label') || btn.textContent).slice(0, 28);
      for (const [dx, dy] of [[0,-r],[0,r],[-r,0],[r,0],[-r,-r],[r,-r],[-r,r],[r,r]]) {
        const hit = document.elementFromPoint(cx + dx, cy + dy);
        if (hit !== btn) {
          out.push(label + ' at (' + dx + ',' + dy + ') hit ' +
                   (hit ? (hit.className || hit.tagName) : 'nothing'));
        }
      }
    }
    return { misses: out, checked: btns.length };
  }, TARGET);

  check('every point inside a ' + TARGET + 'px box hits the button it belongs to',
        hits.misses.length === 0, hits.misses.join(' | '));
  note(hits.checked + ' buttons, 8 points each, asked of the browser rather than measured');

  // ------------------------------------------------ and the two are still separable
  // Enlarging both targets is only an improvement if - and + do not start swallowing
  // each other: overlapping targets resolve to whichever centre is nearer, and the
  // one thing worse than a small + is a + that removes an item.
  const separable = await pg.evaluate(() => {
    const [minus, plus] = [...document.querySelectorAll('.qty-ctrl .qty-btn')];
    const c = (el) => { const b = el.getBoundingClientRect();
                        return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; };
    const m = c(minus), p = c(plus);
    return { onMinus: document.elementFromPoint(m.x, m.y) === minus,
             onPlus:  document.elementFromPoint(p.x, p.y) === plus,
             apart: Math.round(p.x - m.x) };
  });
  check('the centre of - is still -, and the centre of + is still +',
        separable.onMinus && separable.onPlus, JSON.stringify(separable));
  note('centres ' + separable.apart + 'px apart, so the two targets do not cover each other');

  // -------------------------------------------------------- and they say what they do
  const named = await pg.evaluate(() => {
    const bad = [];
    for (const b of document.querySelectorAll('.qty-btn, .add-btn')) {
      const name = b.getAttribute('aria-label');
      if (!name || !/[a-z]{3}/i.test(name)) bad.push((b.textContent || '?') + ': ' + (name || 'no name'));
    }
    return bad;
  });
  check('and each names the item it acts on, not just "+"',
        named.length === 0, named.join(', '));
  note('sixty rows of a button whose entire accessible name was "+" is sixty buttons');
  note('a screen reader cannot tell apart');

  await ctx.close();

  // ---------------------------------------------- and every other control, everywhere
  //
  // The + and - were fixed on the ordering page and nowhere else, which left the
  // till with the same 32px control — and the till is the one tapped all day at
  // speed. Worse, the till HAD a partial fix: an ::after extending 8px above and
  // below with left:0; right:0, which pins the target to the button's own 32px
  // width. It looked done and was half done, in the dimension nobody checked.
  //
  // So the question is asked of every interactive control on every page, the same
  // way: not how big is it drawn, but how big is the thing the glass hits.
  const MIN = 44;
  const SCAN = (MIN) => {
    const SEL = 'button, input:not([type=hidden]), select, textarea, [role="button"]';
    const out = [];
    let skipped = 0, seen = 0;
    for (const el of document.querySelectorAll(SEL)) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (el.disabled || el.closest('[disabled]')) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      // A label wrapping a checkbox IS part of that control — clicking it activates
      // the box — so the target is the label's, not the 24px box inside it. An input
      // cannot carry a ::after (pseudo-elements do not render on replaced elements),
      // so a padded label is the only way a checkbox gets a real target at all.
      const owner = (el.tagName === 'INPUT' && el.closest('label')) || el;
      const hit = (dx, dy) => {
        const e = document.elementFromPoint(cx + dx, cy + dy);
        return e === owner || owner.contains(e);
      };
      // Not "how far can it stretch" but the question a finger asks: is a MIN-sized
      // box centred here all this control? Measuring the stretch reported 42 for a
      // target that is exactly 44, because the last probe point sits on the edge.
      const q = MIN / 2 - 1;
      // elementFromPoint answers about the VIEWPORT and returns null outside it, so a
      // control scrolled off the bottom reads as "nothing there" and looks like a
      // failure. The scan runs at a tall viewport for that reason; anything still out
      // of range is skipped rather than reported, and counted so the skipping is visible.
      if (cx - q < 0 || cy - q < 0 ||
          cx + q > document.documentElement.clientWidth ||
          cy + q > document.documentElement.clientHeight) { skipped++; continue; }
      // A control inside a closed modal still has a box — these overlays are hidden
      // with content-visibility, not display — but nothing can hit it. If its own
      // centre does not resolve to it, it is not on screen to be tapped at all.
      if (!hit(0, 0)) { skipped++; continue; }
      const covered = [[0,-q],[0,q],[-q,0],[q,0],[-q,-q],[q,-q],[-q,q],[q,q]].every(([dx,dy]) => hit(dx,dy));
      if (!covered) {
        const key = el.tagName.toLowerCase() +
                    (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '');
        out.push(key + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }
      seen++;
    }
    return { bad: [...new Set(out)], skipped, seen };
  };

  for (const page of ['index.html', 'pos.html', 'admin.html', 'analytics.html',
                      'barista.html', 'chef.html', 'inventory.html']) {
    const c = await browser.newContext({ serviceWorkers: 'block', hasTouch: true,
      viewport: page === 'index.html' ? { width: 390, height: 2600 } : { width: 1024, height: 3200 } });
    await c.addInitScript(STUB);
    const pg2 = await c.newPage();
    pg2.on('pageerror', e => threw.push(page + ': ' + String(e.message || e).split('\n')[0]));
    await pg2.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await pg2.goto(base + '/' + page, { waitUntil: 'domcontentloaded' });
    await pg2.waitForTimeout(600);
    // The sign-in overlay covers the page it guards, and elementFromPoint answers
    // with the overlay rather than the control underneath.
    await pg2.evaluate(() => { const o = document.getElementById('login-overlay'); if (o) o.style.display = 'none'; });
    // Most of the till's controls live in modals, and a closed modal is not
    // hit-testable — scanning the page as loaded checked ONE control of forty-nine
    // and passed. So each overlay is opened in turn and scanned while it is up,
    // which is the only state in which those buttons are ever pressed.
    const bad = new Set();
    let seen = 0, skipped = 0;
    const sweep = async () => {
      const r = await pg2.evaluate(SCAN, MIN);
      r.bad.forEach(x => bad.add(x));
      seen += r.seen; skipped += r.skipped;
    };
    await sweep();

    // A KITCHEN BOARD WITH NOTHING ON IT HAS NO CONTROLS AT ALL
    //
    // Its one control is DONE, the most-pressed button in the building, and it only
    // exists on a ticket. Rather than reconstruct a live board here — kds-board-
    // browser.test.js already drives the real one — the class is instantiated and
    // measured, because the page's CSS is the thing that decides the target and the
    // CSS is what this suite is about.
    if (page === 'chef.html' || page === 'barista.html') {
      const done = await pg2.evaluate(() => {
        const b = document.createElement('button');
        b.className = 'btn-done'; b.textContent = 'Done';
        const host = document.querySelector('.kds-container') || document.body;
        host.appendChild(b);
        const r = b.getBoundingClientRect();
        const out = { w: Math.round(r.width), h: Math.round(r.height) };
        b.remove();
        return out;
      });
      check(page + ' — the DONE button on a ticket is at least ' + MIN + 'px tall',
            done.h >= MIN, done.w + 'x' + done.h);
    }

    const overlays = await pg2.evaluate(() => [...document.querySelectorAll('.modal-overlay')].map(o => o.id).filter(Boolean));
    for (const id of overlays) {
      await pg2.evaluate((i) => { document.getElementById(i).classList.add('active'); }, id);
      await pg2.waitForTimeout(60);
      await sweep();
      await pg2.evaluate((i) => { document.getElementById(i).classList.remove('active'); }, id);
    }

    check(page + ' — every control is at least ' + MIN + 'px in both directions',
          bad.size === 0, [...bad].join(', '));
    // A check that examined almost nothing is not a check that passed. This caught
    // itself once already: with the modals left closed, the till reported ONE control
    // of forty-nine and passed clean.
    //
    // The two kitchen boards are the honest exception — an idle board has no controls
    // to examine, which is why the DONE button is measured separately above.
    const idleBoard = page === 'chef.html' || page === 'barista.html';
    if (!idleBoard) {
      check(page + ' — and enough of them were actually on screen to mean anything',
            seen >= 6, 'only ' + seen + ' were hit-testable (' + skipped + ' skipped, ' +
                       overlays.length + ' overlays opened)');
    }
    note(page + ': ' + seen + ' checked across ' + (overlays.length + 1) + ' states');
    await c.close();
  }
  note('measured as hit-tested, so a ::after-expanded target counts at its real size');
  note('44 is Apple HIG, Material and WCAG 2.5.5, which all land on the same number');

  check('no page threw while any of that ran', threw.length === 0, threw.join(' | '));

  await browser.close();
  server.close();
  done();
})();
