// Does the page fit the phone it is opened on?
//
// A LOGO WIDER THAN THE VIEWPORT IS A PAGE THAT SLIDES SIDEWAYS. `.logo` was capped
// at 350px with max-width alone, which caps it against nothing: at a 320px viewport
// a 350px cap is still 350px, and index.html, pos.html and admin.html each gained
// 50px of horizontal scroll. analytics.html had already been fixed — max-width:
// min(350px, 78vw) — and the three pages that needed it most never got it.
//
// This reads as an iPhone SE problem and is not one. Browser zoom shrinks the LAYOUT
// viewport: a customer at 200% on an ordinary 390px phone has about 195px to work
// with. So the person who zooms in because they cannot read the menu is exactly the
// person the menu then starts sliding under, which is WCAG 1.4.10 Reflow and is also
// just miserable to use one-handed at a table.
//
// Underneath it, a second one: `.container { width: 90%; padding: 20px }` with no
// border-box computes to 328px inside a 320px viewport, 8px over on its own.
//
// THE VIEWPORT META IS CHECKED HERE TOO, because it is the other half of the same
// question — what does the page tell the browser about the space it has?
//
//   admin.html carried user-scalable=no and maximum-scale=1, which blocks pinch-zoom
//   on the page where the owner reads money. iOS has ignored both since iOS 10;
//   Android Chrome honours them.
//
//   And a page either declares viewport-fit=cover AND pads content back out of the
//   notch with env(safe-area-inset-*), or does neither and lets the browser keep the
//   page inside the safe area itself. Both halves alone are bugs, and both were
//   present: admin used the insets with no cover, so two declarations meant to clear
//   the notch had never resolved to anything but zero; the kitchen boards declared
//   cover with no insets, so a board mounted landscape on a notched tablet could sit
//   its left edge under the camera housing.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, readPage, suite } = require('./helpers');

const { check, note, done } = suite('Every page — fits the phone, and says so honestly');

const PAGES = ['index.html', 'pos.html', 'admin.html', 'analytics.html',
               'barista.html', 'chef.html', 'inventory.html'];

// ------------------------------------------------------------- the viewport meta
{
  const blocked = [], mismatched = [];
  for (const p of PAGES) {
    const src = readPage(p);
    const m = /<meta name="viewport"[^>]*content="([^"]*)"/.exec(src);
    if (!m) { blocked.push(p + ': no viewport meta at all'); continue; }
    const content = m[1];

    if (/user-scalable\s*=\s*no/.test(content) || /maximum-scale\s*=\s*1(\.0)?\b/.test(content)) {
      blocked.push(p + ': ' + content);
    }

    // The stylesheet, not the whole file: env() inside a comment is not a use.
    const usesInsets = /env\(\s*safe-area-inset/.test(src);
    const cover = /viewport-fit\s*=\s*cover/.test(content);
    if (cover && !usesInsets) mismatched.push(p + ': declares cover, pads nothing back');
    if (!cover && usesInsets) mismatched.push(p + ': uses safe-area insets, never declares cover (they resolve to 0)');
  }
  check('no page stops a customer pinching to zoom', blocked.length === 0, blocked.join(' | '));
  note('iOS ignores user-scalable=no; Android Chrome does not, so it blocks half the phones');

  check('a page either draws under the notch and pads for it, or does neither',
        mismatched.length === 0, mismatched.join(' | '));
  note('cover without insets puts content under the camera; insets without cover are dead code');
}

// -------------------------------------------------------------- and it has to fit
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

