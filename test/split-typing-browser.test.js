// Typing a share into a split line.
//
// Reported from the counter: on the split screen, click into an item's amount box, type
// one digit, and the cursor is gone.
//
// Every keystroke went through setLineAmount, which ended in renderSplit(), and
// renderSplit rebuilds the whole item list by assigning to innerHTML. The <input> being
// typed into is one of the nodes that assignment replaces — so the first keystroke
// destroyed the element under the cursor and put a fresh one in its place. Focus went
// with it, to <body>. A share of ₹150 could not be entered at all: you got the 1, and
// then the keyboard was typing into nothing.
//
// The box below the list already knew half of this. setSplitOther passes skipOtherField
// so renderSplit does not rewrite the value under the cursor — the same bug, caught once,
// on the one field where a flag was enough. The lines needed the stronger form, because
// they are not merely rewritten, they are replaced.
//
// This has to be a browser test twice over. What broke is document.activeElement, which
// only a real browser has; and the fix is invisible to a source scan, which can see that
// renderSplit was split in two without ever finding out whether a second keystroke lands.
// So it types the way a cashier types — key by key, through the page's own handlers — and
// then asks what the till would actually charge.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Split by item — typing a share into a line');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
                '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not here');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

// A table of four sharing a pizza and some coffees. The name carries an apostrophe and a
// bracket on purpose: a line is addressed by whatever the split screen uses to identify
// it, and a café sells "Nonna's Pizza (Large)".
const PIZZA = "Nonna's Pizza (Large)";
const TABLE = {
  total: 1180, paid: 0,
  items: {
    [PIZZA]:       { qty: 1, price: 600 },
    'Filter Coffee': { qty: 4, price: 120 },
    'Brownie':       { qty: 1, price: 100 }
  },
  shares: { count: 4, paid: 0 }
};

