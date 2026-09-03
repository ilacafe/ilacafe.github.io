// Analytics has to stay usable as the café keeps trading.
//
// Everything on this page is derived from orders/history, which only ever grows. Two
// costs grew with it, and neither had an upper bound but how long the café has been
// open:
//
//   the transactions table is one row per order in the range, in a `table-layout:
//   auto` table, so sizing its columns means measuring every cell in every row. At
//   40,000 orders that measurement was 685ms — 90% of all the layout on the page —
//   for rows that sit far below the fold in a box that shows about ten at a time.
//
//   render() walks the whole history and rebuilds every table and chart, and a cold
//   open ran it FIVE times: once for the range preset, then again as each of menu,
//   voids, unpaid and the history landed, each within a moment of the others, each
//   throwing away a picture nobody had seen.
//
// This suite is about the properties that keep those bounded, and — the part that
// matters more — that neither shortcut changed a single number or lost a single row.
// A faster page showing the wrong total is a worse page.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Analytics at scale — bounded layout, one render, same numbers');

// Enough orders that a per-order cost is unmistakable, spread over a range wide
// enough that the default 30-day preset holds hundreds of them.
const ORDERS = 4000;
const SPAN_DAYS = 60;
const ITEMS = ['Latte', 'Cappuccino', 'Pizza Margherita', 'Toastie', 'Cold Brew'];

// Built from a fixed seed: the expected totals below are computed from this same
// data in the test process, so the page's arithmetic is checked against an
// independent walk rather than against itself.
function makeHistory(count) {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const h = {};
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const ts = now - Math.floor(rnd() * SPAN_DAYS * 86400000);
    const items = {};
    const n = 1 + Math.floor(rnd() * 3);
    for (let j = 0; j < n; j++) {
      const nm = ITEMS[Math.floor(rnd() * ITEMS.length)];
      items[nm] = { qty: 1 + Math.floor(rnd() * 2), price: 100 + Math.floor(rnd() * 150) };
    }
    h[String(ts) + '_' + i] = {
      items,
      payment: { total: 200 + Math.floor(rnd() * 700), method: ['Cash', 'UPI', 'Card'][i % 3] },
      orderType: ['Dine-in', 'Takeaway', 'Delivery'][i % 3],
      tableOrAddress: 'T' + (i % 10),
      timestamp: new Date(ts).toISOString(),
      notes: ''
    };
  }
  return h;
}
const HIST = makeHistory(ORDERS);

// What the page must arrive at, worked out here rather than read off the page.
// The default preset is 30 days; setPreset('30d') sets start = now - 30d.
function expected30d(hist) {
  const end = Date.now(), start = end - 30 * 86400000;
  let rev = 0, orders = 0;
  for (const id in hist) {
    const ts = parseInt(id, 10);
    if (ts >= start && ts < end) { rev += hist[id].payment.total; orders++; }
  }
  return { rev, orders };
}

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

// All four render-triggering nodes answer in the SAME tick. That is the shape a cold
// open actually has — they arrive within a moment of each other — and it is the shape
// coalescing is for: four arrivals, one picture.
//
// Chart is stubbed rather than loaded. The real one comes off a CDN this suite blocks
// (see the route below), and what is under test is the page's own layout and render
// count, not a charting library's.
const stub = (hist) => `
(() => {
  const noop=()=>{}; const chain=()=>new Proxy(function(){},{get:()=>chain(),apply:()=>chain()});
  const snap=v=>({val:()=>v,exists:()=>v!=null,forEach:()=>{},numChildren:()=>v?Object.keys(v).length:0,key:null});
  const HIST=${JSON.stringify(hist)};
  window.Chart=function(ctx,cfg){this.cfg=cfg;this.destroy=noop;this.update=noop;this.resize=noop;};
  window.Chart.defaults={font:{},plugins:{}}; window.Chart.register=noop;
  const mk=(q)=>({
    on:(e,cb)=>{ if(e!=='value') return cb;
      if(q==='.info/connected'){ setTimeout(()=>{try{cb(snap(true))}catch(err){}},0); return cb; }
      let v=null;
      if(q==='orders/history') v=HIST;
      else if(q==='menu') v={Coffee:{Latte:{price:150,routing:'barista'}}};
      setTimeout(()=>{try{cb(snap(v))}catch(err){}},40);   // same tick for every node
      return cb; },
    off:noop, child:()=>mk(q),
    once:()=>new Promise(r=>setTimeout(()=>r(snap(q.indexOf('users/')===0?{role:'admin',name:'A'}:null)),0)),
    limitToLast:()=>mk(q), orderByChild:()=>mk(q), orderByKey:()=>mk(q), startAt:()=>mk(q),
    push:()=>({key:'k'}), set:()=>Promise.resolve(), remove:()=>Promise.resolve(),
    update:()=>Promise.resolve(),
    transaction:(f,cb)=>{if(cb)cb(null,false,snap(null));return Promise.resolve({committed:false});}
  });
  const db={ref:p=>mk(String(p==null?'':p)), goOnline:noop, goOffline:noop};
  window.firebase={initializeApp:noop,apps:[{}],
    database:Object.assign(()=>db,{ServerValue:{TIMESTAMP:0,increment:n=>n}}),
    auth:()=>({onAuthStateChanged:cb=>setTimeout(()=>{try{cb({uid:'u1'})}catch(err){}},0),
      signInWithEmailAndPassword:()=>Promise.resolve({}),signOut:()=>Promise.resolve(),
      currentUser:{uid:'u1'}}),
    messaging:()=>({getToken:()=>Promise.resolve(null),onMessage:noop})};
  window.__stub=true;
  try{ localStorage.setItem('ila.role.v1', JSON.stringify({uid:'u1',role:'admin',name:'A'})); }catch(e){}
})();`;