// A menu with a long name and two sized items, because an empty page reflows
// perfectly and proves nothing: the widest thing on the ordering page is a row.
//
// The category names are the café's own — PIZZA SIDES COFFEE BEVERAGES DESSERT. Five
// short invented ones fit in almost any strip and proved the strip was fixed when it
// was not: these five come to 362px of chip, and the strip the till was giving them
// was 350px on a 390px phone.
const MENU = {
  Pizza: {
    'Margherita': { hasSizes: true, priceReg: 170, priceLrg: 210, inStock: true },
    'Quattro Formaggi with an extremely long name': { hasSizes: true, priceReg: 190, priceLrg: 230, inStock: true },
    'Marinara': { price: 220, inStock: false }
  },
  Sides: { 'Stuffed Garlic Bread with Poached Eggs': { price: 340, inStock: true } },
  Coffee: { 'Iced Americano': { hasSizes: true, priceReg: 200, priceLrg: 300, inStock: true } },
  Beverages: { 'Fresh Lime Soda': { price: 200, inStock: true } },
  Dessert: { 'Tiramisu': { price: 300, inStock: true } }
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

// 320 CSS px is a small phone, and it is also an ordinary phone at 200% zoom, and a
// phone in a split-screen pair. WCAG 1.4.10 asks for 320.
const NARROW = 320;

// An iPhone 13 in portrait, which is the phone the bleed was photographed on, and the
// brand brown its band is painted in.
const INSET = 47;
const BRAND = '141,110,82';

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE) ? { executablePath: PRE } : {});
  const threw = [];

  for (const page of PAGES) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: NARROW, height: 900 } });
    await ctx.addInitScript(STUB);
    const pg = await ctx.newPage();
    pg.on('pageerror', e => threw.push(page + ': ' + String(e.message || e).split('\n')[0]));
    await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await pg.goto(base + '/' + page, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(600);
    await pg.evaluate(() => { const o = document.getElementById('login-overlay'); if (o) o.style.display = 'none'; });

    const r = await pg.evaluate(() => {
      const doc = document.documentElement;
      const over = doc.scrollWidth - doc.clientWidth;
      const culprits = [];
      if (over > 0) {
        for (const el of document.querySelectorAll('*')) {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const b = el.getBoundingClientRect();
          if (b.width && b.right > doc.clientWidth + 1) {
            culprits.push(el.tagName.toLowerCase() +
                          (el.id ? '#' + el.id : '') +
                          (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '') +
                          ' (' + Math.round(b.width) + 'px wide, ends at ' + Math.round(b.right) + ')');
          }
        }
      }
      return { over, culprits: [...new Set(culprits)].slice(0, 6) };
    });

    check(page + ' does not scroll sideways at ' + NARROW + 'px',
          r.over <= 0, 'overflows by ' + r.over + 'px — ' + r.culprits.join(', '));

    // A HEADER ONLY MEANS SOMETHING IF ITS COLUMNS ARE THE ROW'S COLUMNS
    //
    // REG and LRG sit above the two price columns on the sized-drink rows, and they
    // are a separate grid from the rows they label. Both asked for 2fr 1fr 1fr and
    // resolved differently, because an fr track's minimum is its content and only the
    // row has content with a minimum — .swap-container sets min-width:76px. The right
    // edges matched by luck, so LRG looked right and REG sat 19px into the Large
    // column, on the row where reading the wrong column costs a customer a drink.
    //
    // Checked as geometry rather than as CSS: the two can be written identically and
    // still resolve apart, which is exactly what happened.
    const cols = await pg.evaluate(() => {
      const h = document.querySelector('.coffee-header');
      const rows = [...document.querySelectorAll('.coffee-row')];
      if (!h || !rows.length) return null;
      const edges = (el) => [...el.children].map(c => {
        const b = c.getBoundingClientRect();
        return Math.round(b.left) + '..' + Math.round(b.right);
      }).join(' ');
      return { head: edges(h), rows: [...new Set(rows.map(edges))] };
    });
    if (cols) {
      check(page + ' — REG and LRG sit over the columns they name',
            cols.rows.length === 1 && cols.rows[0] === cols.head,
            'header ' + cols.head + '  vs  rows ' + cols.rows.join(' | '));
    }

    await ctx.close();
  }

  note('320px is a small phone, an ordinary phone at 200% zoom, and half a split screen');

  // ---------------------------------------------- the till's sticky category strip
  //
  // This is a bar across the till — its own background, its own bottom rule — and it
  // was living inside the container's 20px of padding. That was survivable while
  // .container was content-box and the padding hung outside the declared width.
  // Giving the container border-box, so it stops overflowing a 320px screen, folded
  // that padding inwards and took 40px off everything inside it. Five categories that
  // fit on one line on every iPhone started wrapping onto two, and because the chips
  // had just been given min-height:44px each of those lines was twice as tall: a
  // 39px strip became 107px of permanently sticky header, on the screen where that
  // space is the menu.
  //
  // Two things are held here. The strip reaches the edge of the SCREEN, not the edge of
  // the container — which is what regressed, twice. And the chips fit on one line at the
  // widths a till is actually held at, which is what anyone noticed.
  //
  // Twice, because the first fix cancelled one inset and there are two: 20px of container
  // padding, and the 5vw of gutter beside a container that is `width: 90%`. Cancelling
  // only the padding left a 350px strip on a 390px phone, which is 12px short of the
  // café's own five categories — so the strip still wrapped, and the check that was
  // supposed to catch that passed, because it asked whether the strip filled the
  // container and it did.
  for (const width of [375, 390]) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 800 }, hasTouch: true });
    await ctx.addInitScript(STUB);
    const pg = await ctx.newPage();
    pg.on('pageerror', e => threw.push('pos.html@' + width + ': ' + String(e.message || e).split('\n')[0]));
    await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await pg.goto(base + '/pos.html', { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(700);
    await pg.evaluate(() => { const o = document.getElementById('login-overlay'); if (o) o.style.display = 'none'; });

    const strip = await pg.evaluate(() => {
      const s = document.querySelector('.cat-strip');
      const c = document.querySelector('.container');
      if (!s || !c) return null;
      const chips = [...s.querySelectorAll('.cat-chip')];
      const lines = new Set(chips.map(ch => Math.round(ch.getBoundingClientRect().top))).size;
      return { w: Math.round(s.getBoundingClientRect().width), h: Math.round(s.getBoundingClientRect().height),
               container: c.clientWidth, chips: chips.length, lines,
               overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    if (strip && strip.chips) {
      check('the till\'s category strip reaches the edge of a ' + width + 'px screen',
            strip.w >= width - 1,
            strip.w + 'px of a ' + width + 'px screen, in a ' + strip.container + 'px container');
      check('and ' + strip.chips + ' categories still fit on one line at ' + width + 'px',
            strip.lines === 1, strip.lines + ' lines, ' + strip.h + 'px of sticky header');
      // Widening a child past its parent is how you buy a horizontal scrollbar, and the
      // strip is now deliberately wider than the box it sits in.
      check('and reaching the edge did not push the page off it at ' + width + 'px',
            strip.overflow <= 0, strip.overflow + 'px of horizontal scroll');
    }
    await ctx.close();
  }
  note('a sticky strip is height taken from the menu for as long as the till is open');

  // -------------------------------------------------- and the same strip in two panes
  //
  // Every check above is a phone held in one hand, and the till is not always that. At
  // 900px the layout becomes two columns — menu left, live order right — and the strip
  // stays inside the left one. A full-bleed strip in a two-column layout does not span
  // the screen: it spans the screen ACROSS the other column. On an 11-inch iPad it ran
  // 54px into the live order and painted out the word CURRENT in CURRENT ORDER, with an
  // opaque background at z-index 900, on the pane a cashier reads to know what they are
  // charging for.
  //
  // Nothing caught it because nothing above 430px was ever measured. The widths here are
  // the two-pane layout at the sizes a till is actually stood up at, and the question is
  // the one the phone checks cannot ask: does the strip stay in its own column?
  for (const [width, height, what] of [[1194, 834, 'an 11-inch iPad in landscape'],
                                       [1024, 768, 'a 10-inch iPad in landscape'],
                                       [900, 700, 'the breakpoint itself']]) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height }, hasTouch: true });
    await ctx.addInitScript(STUB);
    const pg = await ctx.newPage();
    pg.on('pageerror', e => threw.push('pos.html@' + width + ': ' + String(e.message || e).split('\n')[0]));
    await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await pg.goto(base + '/pos.html', { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(700);
    await pg.evaluate(() => { const o = document.getElementById('login-overlay'); if (o) o.style.display = 'none'; });

    const panes = await pg.evaluate(() => {
      const s = document.querySelector('.cat-strip');
      const menu = document.querySelector('.pane-menu');
      const cart = document.querySelector('.pane-cart');
      if (!s || !menu || !cart) return null;
      const S = s.getBoundingClientRect(), M = menu.getBoundingClientRect(), C = cart.getBoundingClientRect();
      return { twoPane: C.width > 0, gap: Math.round(C.left - S.right),
               widerThanPane: Math.round(S.width - M.width), left: Math.round(M.left - S.left) };
    });

    if (!panes || !panes.twoPane) { note(what + ': the two-pane layout did not engage; nothing measured'); await ctx.close(); continue; }

    check('on ' + what + ' the category strip keeps out of the live order',
          panes.gap > 0, 'it runs ' + (-panes.gap) + 'px into the pane the cashier reads the bill from');
    check('and stays inside its own column there',
          panes.widerThanPane <= 0 && panes.left >= 0,
          panes.widerThanPane + 'px wider than the menu column, overhanging its left by ' + panes.left + 'px');
    await ctx.close();
  }
  note('full bleed across one column is full bleed across the next one too');

  // ---------------------------------------------------------------- under the notch
  //
  // With viewport-fit=cover the page owns the strip of screen behind the clock, and the
  // till's sticky category strip is pinned BELOW it, at env(safe-area-inset-top). So the
  // menu scrolls up through that gap, and something has to be painted over it or the
  // cashier reads a menu row across the top of their status bar.
  //
  // Something was: a fixed band at z-index 950. On the till it painted nothing. A
  // screenshot from an iPhone 13 has a menu row legible across the top 47px — that
  // phone's inset to the pixel — with the strip stuck at 47px directly beneath it. The
  // band was body::before, and the till is the one page whose <body> is a flex
  // container, where ::before generates a flex item that position:fixed then has to
  // take back out of flow. admin.html carries the same rule on an ordinary <body> and
  // nobody has ever reported it.
  //
  // Chromium paints both, so this cannot reproduce that, and the fix shipped as reasoning
  // from one photograph. It was then checked on the iPhone it bled on and the band is
  // clean, so the mechanism is confirmed rather than suspected — which is what makes the
  // source check below a rule and not a precaution. What this part holds is the half that
  // IS checkable here: that the inset is covered, opaquely, above whatever scrolls under
  // it. admin.html is in the loop because it is the page that still uses body::before,
  // and the only reason that is safe is the non-flex <body> the check below watches.
  for (const page of ['pos.html', 'admin.html']) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true });
    await ctx.addInitScript(STUB);
    const pg = await ctx.newPage();
    pg.on('pageerror', e => threw.push(page + '@notch: ' + String(e.message || e).split('\n')[0]));
    await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());

    // A notched phone, asked for from the browser rather than simulated with CSS —
    // overriding the two env() uses by hand would be writing the answer into the test.
    const cdp = await ctx.newCDPSession(pg);
    let insets = true;
    try { await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: INSET, left: 0, bottom: 34, right: 0 } }); }
    catch (e) { insets = false; }

    if (!insets) { note(page + ': this Chromium cannot be given safe-area insets; the notch is unchecked'); await ctx.close(); continue; }

    await pg.goto(base + '/' + page, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(700);
    await pg.evaluate(() => { const o = document.getElementById('login-overlay'); if (o) o.style.display = 'none'; });
    await pg.evaluate(() => window.scrollTo(0, 1400));
    await pg.waitForTimeout(400);

    const inset = await pg.evaluate(() => parseInt(getComputedStyle(document.body).paddingTop) || 0);
    check(page + ' pads its content out of a ' + INSET + 'px notch', inset === INSET, inset + 'px');

    // Read the pixels back. Nothing else can tell the difference between a band that is
    // there and a band that is there but underneath the menu.
    const shot = (await pg.screenshot()).toString('base64');
    const band = await pg.evaluate(async ([b64, h]) => {
      const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
      const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0);
      const d = c.getContext('2d').getImageData(0, 0, c.width, h).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
      return [...seen];
    }, [shot, INSET]);

    check(page + ' paints the notch solid while the page scrolls under it',
          band.length === 1 && band[0] === BRAND,
          band.length + ' colours in the top ' + INSET + 'px: ' + band.slice(0, 4).join(' / '));
    await ctx.close();
  }

  // The part Chromium cannot show us, held as the rule the phone confirmed.
  {
    const bad = [];
    for (const p of PAGES) {
      const src = readPage(p);
      if (!/body::before\s*\{[^}]*position:\s*fixed/.test(src)) continue;
      const body = /\n\s*body\s*\{([^}]*)\}/.exec(src);
      if (body && /display:\s*(inline-)?flex/.test(body[1])) bad.push(p);
    }
    check('no page covers the notch with a pseudo-element of a flex <body>', bad.length === 0,
          bad.join(', ') + ' — the one construct an iPhone was seen not to paint, and seen to paint once it changed');
  }
  note('a band over the notch is the whole of what keeps the menu out of the status bar');
  check('no page threw while any of that ran', threw.length === 0, threw.join(' | '));

  await browser.close();
  server.close();
  done();
})();
