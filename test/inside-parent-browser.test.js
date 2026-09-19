// Does anything on these screens render outside the box that is supposed to hold it?
//
// THE COMPLAINT WAS "ADMIN ELEMENTS ARE BLEEDING", AND IT WAS LITERAL.
// A flex item is `min-width: auto` unless something says otherwise, which means it
// refuses to become narrower than its own content. Every row on these pages is a flex
// row, so a control with a wide enough label — a <select> with "Barista" in it, an
// email beside a ✖ button, "Save Recipe" on a button sharing a line with another —
// simply held its row open and hung over the right-hand edge of the card it lives in.
// The worst of them gave admin.html a horizontal scrollbar at 320px, on a page whose
// forms are how the menu and the staff list get edited.
//
// It is the same defect in a dozen places, so this asks the question once, of every
// element on every page: is your border box inside your parent's content box? A child
// that deliberately hangs out says so with a negative margin — the category strip on
// the till is full-bleed by design — and nothing else is allowed to.
//
// WHY IT NEEDS A BROWSER, AND WHY IT NEEDS DATA
//
// Neither half of this is visible in the source. Whether a row overflows depends on
// the text inside it, the font it is set in and how wide the screen is, and none of
// that is a property of the markup. And most of these rows do not exist until the
// database answers: the account rows, the menu rows, the kitchen tickets and the
// ledger lines are all built by the page from data. A suite that loads these pages
// against an empty stub sees the shell and none of the rows, which is why the shell
// was fine and every row-shaped thing on the page was not. So the stub here answers
// with a café's worth of plausible data, and the check runs on what that draws.
//
// Widths: 320 is not a device so much as a floor — an iPhone SE, and also an ordinary
// phone at 200% browser zoom, which is the person least able to cope with a page that
// slides sideways. 390 and 820 are the phone and the iPad the café actually uses, and
// 1024 is the till in its two-pane layout.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Every page — nothing draws outside the box that holds it');

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

// A café's worth of it. Long names and a long email on purpose: the rows that broke
// broke because of their contents, so contents that are merely plausible would not
// have caught any of this.
const NOW = 1756200000000;
const DATA = {
  menu: {
    Pizza: { 'Margherita': { price: 320, inStock: true, routing: 'chef' },
             'Farmhouse Special': { price: 380, inStock: true, routing: 'chef' },
             'Pepperoni': { price: 420, inStock: false, routing: 'chef' } },
    Sides: { 'Garlic Bread': { price: 140, inStock: true, routing: 'chef' } },
    Coffee: { 'Cappuccino': { hasSizes: true, priceReg: 150, priceLrg: 190, inStock: true,
                              requiresSweetness: true, routing: 'barista' } },
    Dessert: { 'Chocolate Brownie': { price: 180, inStock: true, routing: 'chef' } }
  },
  users: { u1: { name: 'Asha Menon', email: 'asha@ila.cafe', role: 'admin' },
           u2: { name: 'Ravi Kumar', email: 'ravikumar.accounts@ilacafe.example', role: 'cashier' },
           u3: { name: 'Meera Nair', email: 'meera@ila.cafe', role: 'barista' } },
  staff: { s1: 'Asha', s2: 'Ravi', s3: 'Meera' },
  storeStatus: { isOpen: true, delivery: true, takeaway: true },
  status: { isOpen: true, delivery: true, takeaway: true },
  categoryOrder: { 0: 'Pizza', 1: 'Sides', 2: 'Coffee', 3: 'Dessert' },
  addons: { Coffee: { 'Oat Milk': 30 }, Pizza: { 'Extra Cheese': 60 } },
  upiRouting: { r1: { vpa: 'ila@okaxis', label: 'HDFC Savings', cap: 100000, total: 42000 } },
  security: { voids: { v1: { ts: NOW, table: '2', total: 640, by: 'Asha', reason: 'wrong item' } },
              unpaid: { u1: { ts: NOW, table: '6', total: 480, by: 'Ravi' } } },
  ops: { cronHeartbeat: { at: NOW, ok: true }, clientErrors: { e1: { at: NOW, msg: 'x', page: 'pos' } } },
  pos: {
    activeTables: { '1': { items: { 'Margherita': { qty: 1, price: 320, name: 'Margherita' } },
                           status: 'occupied', openedAt: NOW, orderType: 'dinein' } },
    cashDrawer: 4250, upiTotal: 7890, tips: { lastHeads: 3 }, lastSplitHeads: 2,
    bills: { b1: { id: 1, ts: NOW, table: '2', total: 640, method: 'UPI' } },
    eodSummary: { '2026-09-18': { cash: 5400, upi: 8200, total: 13600, bills: 22 } },
    ledgerEntries: { e1: { ts: NOW, table: '2', total: 640, method: 'UPI', staff: 'Ravi', type: 'sale' } }
  },
  orders: {
    active: {
      chef: { o1: { table: '1', createdAt: NOW, quotedAt: NOW, etaMins: 12, trackId: 't1',
                    items: { 'Farmhouse Special': { qty: 3, name: 'Farmhouse Special' } },
                    notes: 'No onion. Nut allergy — please keep separate.' },
              o2: { table: '4', createdAt: NOW, quotedAt: NOW, etaMins: 9, trackId: 't2',
                    items: { 'Margherita': { qty: 1, name: 'Margherita' },
                             'Garlic Bread': { qty: 2, name: 'Garlic Bread' } } } },
      barista: { b1: { table: '3', createdAt: NOW, quotedAt: NOW, etaMins: 5, trackId: 't3',
                       items: { 'Cappuccino (Regular)': { qty: 2, name: 'Cappuccino (Regular)' } } },
                 b2: { table: 'TAKEAWAY', createdAt: NOW, quotedAt: NOW, etaMins: 7, trackId: 't4',
                       items: { 'Cappuccino (Large)': { qty: 1, name: 'Cappuccino (Large)' } },
                       customerName: 'Priyadarshini Venkataraman',
                       notes: 'Oat milk, extra hot, no sugar at all please.' } }
    },
    ready: {}, completed: { chef: {}, barista: {} }, track: {},
    history: { h1: { ts: NOW, id: 1, table: '2', total: 640, method: 'UPI', staff: 'Ravi',
                     items: { 'Farmhouse Special': { qty: 1, price: 380, name: 'Farmhouse Special' } } } }
  },
  eta: { model: { itemBase: { 'Margherita': 8 }, station: { chef: 1, barista: 1 } } },
  inventory: {
    stock: { bar: { raw: { 'Coffee Beans': 12 } }, kitchen: { raw: { 'Pizza Dough': 25 } } },
    config: { items: { bar: { raw: { 'Coffee Beans': { unit: 'kg', par: 20 } },
                              prepped: { 'Cold Brew Concentrate': { unit: 'L', par: 10 } } },
                       kitchen: { raw: { 'Pizza Dough': { unit: 'balls', par: 40 } } } } },
    logs: { l1: { item: 'Coffee Beans', delta: -2, by: 'Meera', ts: NOW } }
  }
};

