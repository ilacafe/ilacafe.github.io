// Can the text actually be read, on the brown these pages are made of?
//
// THE PALETTE HAS NO HEADROOM. Pure white on #8D6E52 measures 4.68:1. WCAG AA asks
// 4.5 for body text. That is 0.18 of margin — so on this background there is no such
// thing as legible dimmed text:
//
//   white @ 1.0   4.68  passes
//   white @ 0.8   3.65  fails
//   white @ 0.7   3.19  fails
//   white @ 0.6   2.77  fails body AND large
//   white @ 0.5   2.39  fails body AND large
//
// The pages used opacity as their only device for hierarchy — 226 declarations of it
// — so every label, every empty state and every table header was below the line. A
// browser audit found 47 distinct failing text styles across the seven pages: "No
// Orders" on the kitchen board at 2.39:1, every KPI label on analytics at 2.77:1,
// and the sign-in error at 3.36:1, which is the one line on that screen that has to
// be read.
//
// The brand brown does not change. So hierarchy is size, weight and letter-spacing
// now, and anything that genuinely has to recede sits on a darkened chip — which
// lowers the background under it and buys back the contrast that dimming spent.
//
// WHY A BROWSER AND NOT THE FILE. Contrast is a question about what is painted:
// inherited opacity multiplies down the tree, a transparent background inherits from
// an ancestor, and rgba colours blend. None of that is visible in the source. This
// walks every element that has its own text and asks the browser what the colours
// resolved to.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Every page — text you can actually read on the brand brown');

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
    auth: () => ({ currentUser: { uid: 'u1' },
                   onAuthStateChanged: (cb) => { setTimeout(() => { try { cb({ uid: 'u1' }); } catch (e) {} }, 0); return () => {}; },
                   signOut: () => Promise.resolve(),
                   signInWithEmailAndPassword: () => Promise.resolve({ user: { uid: 'u1' } }),
                   signInAnonymously: () => Promise.resolve({ user: { uid: 'a' } }) })
  };
  window.Chart = function () { return { destroy(){}, update(){}, data:{datasets:[]}, options:{} }; };
})();
`;

// Runs in the page. Returns every element whose own text is below its threshold.
const AUDIT = () => {
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return null;
    const p = m[1].split(',').map(s => parseFloat(s.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const blend = (fg, bg, a) => ({ r: fg.r * a + bg.r * (1 - a),
                                  g: fg.g * a + bg.g * (1 - a),
                                  b: fg.b * a + bg.b * (1 - a) });
  const ratio = (a, b) => { const hi = Math.max(a, b), lo = Math.min(a, b); return (hi + 0.05) / (lo + 0.05); };

  // WHAT IS ACTUALLY PAINTED BEHIND THIS TEXT
  //
  // Not "the first opaque ancestor". A chip is a SEMI-transparent dark box, and
  // stopping at opaque backgrounds walks straight past it to the brown underneath —
  // which reports the chip as doing nothing and marks the fix as still broken. That
  // is exactly what the first version of this suite did to its own fixes.
  //
  // So every layer is composited, outermost first, each one blended at its own
  // alpha times the opacity accumulated down to it. `opacity` is a group operation:
  // it applies to a node's whole subtree, so it has to be carried down rather than
  // read off the element alone.
  const painted = (el) => {
    const chain = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) chain.push(n);
    chain.reverse();

    let bg = { r: 255, g: 255, b: 255 };     // the canvas
    let cum = 1;
    for (const node of chain) {
      const cs = getComputedStyle(node);
      cum *= parseFloat(cs.opacity);
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) bg = blend(c, bg, Math.min(c.a * cum, 1));
    }
    return { bg, cum };
  };

  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim();
    if (!own) continue;

    // WCAG 1.4.3 exempts these, and each is exempt for a reason that holds here:
    // a disabled control is not something anyone is being asked to read, and
    // aria-hidden text is decoration the page has already declared as such.
    if (el.closest('[disabled]') || el.closest('[aria-hidden="true"]')) continue;

    // And the build stamp, which is not content: a version string nobody reads in
    // the course of using the page, looked up maybe twice a year. Quiet in the
    // corner is what it owes a customer reading a menu. The exemption is not free —
    // the check below requires the stamp to come up to full white when it is
    // touched, hovered or tabbed to, so looking it up still answers the question.
    if (el.closest('.build-stamp')) continue;

    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (!el.getClientRects().length) continue;

    const fg = parse(cs.color);
    if (!fg) continue;
    const { bg, cum } = painted(el);
    const a = cum * fg.a;
    if (a <= 0.02) continue;                    // painted to nothing on purpose

    const r = ratio(L(blend(fg, bg, Math.min(a, 1))), L(bg));
    const px = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    // AA: 3.0 for large text (24px, or 18.66px bold), 4.5 for everything else.
    const need = (px >= 24 || (bold && px >= 18.66)) ? 3 : 4.5;
    if (r < need) {
      const sel = el.tagName.toLowerCase() +
                  (el.id ? '#' + el.id : '') +
                  (typeof el.className === 'string' && el.className.trim()
                     ? '.' + el.className.trim().split(/\s+/).join('.') : '');
      out.push({ sel, text: own.slice(0, 40), ratio: +r.toFixed(2), need, px: +px.toFixed(1), alpha: +a.toFixed(2) });
    }
  }
  return out;
};

const PAGES = ['index.html', 'pos.html', 'admin.html', 'analytics.html',
               'barista.html', 'chef.html', 'inventory.html'];

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE) ? { executablePath: PRE } : {});
  const threw = [];
  let checked = 0;

  for (const page of PAGES) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1024, height: 900 } });
    await ctx.addInitScript(STUB);
    const pg = await ctx.newPage();
    pg.on('pageerror', e => threw.push(page + ': ' + String(e.message || e).split('\n')[0]));
    await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await pg.goto(base + '/' + page, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(600);

    // The sign-in box lives in a <template> so iOS cannot find the password field on
    // a till already signed in. Its error line is the one text on that screen that
    // must be read, so it is cloned in and audited with the rest.
    await pg.evaluate(() => {
      const tpl = document.getElementById('login-box-template');
      const ov = document.getElementById('login-overlay');
      if (!tpl || !ov) return;
      ov.classList.remove('hidden');
      ov.appendChild(tpl.content.cloneNode(true));
      const err = document.getElementById('login-error');
      if (err) err.textContent = 'This account has no staff access.';
    });

    const bad = await pg.evaluate(AUDIT);
    const seen = new Map();
    for (const b of bad) if (!seen.has(b.sel)) seen.set(b.sel, b);
    const list = [...seen.values()].sort((a, b) => a.ratio - b.ratio);
    checked++;

    const detail = list.map(x => x.ratio + ':1 (needs ' + x.need + ') ' + x.sel + ' "' + x.text + '"').join('\n         ');
    check(page + ' — every text style meets AA on the brand brown', list.length === 0,
          list.length + ' below the line\n         ' + detail);

    await ctx.close();
  }

  // ------------------------------------------- the one exemption, and its condition
  // A build stamp may be faint only because looking at it stops being faint. If that
  // ever quietly becomes "faint, full stop", this is what says so.
  {
    const bad = [];
    let stamped = 0;
    for (const page of PAGES) {
      const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
      // Not every page shows one — the stock tablet carries no build of its own, and
      // build-freshness.test.js is what holds that side of it. This only asks about
      // the pages that do show one.
      if (!/class="[^"]*\bbuild-stamp\b/.test(src)) continue;
      stamped++;
      const lit = /\.build-stamp:(?:hover|focus|active)[^{,]*(?:,[^{]*)?\{[^}]*opacity:\s*1/.test(src);
      if (!lit) bad.push(page + ': the stamp never comes up to full opacity');
    }
    check('the build stamp is faint only because looking at it is not',
          bad.length === 0 && stamped > 0,
          stamped === 0 ? 'no page shows a build stamp at all' : bad.join(', '));
    note(stamped + ' pages show one');
    note('exempt from contrast, on the condition that hover, focus or touch answers');
  }

  // ------------------------------------------------ what the browser cannot reach
  // The walk above only sees what is on screen when the page loads against a stubbed,
  // empty database. Most of these pages build their real content from data — ledger
  // rows, tickets, log lines, bill receipts — and every one of those was dimmed the
  // same way. None of it renders here, so none of it can be measured here.
  //
  // What CAN be said without data is the rule that made all of it fail: on this
  // background there is no legible dimmed white, so an opacity anywhere in the range
  // where text is still visible but no longer readable is a bug wherever it appears.
  // A press is the exception — :active and :hover last a moment and nobody reads
  // during one — and so is the footer's separator glyph, which is marked aria-hidden.
  {
    const RULE = /^\s*([^{}\n]+)\{([^{}\n]*)\}\s*$/;
    const OPACITY = /opacity:\s*(0\.\d+)/g;
    const ALLOWED = /:active|:hover|\.footer-divider/;

    const offenders = [];
    for (const page of PAGES) {
      const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
      for (const line of src.split('\n')) {
        const m = RULE.exec(line);
        const inStyleAttr = /style\s*=/.test(line);
        if (!m && !inStyleAttr) continue;
        if (m && ALLOWED.test(m[1])) continue;
        for (const o of line.matchAll(OPACITY)) {
          const v = parseFloat(o[1]);
          // Below 0.3 is something deliberately painted to almost nothing; above
          // 0.95 changes nothing. Between them is text you can see and cannot read.
          if (v >= 0.3 && v <= 0.95) {
            offenders.push(page + ': ' + line.trim().slice(0, 90));
            break;
          }
        }
      }
    }
    check('and nothing anywhere still dims text into the unreadable band',
          offenders.length === 0,
          offenders.length + ' left\n         ' + offenders.join('\n         '));
    note('the rows built from data never render here — this is how they are held to it');
  }

  note('4.5:1 for body text, 3:1 for large (24px, or 18.66px bold) — WCAG 2.1 AA');
  note('white on #8D6E52 is 4.68:1, so dimming white is never an option here:');
  note('hierarchy is size, weight and letter-spacing, and what must recede gets a chip');

  check('no page threw while any of that ran', threw.length === 0, threw.join(' | '));
  note(checked + ' pages walked, every element carrying its own text');

  await browser.close();
  server.close();
  done();
})();