// Counts full renders without reaching into the page's scope: every render writes the
// revenue KPI, so mutations of that node are renders. Installed before any script runs.
const countRenders = `
(() => {
  window.__renders = 0;
  const iv = setInterval(() => {
    const el = document.getElementById('k-rev');
    if (!el) return;
    clearInterval(iv);
    new MutationObserver(() => { window.__renders++; })
      .observe(el, { childList: true, characterData: true, subtree: true });
  }, 5);
})();`;

const waitFor = async (tab, fn, ms) => {
  try { await tab.waitForFunction(fn, null, { timeout: ms }); return true; } catch (e) { return false; }
};

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const threw = [];

  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(countRenders);
  await ctx.addInitScript(stub(HIST));
  const tab = await ctx.newPage();
  // Enabled before the navigation: Performance.getMetrics only counts from the moment
  // the domain is on, and a session opened after load reports zeros — which read as a
  // pass-shaped failure the first time round.
  const cdp = await ctx.newCDPSession(tab);
  await cdp.send('Performance.enable');
  tab.on('pageerror', e => threw.push(e.message));
  tab.on('dialog', d => d.dismiss().catch(() => {}));
  // Off-origin blocked, so the real Chart.js can never quietly replace the stub —
  // the same trap that let an earlier browser suite pass for the wrong reason.
  await tab.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
  await tab.goto(base + '/analytics.html', { waitUntil: 'commit' });

  const drew = await waitFor(tab, () => {
    const e = document.getElementById('k-ord');
    return e && e.textContent && e.textContent !== '0' && e.textContent !== '—';
  }, 30000);
  check('the page gets past the gate and puts numbers on screen', drew,
        drew ? '' : 'k-ord never filled — ' + (threw[0] || 'no page error'));

  check('the stub is what the page ran against', await tab.evaluate(() => window.__stub === true),
        'the real SDK replaced it');

  // ---- the numbers, against a walk done here rather than by the page
  const want = expected30d(HIST);
  const got = await tab.evaluate(() => ({
    rev: (document.getElementById('k-rev') || {}).textContent || '',
    ord: (document.getElementById('k-ord') || {}).textContent || ''
  }));
  const gotOrders = parseInt(String(got.ord).replace(/[^0-9]/g, ''), 10);
  const gotRev = parseInt(String(got.rev).replace(/[^0-9]/g, ''), 10);
  check('the order count is the one an independent walk of the same data gives',
        gotOrders === want.orders, 'page ' + gotOrders + ', expected ' + want.orders);
  check('and so is the revenue',
        gotRev === want.rev, 'page ' + gotRev + ', expected ' + want.rev);
  note('coalescing renders must not change the answer, only how often it is computed');

  // ---- one picture, not five
  const renders = await tab.evaluate(() => window.__renders);
  check('four nodes arriving together are drawn once, not once each',
        renders <= 2, renders + ' full renders on a cold open (was 5, budget 2)');
  note('one for the range preset, one when the history lands — never one per listener');

  // ---- the transactions table is skipped until it is looked at
  const box = await tab.evaluate(() => {
    const b = document.querySelector('.scroll.bulk');
    if (!b) return { missing: true };
    return { cv: getComputedStyle(b).contentVisibility,
             intrinsic: getComputedStyle(b).containIntrinsicSize,
             rows: b.querySelectorAll('tbody tr').length,
             holdsTxns: !!b.querySelector('#txn-body') };
  });
  check('the transactions box is the one carrying the rule', !box.missing && box.holdsTxns,
        JSON.stringify(box));
  check('and its layout is skipped while it is off screen', box.cv === 'auto',
        'content-visibility is ' + box.cv);
  check('with a stand-in height, so the page is not shorter than it should be',
        /\bauto\b/.test(box.intrinsic || '') && /460px/.test(box.intrinsic || ''),
        'contain-intrinsic-size is ' + box.intrinsic);

  // ---- and nothing was thrown away to get it
  check('every row is still in the document, not just the ten on screen',
        box.rows > 100, box.rows + ' rows');
  note('skipping layout is not the same as rendering fewer rows — the CSV export, the ' +
       'sort and find-in-page all read these');

  // The check that separates "skipped" from "broken": scrolled to, it must lay out.
  const shown = await tab.evaluate(async () => {
    const b = document.querySelector('.scroll.bulk');
    b.scrollIntoView({ block: 'center' });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const first = b.querySelector('tbody tr');
    return { boxH: Math.round(b.getBoundingClientRect().height),
             rowH: first ? Math.round(first.getBoundingClientRect().height) : 0,
             text: first ? first.innerText.replace(/\s+/g, ' ').trim().slice(0, 30) : '',
             scrolls: b.scrollHeight > b.clientHeight + 1 };
  });
  check('scrolled to, the rows have real height and real text',
        shown.boxH > 100 && shown.rowH > 0 && shown.text.length > 0, JSON.stringify(shown));
  check('and the box still scrolls through them', shown.scrolls, JSON.stringify(shown));

  // ---- the layout cost is bounded by the viewport, not by the size of the table
  //
  // On a FRESH page. The checks above deliberately scrolled the box into view, and
  // content-visibility keeps a subtree rendered once it has been seen — measuring here
  // would measure a box that is no longer being skipped. This is also the honest
  // scenario: the win is on the renders that happen before anyone scrolls down, which
  // is every render of a cold open.
  //
  // Three earlier versions of this check passed against the bug. The first compared
  // two histories, but the table caps at 500 rows so both laid out the same table. The
  // second nudged body padding, which does not invalidate a fixed-size scroll
  // container's contents. The third forced the same layout repeatedly after it had
  // settled. All three read as "no growth" whether the rule was there or not.
  //
  // What costs is what render() does: rewrite the tbody. That invalidates the table,
  // and an auto-layout table re-measures every cell in every row to size its columns.
  // So each round rewrites the rows — untimed, since parsing scales with row count
  // either way and would drown the signal — and times only the forced layout after it.
  const fresh = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  await fresh.addInitScript(stub(HIST));
  const ftab = await fresh.newPage();
  ftab.on('dialog', d => d.dismiss().catch(() => {}));
  await ftab.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
  await ftab.goto(base + '/analytics.html', { waitUntil: 'commit' });
  await waitFor(ftab, () => {
    const e = document.getElementById('k-ord');
    return e && e.textContent && e.textContent !== '0' && e.textContent !== '—';
  }, 30000);

  const grow = await ftab.evaluate(async () => {
    const box = document.querySelector('.scroll.bulk');
    const body = box.querySelector('tbody');
    const html = body.innerHTML;
    const layoutCost = (n) => {
      let total = 0;
      for (let i = 0; i < n; i++) {
        body.innerHTML = html;                           // dirty the table (untimed)
        const t = performance.now();
        void document.documentElement.offsetHeight;      // force document layout
        total += performance.now() - t;
      }
      return total;
    };
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const offScreen = box.getBoundingClientRect().top > window.innerHeight;
    layoutCost(3);
    const off = Math.min(layoutCost(12), layoutCost(12));

    // The control: the SAME table, the same rewrites, with the box on screen so it
    // cannot be skipped. This is what those rows cost when they are laid out, and it
    // is what the page paid for every one of them before the rule existed.
    box.scrollIntoView({ block: 'center' });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const onScreen = box.getBoundingClientRect().top < window.innerHeight;
    layoutCost(3);
    const on = Math.min(layoutCost(12), layoutCost(12));
    return { offScreen, onScreen, rows: body.querySelectorAll('tr').length, off, on };
  });
  await fresh.close();

  check('the measurement really did see the box off screen, then on',
        grow.offScreen && grow.onScreen, JSON.stringify(grow));
  check('laying those rows out is measurably expensive when they ARE laid out',
        grow.on > 5, 'the control cost only ' + grow.on.toFixed(1) + 'ms for ' + grow.rows +
        ' rows — too small to conclude anything from');
  note('without this control the check below would pass on a page that never lays anything out');
  const share = grow.on > 0 ? grow.off / grow.on : 99;
  check('and costs almost nothing while they are off screen',
        share < 0.5, 'off screen ' + grow.off.toFixed(1) + 'ms vs on screen ' +
        grow.on.toFixed(1) + 'ms — ' + Math.round(share * 100) + '% of the cost, budget 50%');
  note('this is the one that fails when the rule is dropped: the rows go back to being measured');

  check('nothing threw', threw.length === 0, threw.join(' | '));

  await browser.close();
  server.close();
  done();
})();