// The usual stub, except that it answers. Signed in as an admin, because half of what
// is being measured is only drawn for one.
const STUB = `
(() => {
  const DATA = ${JSON.stringify(DATA)};
  const at = (p) => { let n = DATA; for (const k of String(p||'').split('/').filter(Boolean)) { n = (n && typeof n === 'object') ? n[k] : undefined; } return n === undefined ? null : n; };
  const snap = (o, key) => ({ val: () => (o === undefined ? null : o), exists: () => o != null,
    numChildren: () => (o && typeof o === 'object') ? Object.keys(o).length : 0,
    forEach: (f) => { if (o && typeof o === 'object') Object.keys(o).forEach(k => f(snap(o[k], k))); },
    child: (k) => snap(o && o[k], k), hasChild: (k) => !!(o && o[k] != null), key: key || null });
  const mk = (p) => { const s = {
    key: String(p||'').split('/').pop() || 'k', child: (k) => mk(p ? p + '/' + k : k),
    orderByChild: () => s, orderByKey: () => s, orderByValue: () => s,
    limitToLast: () => s, limitToFirst: () => s, startAt: () => s, endAt: () => s, equalTo: () => s,
    // async on purpose: a synchronous callback fires before the page's own top-level
    // declarations exist, which throws on a temporal dead zone and stops the script.
    on: (_e, cb) => { setTimeout(() => { try { if (cb) cb(snap(at(p))); } catch (e) {} }, 0); return cb; },
    off: () => {},
    once: (_e, cb) => { const x = snap(at(p)); if (cb) { try { cb(x); } catch (e) {} } return Promise.resolve(x); },
    get: () => Promise.resolve(snap(at(p))),
    push: () => mk(p), set: () => Promise.resolve(), update: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    onDisconnect: () => ({ set: () => Promise.resolve(), remove: () => Promise.resolve(),
                           cancel: () => Promise.resolve(), update: () => Promise.resolve() }),
    transaction: (_f, cb) => { const x = snap(at(p)); if (cb) cb(null, false, x); return Promise.resolve({ committed: false, snapshot: x }); }
  }; return s; };
  const database = () => ({ ref: (p) => mk(p || ''), goOnline: () => {}, goOffline: () => {} });
  database.ServerValue = { TIMESTAMP: ${NOW}, increment: (n) => ({ '.sv': { increment: n } }) };
  window.firebase = {
    initializeApp: () => ({}), apps: [], database: database,
    auth: () => ({ currentUser: { uid: 'u1', email: 'asha@ila.cafe' },
                   onAuthStateChanged: (cb) => { setTimeout(() => { try { cb({ uid: 'u1', email: 'asha@ila.cafe' }); } catch (e) {} }, 0); return () => {}; },
                   signOut: () => Promise.resolve(),
                   signInWithEmailAndPassword: () => Promise.resolve({ user: { uid: 'u1' } }),
                   signInAnonymously: () => Promise.resolve({ user: { uid: 'a' } }) })
  };
  window.Chart = function () { return { destroy(){}, update(){}, resize(){}, data: { datasets: [] }, options: {} }; };
})();
`;

