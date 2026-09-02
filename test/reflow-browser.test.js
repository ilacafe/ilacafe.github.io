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
const MENU = {
  Coffee: {
    'Latte': { hasSizes: true, priceReg: 170, priceLrg: 210, inStock: true },
    'Cortado with an extremely long name': { hasSizes: true, priceReg: 190, priceLrg: 230, inStock: true },
    'Cold Brew': { price: 220, inStock: false }
  },
  Food: { 'Avocado Toast with Poached Eggs': { price: 340, inStock: true } }
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
  check('no page threw while any of that ran', threw.length === 0, threw.join(' | '));

  await browser.close();
  server.close();
  done();
})();