const STUB = `
(() => {
  const snapOf = (v) => ({ key: null, val: () => (v === undefined ? null : v),
    exists: () => v != null, numChildren: () => 0, hasChild: () => false,
    child: () => snapOf(null), forEach: () => {} });
  const mkRef = (p) => { const self = {
    key: p.split('/').filter(Boolean).pop() || null,
    child: (c) => mkRef(p + '/' + c),
    orderByChild: () => self, orderByKey: () => self, limitToLast: () => self,
    limitToFirst: () => self, startAt: () => self, endAt: () => self, equalTo: () => self,
    on: (e, cb) => { if (cb && (!e || e === 'value')) setTimeout(() => cb(snapOf(null)), 0); return cb; },
    off: () => {},
    once: (_e, cb) => { const s = snapOf(null); if (cb) cb(s); return Promise.resolve(s); },
    push: () => mkRef(p + '/-Nstub'), set: () => Promise.resolve(),
    update: () => Promise.resolve(), remove: () => Promise.resolve(),
    transaction: (_f, cb) => { const s = snapOf(null); if (cb) cb(null, false, s); return Promise.resolve({ committed: false, snapshot: s }); }
  }; return self; };
  const db = { ref: (p) => mkRef(String(p == null ? '' : p).replace(/^\\/+|\\/+$/g, '')),
               goOnline: () => {}, goOffline: () => {} };
  const database = () => db;
  database.ServerValue = { TIMESTAMP: Date.now(), increment: (n) => ({ '.sv': { increment: n } }) };
  window.firebase = {
    initializeApp: () => ({}), apps: [], database: database,
    auth: () => ({ onAuthStateChanged: () => {}, signOut: () => Promise.resolve(),
                   currentUser: { uid: 'u1', getIdToken: () => Promise.resolve('t') } })
  };
})();
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const pageErrors = [];

  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 820, height: 1100 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(String(e.message || e).split('\n')[0]));
  await page.addInitScript(STUB);
  await page.route('**/*', route =>
    route.request().url().startsWith(base) ? route.continue() : route.abort());

  // The split screen, standing on the real table it settles.
  const openSplit = async () => {
    await page.goto(base + '/pos.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    await page.evaluate((t) => {
      window.activeTables = { '7': JSON.parse(JSON.stringify(t)) };
      window.checkoutTableID = '7';
      window.pastBills = []; window.salesLedger = [];
      window.openSplitBill();
    }, TABLE);
    await page.waitForTimeout(200);
  };

  // The controls are found the way a cashier finds them — by the name printed on the
  // line — rather than through anything this change introduced. A helper that needs the
  // fix in order to locate the box could only ever report that the fix is present, and
  // this suite has to be able to run against the code that has the bug in it.
  const lineFor  = (name) => page.locator('.split-line').filter({ hasText: name });
  const boxFor   = (name) => lineFor(name).locator('.split-amt');
  const chipsFor = (name) => lineFor(name).locator('.split-chip');
  const litChips = async (name) => chipsFor(name).evaluateAll(
    (bs) => bs.filter(b => b.classList.contains('selected')).map(b => b.textContent.trim()));
  const whereFocusIs = () => page.evaluate(() => {
    const a = document.activeElement;
    if (!a) return 'nothing';
    return a.tagName.toLowerCase() + (a.className ? '.' + String(a.className).split(' ')[0] : '');
  });

  try {
    await openSplit();

    // ------------------------------------------------- the report, key by key
    {
      check('the pizza line has a box to type a share into',
            await boxFor(PIZZA).count() === 1,
            await boxFor(PIZZA).count() + ' box(es) — has the split screen changed shape?');

      await boxFor(PIZZA).click();
      check('clicking it puts the cursor in it',
            await boxFor(PIZZA).evaluate(el => document.activeElement === el) === true);

      // One digit, the way it was reported from the counter.
      await page.keyboard.type('1');
      await page.waitForTimeout(80);
      const focused = await boxFor(PIZZA).evaluate(el => document.activeElement === el);
      check('after one digit the cursor is still in the same box', focused === true,
            'focus is on ' + (await whereFocusIs()) + ' — the box being typed into was replaced');
      note('innerHTML on the list rebuilds every line, and focus goes with the old element');

      // The rest of ₹150, which is the whole point of the screen.
      await page.keyboard.type('50');
      await page.waitForTimeout(120);
      const typed = await page.evaluate((nm) => ({
        allocated: window.splitSel[nm],
        share: document.getElementById('split-share-total').textContent
      }), PIZZA);
      const box = await boxFor(PIZZA).inputValue();
      check('so a three-digit share can be typed at all', box === '150',
            'the box holds ' + JSON.stringify(box));
      check('and the till allocated what the box says', Number(typed.allocated) === 150,
            'splitSel = ' + JSON.stringify(typed.allocated));
      check('and the running share total moved with it', typed.share === '150',
            'share total reads ' + JSON.stringify(typed.share));
      note('₹150 towards a ₹600 pizza is the ordinary case this screen exists for');
    }

    // ------------------------------------------- a second line, still typable
    {
      await boxFor('Filter Coffee').click();
      await page.keyboard.type('240');
      await page.waitForTimeout(120);
      const focused = await boxFor('Filter Coffee').evaluate(el => document.activeElement === el);
      const r = await page.evaluate(() => ({
        coffee: window.splitSel['Filter Coffee'],
        share: document.getElementById('split-share-total').textContent,
        note: document.getElementById('split-alloc-note').textContent
      }));
      check('a second line takes a figure too, with the cursor still in it', focused === true,
            'focus is on ' + (await whereFocusIs()));
      check('and both allocations stand together', Number(r.coffee) === 240 && r.share === '390',
            JSON.stringify({ coffee: r.coffee, share: r.share }));
      check('and the "Covers:" line names both', /Nonna/.test(r.note) && /Filter Coffee/.test(r.note),
            r.note);
      note('two people paying towards different things is what the screen is for');
    }

    // ------------------------------------- a figure larger than the line has left
    //
    // The box may not hold more than is owed on that line. It has to SAY the figure that
    // will be charged rather than a larger one the clamp quietly discarded — and saying it
    // means writing into the element, which is only safe because it is still there.
    {
      await openSplit();
      await boxFor('Brownie').click();                     // ₹100 on the line
      await page.keyboard.type('500');
      await page.waitForTimeout(120);
      const box = await boxFor('Brownie').inputValue();
      const r = await page.evaluate(() => ({
        alloc: window.splitSel['Brownie'],
        share: document.getElementById('split-share-total').textContent
      }));
      check('a figure over what the line owes is held down to it', Number(r.alloc) === 100,
            'allocated ' + JSON.stringify(r.alloc) + ' against a ₹100 line');
      check('and the box says the figure that will be charged', box === '100',
            'the box reads ' + JSON.stringify(box) + ' while ₹' + r.alloc + ' would be taken');
      check('as does the running total', r.share === '100', r.share);
    }

    // ------------------------------------------------ the chips still tell the truth
    //
    // A chip is lit when the box holds the amount that chip would put there. Typing that
    // amount by hand has to light it, and typing away from it has to put it out — a lit ½
    // over a box that no longer says half is the screen lying about what is being charged.
    {
      await openSplit();
      await boxFor(PIZZA).click();                         // ₹600, so ½ is ₹300
      await page.keyboard.type('300');
      await page.waitForTimeout(120);
      const lit = await litChips(PIZZA);
      check('typing half a line by hand lights the ½ chip', lit.join(',') === '½',
            'lit: ' + (lit.join(',') || 'none'));

      await page.keyboard.press('Backspace');              // 300 -> 30
      await page.waitForTimeout(120);
      const still = await litChips(PIZZA);
      const alloc = await page.evaluate((nm) => window.splitSel[nm], PIZZA);
      check('and editing away from it puts the chip out again', still.length === 0,
            still.join(',') + ' still lit at ₹' + alloc);
      check('with the allocation following the box', Number(alloc) === 30,
            JSON.stringify(alloc));
    }

    // --------------------------------------- a chip tap still fills the box
    //
    // The fix must not cost the thing it was built around: tapping a chip is not typing,
    // and it still writes its figure into the box.
    {
      await openSplit();
      await chipsFor(PIZZA).filter({ hasText: '½' }).click();
      await page.waitForTimeout(120);
      const box = await boxFor(PIZZA).inputValue();
      const r = await page.evaluate((nm) => ({
        alloc: window.splitSel[nm],
        share: document.getElementById('split-share-total').textContent
      }), PIZZA);
      check('tapping ½ puts ₹300 in the box', box === '300', JSON.stringify(box));
      check('and allocates it', Number(r.alloc) === 300 && r.share === '300', JSON.stringify(r));
    }

    // ------------------------------------ the untied box, which had half the fix already
    {
      await openSplit();
      await page.click('#split-other');
      await page.keyboard.type('75');
      await page.waitForTimeout(120);
      const r = await page.evaluate(() => ({
        focused: document.activeElement === document.getElementById('split-other'),
        box: document.getElementById('split-other').value,
        other: window.splitOther,
        share: document.getElementById('split-share-total').textContent
      }));
      check('the untied box takes a figure with the cursor still in it', r.focused === true);
      check('and carries it', r.box === '75' && Number(r.other) === 75 && r.share === '75',
            JSON.stringify(r));
      note('nothing in the list is derived from this, so it no longer redraws the list');
    }

    check('the till threw nothing while any of that ran', pageErrors.length === 0,
          pageErrors.slice(0, 3).join(' | '));
  } finally {
    await ctx.close();
    await browser.close();
    server.close();
  }

  done();
})();