// Runs in the page. Every laid-out element, against the box that holds it.
const AUDIT = () => {
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const shown = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { cs, r };
  };

  const out = [];
  let examined = 0;
  for (const el of document.querySelectorAll('body *')) {
    const v = shown(el); if (!v) continue;
    examined++;
    const { cs, r } = v;
    // Taken out of flow on purpose: a fixed bar, a positioned overlay and a popup
    // answer to the viewport, not to whatever element happens to contain them.
    if (cs.position === 'absolute' || cs.position === 'fixed') continue;

    const p = el.parentElement;
    if (!p || p === document.body) continue;
    const pv = shown(p); if (!pv) continue;
    // A parent that clips or scrolls has already said what happens at its edge.
    if (pv.cs.overflowX !== 'visible' || pv.cs.display === 'contents') continue;
    // And a child pulled out deliberately says so with a negative margin — the
    // category strip on the till is full-bleed exactly this way.
    const mL = parseFloat(cs.marginLeft) || 0, mR = parseFloat(cs.marginRight) || 0;

    const inL = pv.r.left + (parseFloat(pv.cs.borderLeftWidth) || 0) + (parseFloat(pv.cs.paddingLeft) || 0);
    const inR = pv.r.right - (parseFloat(pv.cs.borderRightWidth) || 0) - (parseFloat(pv.cs.paddingRight) || 0);

    const over = (r.right > inR + 1.5 && mR >= 0) ? Math.round(r.right - inR)
               : (r.left < inL - 1.5 && mL >= 0) ? Math.round(inL - r.left) : 0;
    if (over) {
      out.push(name(el) + ' is ' + over + 'px outside ' + name(p) +
               ' — "' + (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30) + '"');
    }
  }
  // AND THE OTHER AXIS, WHICH HIDES RATHER THAN SPILLS.
  // A box that clips vertically and cannot scroll does not push its content over an
  // edge where somebody would notice — it simply stops drawing it. The split-bill
  // card on the till did exactly that: on a 320x568 screen its head and foot alone
  // came to 580px in 550px of room, so `overflow: hidden` threw the last 30px away
  // and ✖ CANCEL sat at 596 — off the bottom of a modal with no way to close it.
  // So: anything you are meant to press must not be underneath a lid.
  const lidded = [];
  const PRESSABLE = 'button, a[href], input, select, textarea, [role="button"], [tabindex]';
  for (const el of document.querySelectorAll(PRESSABLE)) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const pcs = getComputedStyle(p);
      const clipsY = pcs.overflowY === 'hidden' || pcs.overflowY === 'clip';
      if (!clipsY) continue;
      // Clipping is only a problem when there is something to reach: a box whose
      // content fits has nothing underneath the lid.
      if (p.scrollHeight <= p.clientHeight + 2) continue;
      const pr = p.getBoundingClientRect();
      const inTop = pr.top + (parseFloat(pcs.borderTopWidth) || 0);
      const inBot = pr.bottom - (parseFloat(pcs.borderBottomWidth) || 0);
      // Partly under the lid counts. ✖ CANCEL began 30px above the edge and ended
      // 16px below it, so a test that asked whether the whole control had fallen off
      // would have watched the bug go past: what a cashier sees is half a button.
      if (r.bottom > inBot + 1 || r.top < inTop - 1) {
        lidded.push(name(el) + ' "' + (el.textContent || el.getAttribute('aria-label') || '')
          .trim().replace(/\s+/g, ' ').slice(0, 24) + '" is clipped away by ' + name(p) +
          ' (' + p.scrollHeight + ' of content in ' + p.clientHeight + ', no scroll)');
      }
      break;                                   // the nearest lid is the one that matters
    }
  }

  return { out: [...new Set(out)], lidded: [...new Set(lidded)],
           examined,
           // What the database was supposed to have drawn by now. A page that answered
           // slowly and drew none of its rows passes every check above for the wrong
           // reason, and the rows are the whole point of running this against data.
           rows: document.querySelectorAll('.list-item, .ticket-card, .menu-row, .coffee-row, tbody tr').length,
           wide: document.documentElement.scrollWidth,
           vw: document.documentElement.clientWidth };
};

