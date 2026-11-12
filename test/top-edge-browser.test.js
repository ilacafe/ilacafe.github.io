// Nothing that has to be read sits in iOS 26's blur.
//
// Reported from the counter four times, in four sets of words: the category header
// "fading", then "fading" again, then a screenshot of it soft and blurred, and then
// "the category header is getting blurred" — after the fix for the third had shipped.
//
// The first two were real and were something else (the mark on the chip going out).
// The third was this, and its fix was right and reached nobody. iOS 26 draws a blur of
// its own over the top of an installed web app that runs under the status bar: across
// the status bar and fading out 32 to 40pt below it, depending on who measured. The
// till's category strip is pinned exactly there. Removing the black-translucent status bar style stops the page
// running under the status bar — but iOS reads that tag when the app is ADDED to the
// Home Screen, so it changed nothing on any till that was already installed, which
// was all of them.
//
// So the page stopped waiting to be reinstalled. Inside an iOS home-screen app whose
// page is under the status bar, everything that has to be read starts below the blur
// (--top-edge), and the band that covers the status bar runs down to meet it.
//
// WHAT THIS CAN AND CANNOT SHOW. No browser on this machine draws that blur — not
// Chromium, and by every account not Playwright's WebKit or the simulator either — so
// "the strip is sharp" is not a thing a suite here can see. What it can hold is the
// geometry the fix consists of, in the three situations a page can be in:
//
//   an old install      iOS app, page under the status bar: the gap is there, the
//                       band is solid across it, and no category name is inside the
//                       blur's reach
//   a new install       iOS app, opaque status bar, inset 0: no gap, nothing wasted
//   a browser tab       not an app at all: nothing moves, whatever the inset
//
// and the one condition WebKit's own source gives for not drawing the blur at all:
// that the top edge hit-tests to a fixed, full-width box with a plain colour.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, readPage, suite } = require('./helpers');

const { check, note, done } = suite('The top of the page — clear of iOS 26’s blur');

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

// The café's own categories, and enough rows under each to scroll: a strip that never
// has to stick has nothing to say about where it sticks.
const rows = (prefix, n, price) => {
  const o = {};
  for (let i = 1; i <= n; i++) o[prefix + ' ' + i] = { price: price + i * 10, inStock: true };
  return o;
};
const MENU = {
  Pizza: rows('Pizza', 9, 200), Sides: rows('Side', 8, 120), Coffee: rows('Coffee', 9, 150),
  Beverages: rows('Drink', 8, 140), Dessert: rows('Dessert', 8, 180)
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
// navigator.standalone is iOS's own word for "opened from the Home Screen". It exists
// nowhere else, so here it is said for the page.
const IOS_APP = `Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true });`;

const BRAND = '141,110,82';
// How far below the status bar iOS 26's blur reaches before it has faded out. The
// projects that hit this first measured it off devices and came back with anything
// from 32 to "about 40"; nothing documents it. The fix is sized to the larger, and
// this is the number to raise if a till ever shows a soft strip again.
const BLUR_REACH = 40;

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE) ? { executablePath: PRE } : {});
  const threw = [];
  let canInset = true;

  // One page, in one of the situations above.
  async function open(page, { width, height, inset, app }) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height }, hasTouch: true });
    await ctx.addInitScript(STUB);
    if (app) await ctx.addInitScript(IOS_APP);
    const pg = await ctx.newPage();
    pg.on('pageerror', e => threw.push(page + ': ' + String(e.message || e).split('\n')[0]));
    await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    // The inset is asked for from the browser, not written into the page's CSS:
    // overriding env() by hand would be writing the answer into the test.
    if (inset) {
      const cdp = await ctx.newCDPSession(pg);
      try { await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: inset, left: 0, bottom: 0, right: 0 } }); }
      catch (e) { canInset = false; }
    }
    await pg.goto(base + '/' + page, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(700);
    await pg.evaluate(() => { const o = document.getElementById('login-overlay'); if (o) o.style.display = 'none'; });
    return { ctx, pg };
  }
  const padTop = (pg) => pg.evaluate(() => parseFloat(getComputedStyle(document.body).paddingTop) || 0);

  // What the till has at its top once the menu is scrolled and the strip has stuck.
  async function tillTop(pg, bandHeight) {
    await pg.evaluate(() => window.scrollTo(0, 1500));
    await pg.waitForTimeout(400);
    const geo = await pg.evaluate(() => {
      const strip = document.getElementById('cat-strip');
      const chips = [...document.querySelectorAll('.cat-chip')];
      // where the GLYPHS start, not where the button's box does
      const textTop = Math.min(...chips.map(c => {
        const r = document.createRange(); r.selectNodeContents(c);
        return r.getBoundingClientRect().top;
      }));
      const rail = document.getElementById('side-rail');
      const cover = document.querySelector('.notch-cover');
      const railShown = rail && getComputedStyle(rail).display !== 'none';
      return {
        chips: chips.length,
        stripTop: strip.getBoundingClientRect().top,
        textTop: textTop,
        coverHeight: cover.getBoundingClientRect().height,
        railTop: railShown ? rail.getBoundingClientRect().top : null,
        scrolled: window.scrollY
      };
    });
    let band = null;
    if (bandHeight > 0) {
      const shot = (await pg.screenshot()).toString('base64');
      band = await pg.evaluate(async ([b64, h]) => {
        const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
        const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
        c.getContext('2d').drawImage(im, 0, 0);
        const d = c.getContext('2d').getImageData(0, 0, c.width, h).data;
        const seen = new Set();
        for (let i = 0; i < d.length; i += 4) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
        return [...seen];
      }, [shot, bandHeight]);
    }
    return Object.assign(geo, { band });
  }

  try {
    // ===================================================== the till, as it is installed
    //
    // An iPad in landscape, which is what the tills are, opened from a Home Screen icon
    // added while the page still asked for a translucent status bar. Its inset is the
    // height of the status bar.
    {
      const INSET = 24;
      const { ctx, pg } = await open('pos.html', { width: 1180, height: 820, inset: INSET, app: true });
      if (!canInset) {
        note('this Chromium cannot be given safe-area insets, so none of this can be asked');
      } else {
        const pad = await padTop(pg);
        const gap = pad - INSET;
        check('an installed till under the status bar starts its page below the blur, not at the status bar',
              gap >= 24, 'content starts ' + gap + 'px below a ' + INSET + 'px status bar');

        const top = await tillTop(pg, pad);
        check('(the strip is on screen and stuck)', top.chips === 5 && top.scrolled > 400, JSON.stringify({ chips: top.chips, scrolled: top.scrolled }));
        check('the category strip sticks at the bottom of that gap, not up against the status bar',
              Math.abs(top.stripTop - pad) < 1, 'strip at ' + top.stripTop + 'px, gap ends at ' + pad + 'px');
        check('and no category name is within the blur’s reach',
              top.textTop - INSET >= BLUR_REACH,
              'the names start ' + (top.textTop - INSET).toFixed(1) + 'px below the status bar; the blur reaches ' + BLUR_REACH);
        note('they started 11px below it: every one of them inside the fade');
        check('the band over the status bar runs down to the strip, so the blur falls on flat colour',
              Math.abs(top.coverHeight - pad) < 1 && top.band && top.band.length === 1 && top.band[0] === BRAND,
              'band ' + top.coverHeight + 'px; ' + (top.band ? top.band.length + ' colour(s) in the top ' + pad + 'px: ' + top.band.slice(0, 3).join(' / ') : 'unread'));
        check('and the live order beside it is pinned below the same line',
              top.railTop !== null && top.railTop >= pad, 'CURRENT ORDER at ' + top.railTop + 'px');
        note('it was pinned at a bare 16px: under a 24px status bar, behind the clock');

        // WebKit's own rule for NOT drawing the blur (LocalFrameView::fixedContainerEdges,
        // as the projects that read it describe it): hit-test 4px below the middle of the
        // top edge; from what is hit, walk up to a fixed or sticky box at least 90% of
        // the viewport wide and no taller than it; take a plain background-colour off a
        // box more than 10px tall on the way; a backdrop-filter anywhere makes it glass.
        const edge = await pg.evaluate(() => {
          let el = document.elementFromPoint(window.innerWidth / 2, 4);
          const hit = el ? (el.className || el.id || el.tagName) : null;
          let glass = false, colour = null, box = null;
          for (; el && el !== document.documentElement; el = el.parentElement) {
            const cs = getComputedStyle(el), r = el.getBoundingClientRect();
            if ((cs.backdropFilter && cs.backdropFilter !== 'none') || (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== 'none')) glass = true;
            if (!colour && r.height > 10 && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundImage === 'none') colour = cs.backgroundColor;
            if (cs.position === 'fixed' || cs.position === 'sticky') {
              box = { position: cs.position, wide: r.width >= window.innerWidth * 0.9, short: r.height <= window.innerHeight * 1.05 };
              break;
            }
          }
          return { hit: String(hit), glass, colour, box };
        });
        check('the top edge hit-tests to a fixed, full-width box with a plain colour — the box WebKit looks for',
              !!edge.box && edge.box.position === 'fixed' && edge.box.wide && edge.box.short && !!edge.colour && !edge.glass,
              JSON.stringify(edge));
        note('it carried pointer-events: none, which is a box a hit test does not find');

        // And the two things that speak from the top of the screen.
        await pg.evaluate(() => {
          window.ilaToast('Table 5 has been settled');
          window.showToast('NOT RECORDED', 'a sentence somebody has to read', 0);
        });
        await pg.waitForTimeout(700);                  // both slide in; measure them at rest
        const said = await pg.evaluate(() => {
          const tops = [...document.querySelectorAll('#notification-area .toast-card')].map(t => t.getBoundingClientRect().top);
          const hosts = [...document.body.children].filter(n => n.style && n.style.position === 'fixed' && /translateX/.test(n.style.transform) && n.id !== 'notification-area');
          hosts.forEach(h => tops.push(h.getBoundingClientRect().top));
          return tops;
        });
        check('a toast is not put in the blur either',
              said.length >= 2 && said.every(t => t - INSET >= BLUR_REACH), said.map(t => (t - INSET).toFixed(0) + 'px below the status bar').join(', '));
      }
      await ctx.close();
    }

    // ============================================================ the same till, on a phone
    if (canInset) {
      const INSET = 47;
      const { ctx, pg } = await open('pos.html', { width: 390, height: 844, inset: INSET, app: true });
      const pad = await padTop(pg);
      const top = await tillTop(pg, pad);
      check('on a phone installed the same way, the names clear the blur too',
            top.chips === 5 && top.textTop - INSET >= BLUR_REACH && top.band && top.band.length === 1 && top.band[0] === BRAND,
            'names ' + (top.textTop - INSET).toFixed(1) + 'px below the status bar; band ' + (top.band ? top.band.length : '?') + ' colour(s)');
      await ctx.close();
    }

    // ============================================= an app added since the status bar went opaque
    //
    // The page starts below the status bar, there is nothing above it to blur, and the
    // inset is 0. A gap here would be 36px of the cashier's menu spent on nothing.
    {
      const { ctx, pg } = await open('pos.html', { width: 1180, height: 820, inset: 0, app: true });
      const pad = await padTop(pg);
      const top = await tillTop(pg, 0);
      check('an app whose page starts below an opaque status bar gets no gap at all',
            pad === 0 && Math.abs(top.stripTop) < 1 && top.coverHeight === 0,
            'padding ' + pad + 'px, strip at ' + top.stripTop + 'px, band ' + top.coverHeight + 'px');
      await ctx.close();
    }

    // ================================================================== and a browser tab
    if (canInset) {
      const INSET = 47;
      const { ctx, pg } = await open('pos.html', { width: 390, height: 844, inset: INSET, app: false });
      const pad = await padTop(pg);
      const top = await tillTop(pg, pad);
      check('a browser tab is exactly where it was: the inset, and nothing added to it',
            pad === INSET && Math.abs(top.stripTop - INSET) < 1, 'padding ' + pad + 'px for a ' + INSET + 'px inset, strip at ' + top.stripTop + 'px');
      await ctx.close();
    }

    // ================================================ the other two that ran under the status bar
    //
    // admin.html and the ordering page asked for the same translucent status bar, so an
    // old install of either has the same blur over its first heading.
    if (canInset) {
      const INSET = 47;
      for (const page of ['admin.html', 'index.html']) {
        const a = await open(page, { width: 390, height: 844, inset: INSET, app: true });
        const padApp = await padTop(a.pg);
        await a.ctx.close();
        const b = await open(page, { width: 390, height: 844, inset: INSET, app: false });
        const padTab = await padTop(b.pg);
        await b.ctx.close();
        check(page + ' starts below the blur in an installed app, and where it always did in a tab',
              padApp - INSET >= 24 && padTab === INSET, 'app: ' + padApp + 'px, tab: ' + padTab + 'px, inset ' + INSET);
      }
    }

    // ========================================================================== the source
    //
    // What Chromium cannot be made to evaluate: the no-script copy of the rule, which
    // only iOS WebKit matches. It has to exist, and it has to say the same thing.
    {
      const missing = [];
      for (const page of ['pos.html', 'admin.html', 'index.html']) {
        const src = readPage(page);
        const cls = /html\.ios-app\s*\{\s*--blur-clear:\s*([^;]+);/.exec(src);
        const sup = /@supports \(-webkit-touch-callout: none\)\s*\{\s*@media \(display-mode: standalone\), \(display-mode: fullscreen\)\s*\{\s*:root\s*\{\s*--blur-clear:\s*([^;]+);/.exec(src);
        if (!cls || !sup || cls[1].trim() !== sup[1].trim()) missing.push(page);
        if (!/navigator\.standalone === true\) document\.documentElement\.classList\.add\('ios-app'\)/.test(src.slice(0, src.indexOf('</head>')))) missing.push(page + ' (no head script)');
      }
      check('each of the three says so twice — from a script before first paint, and with no script at all',
            missing.length === 0, missing.join(', '));

      // The strip and the band must both hang off the one variable, or they part company.
      const pos = readPage('pos.html');
      const strip = /\.cat-strip\s*\{[^}]*top:\s*([^;]+);/.exec(pos);
      const cover = /\.notch-cover\s*\{([^}]*)\}/.exec(pos);
      check('the strip and the band over the status bar are positioned off the same line',
            !!strip && strip[1].trim() === 'var(--top-edge)' && !!cover && /height:\s*var\(--top-edge\)/.test(cover[1]),
            (strip ? strip[1] : 'no strip rule') + ' / ' + (cover ? cover[1].replace(/\s+/g, ' ').trim() : 'no band rule'));
      check('and the band takes hits', !!cover && !/pointer-events:\s*none/.test(cover[1]), cover ? cover[1].replace(/\s+/g, ' ').trim() : '');
    }

    check('no page threw while any of that ran', threw.length === 0, threw.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.close();
  }
  done();
})().catch(e => { console.error(e); process.exit(1); });