const PAGES = ['index.html', 'pos.html', 'admin.html', 'analytics.html',
               'barista.html', 'chef.html', 'inventory.html'];
// What each page has to have DRAWN before anything measured on it means something,
// counted as rows the stub's answer is responsible for. The numbers are per page
// because the pages are not alike: admin is a stack of forms and lists, the kitchen
// boards are two tickets each. analytics and inventory are absent on purpose — their
// content comes from shapes this stub does not carry, so they are walked for their
// shell rather than held to a count they were never given the data for.
const ROWS_WANTED = { 'index.html': 5, 'pos.html': 5, 'admin.html': 8,
                      'barista.html': 2, 'chef.html': 2 };
// 320 is the floor, not a device: it is also an ordinary phone at 200% zoom. The
// heights matter as much as the widths for the second half of this: what hid the
// till's CANCEL button was 568px of height, not 320px of width.
const WIDTHS = [[320, 568], [390, 844], [820, 1180], [1024, 768]];

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE) ? { executablePath: PRE } : {});

  const bleeding = [];
  const sideways = [];
  const unreachable = [];
  const empty = [];
  let seen = 0;
  let drew = 0;

  for (const [width, height] of WIDTHS) {
    const ctx = await browser.newContext({ serviceWorkers: 'block',
      viewport: { width, height }, isMobile: width < 900, hasTouch: width < 900 });
    await ctx.addInitScript(STUB);
    for (const page of PAGES) {
      const pg = await ctx.newPage();
      await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
      await pg.goto(base + '/' + page, { waitUntil: 'domcontentloaded' });
      await pg.waitForTimeout(900);
      // Everything behind a fold is still a row that has to fit — admin keeps most of
      // its forms in one, and two of the overflows were in there.
      await pg.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
      await pg.waitForTimeout(300);

      const res = await pg.evaluate(AUDIT);
      drew++;
      seen += res.examined;
      const want = ROWS_WANTED[page];
      if (want && res.rows < want) {
        empty.push(page + ' @' + width + 'x' + height + ': ' + res.rows + ' rows, wanted ' + want);
      }
      for (const line of res.out) bleeding.push(page + ' @' + width + 'x' + height + ': ' + line);
      for (const line of res.lidded) unreachable.push(page + ' @' + width + 'x' + height + ': ' + line);
      if (res.wide > res.vw + 1) {
        sideways.push(page + ' @' + width + 'x' + height + ': scrollWidth ' + res.wide + ' in ' + res.vw);
      }
      await pg.close();
    }
    await ctx.close();
  }

  // COVERAGE FIRST, BECAUSE A PAGE THAT DREW NOTHING PASSES EVERYTHING
  // The rows are the reason this runs against a stub that answers. If one came up
  // empty — a slow answer, a stub that stopped matching what the page reads — every
  // check below it would be clean and would mean nothing.
  check('every page actually drew the rows this is here to measure', empty.length === 0,
        empty.join(', '));
  note(seen + ' laid-out elements examined across ' + drew + ' page loads');

  check('nothing renders outside the element that contains it', bleeding.length === 0,
        bleeding.length + ' overflowing\n         ' + bleeding.slice(0, 24).join('\n         '));
  note('a child that means to hang out says so with a negative margin; these did not');

  check('nothing you are meant to press is clipped away with no way to scroll to it',
        unreachable.length === 0,
        unreachable.length + ' out of reach\n         ' + unreachable.slice(0, 12).join('\n         '));
  note('a box that clips vertically does not spill over an edge — it stops drawing,');
  note('which is how a modal came to hide its own CANCEL button on a short screen');

  check('and no page scrolls sideways at any width it is used at', sideways.length === 0,
        sideways.join('\n         '));
  note(WIDTHS.map(w => w.join('x')).join(', ') + ' — 320 wide is also an ordinary phone at 200% zoom');
  note(drew + ' page loads, against a stub that answers: the rows that broke are');
  note('drawn from data, so an empty database draws none of them');

  await browser.close();
  server.close();
  done();
})();
