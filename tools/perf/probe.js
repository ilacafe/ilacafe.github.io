#!/usr/bin/env node
// What the app costs, measured rather than guessed.
//
//   npm run perf payload     what each page pulls from the database on a cold open
//   npm run perf boot        first paint, script, layout and DOM size, per page
//   npm run perf wifi        café wifi: first visit against a repeat open
//   npm run perf shift       a six-hour service on the till — does it grow?
//   npm run perf kds         a kitchen screen as the tickets pile up
//
// These are instruments, not tests. Nothing here asserts or fails a build: they report
// numbers, and the numbers only mean something next to the baseline in README.md.
//
// WHY THESE FIVE
//
// Each one exists because it found something the others could not see. `payload` found
// analytics reading 120 complete cash-ups — 5.2MB — to render a list built from about
// 10KB of them; no amount of CPU profiling would have shown that, because the cost was
// entirely on the wire. `wifi` found a localStorage key two pages disagreed about, by
// making one page's repeat-open number look wrong. `shift` and `kds` have never found
// anything, which is itself the finding: the till does not leak over a service and the
// kitchen board holds 60fps at eighty tickets.
//
// Scale is set by the café, not by the probe — see dataset.js:
//   DAYS_OPEN=1100 BILLS_DAY=200 npm run perf payload

const { chromium } = require('playwright');
const { serve, stub, PAGES, launchOpts } = require('./harness');
const dataset = require('./dataset');

const KB = b => (b / 1024).toFixed(0);
const MB = b => (b / 1048576).toFixed(2);
const CPU = Number(process.env.CPU || 4);          // a counter tablet, not a laptop

const pagesArg = () => (process.env.PAGES ? process.env.PAGES.split(',') : PAGES);

async function openPage(browser, base, db, opts, page, ctxOpts = {}) {
  const ctx = await browser.newContext(Object.assign(
    { serviceWorkers: 'block', viewport: { width: 1024, height: 900 } }, ctxOpts));
  await ctx.addInitScript(stub(db, opts));
  const tab = await ctx.newPage();
  const errs = [];
  tab.on('pageerror', e => errs.push(e.message));
  tab.on('dialog', d => d.dismiss().catch(() => {}));
  await tab.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
  const cdp = await ctx.newCDPSession(tab);
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await tab.goto(base + '/' + page, { waitUntil: 'load' });
  return { ctx, tab, cdp, errs };
}

const metrics = async (cdp) => {
  const m = await cdp.send('Performance.getMetrics');
  return k => { const e = m.metrics.find(x => x.name === k); return e ? e.value : 0; };
};

// ---------------------------------------------------------------- payload
async function payload(browser, base, db) {
  console.log('\nWhat each page pulls from the database on one cold open' +
              (process.env.RANGE === 'all' ? ', then All time on analytics' : ''));
  console.log(dataset.describe() + '\n');
  const rows = [];
  for (const p of pagesArg()) {
    const { ctx, tab, errs } = await openPage(browser, base, db, { count: true }, p);
    await tab.waitForTimeout(3500);
    // RANGE=all measures the preset that used to pull the whole order history.
    if (process.env.RANGE === 'all' && p === 'analytics.html') {
      await tab.evaluate(() => {
        const b = document.querySelector('[data-range="all"]'); if (b) b.click();
      });
      await tab.waitForTimeout(5000);
    }
    const pull = await tab.evaluate(() => window.__reads || {});
    const total = Object.values(pull).reduce((s, e) => s + e.bytes, 0);
    rows.push({ p, total, pull, errs });
    await ctx.close();
  }
  for (const r of rows.sort((a, b) => b.total - a.total)) {
    console.log(r.p.padEnd(16) + MB(r.total).padStart(7) + ' MB');
    Object.entries(r.pull).sort((a, b) => b[1].bytes - a[1].bytes)
      .filter(([, e]) => e.bytes > 2048).slice(0, 6)
      .forEach(([k, e]) => console.log('    ' + KB(e.bytes).padStart(7) + ' KB  ' + k +
                                       (e.calls > 1 ? '  ×' + e.calls : '')));
    if (r.errs.length) console.log('    ! ' + r.errs[0].slice(0, 110));
  }
}

// ---------------------------------------------------------------- boot
async function boot(browser, base, db) {
  console.log('\nBoot, at ' + CPU + '× CPU throttle');
  console.log('First paint is before any listener has answered — this is the page\'s own cost.');
  console.log('For what it then pulls down, run `payload`.\n');
  console.log('page              FCP     DCL   nodes  script  layout   style');
  for (const p of pagesArg()) {
    const { ctx, tab, cdp } = await openPage(browser, base, db, {}, p);
    await tab.waitForTimeout(1500);
    const g = await metrics(cdp);
    const paint = await tab.evaluate(() => {
      const f = performance.getEntriesByName('first-contentful-paint')[0];
      const n = performance.getEntriesByType('navigation')[0];
      return { fcp: f ? Math.round(f.startTime) : -1,
               dcl: n ? Math.round(n.domContentLoadedEventEnd) : -1,
               nodes: document.getElementsByTagName('*').length };
    });
    console.log(p.padEnd(16) + (paint.fcp + 'ms').padStart(7) + (paint.dcl + 'ms').padStart(8) +
      String(paint.nodes).padStart(8) +
      ((g('ScriptDuration') * 1000).toFixed(0) + 'ms').padStart(8) +
      ((g('LayoutDuration') * 1000).toFixed(0) + 'ms').padStart(8) +
      ((g('RecalcStyleDuration') * 1000).toFixed(0) + 'ms').padStart(8));
    await ctx.close();
  }
}

// ---------------------------------------------------------------- wifi
// Shared, congested, and a long way from Singapore. The repeat open is the one that
// matters — it is what a device does at the start of every shift — so it gets the
// service worker and the till's cached menu, which is what it would really have.
async function wifi(browser, base, db) {
  const NET = { offline: false, downloadThroughput: 1.6 * 1024 * 1024 / 8,
                uploadThroughput: 750 * 1024 / 8, latency: 300 };
  const RTT = 600;
  console.log('\nCafé wifi — 1.6Mbps, 300ms latency, ' + CPU + '× CPU, ' + RTT + 'ms database round trip\n');
  console.log('page             first visit          repeat open');
  console.log('                 FCP    usable        FCP    usable');
  for (const p of pagesArg()) {
    const out = [];
    for (const warm of [false, true]) {
      const ctxOpts = { serviceWorkers: warm ? 'allow' : 'block', viewport: { width: 412, height: 900 } };
      const ctx = await browser.newContext(ctxOpts);
      // Each page's OWN cache key, in its own shape. They are deliberately different —
      // the till stores the menu, the ordering page wraps it with the timestamp it ages
      // its copy out by — and seeding only the till's left index.html cold on the open
      // that is supposed to be warm, which flattered pos.html by comparison.
      if (warm) await ctx.addInitScript(`try{
        localStorage.setItem('ila_cached_menu', ${JSON.stringify(JSON.stringify(dataset.MENU))});
        localStorage.setItem('ila_cached_category_order', ${JSON.stringify(JSON.stringify(Object.keys(dataset.MENU)))});
        localStorage.setItem('ila_cached_item_order','{}');
        localStorage.setItem('ila_cust_menu', ${JSON.stringify(JSON.stringify({
          at: Date.now(), menu: dataset.MENU, order: Object.keys(dataset.MENU), items: {} }))});
      }catch(e){}`);
      await ctx.addInitScript(stub(db, { rtt: RTT, connectAt: RTT }));
      const tab = await ctx.newPage();
      tab.on('dialog', d => d.dismiss().catch(() => {}));
      const cdp = await ctx.newCDPSession(tab);
      await cdp.send('Network.enable');
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
      await tab.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
      if (warm) { await tab.goto(base + '/' + p, { waitUntil: 'load' }); await tab.waitForTimeout(300); }
      await cdp.send('Network.emulateNetworkConditions', NET);
      const t0 = Date.now();
      await tab.goto(base + '/' + p, { waitUntil: 'commit' });
      let usable = -1;
      try {
        await tab.waitForFunction(
          () => document.querySelectorAll('.menu-row,.coffee-row,#k-rev,.card,#board,.kds,.ticket,section').length > 0,
          null, { timeout: 20000 });
        usable = Date.now() - t0;
      } catch (e) {}
      const fcp = await tab.evaluate(() => {
        const f = performance.getEntriesByName('first-contentful-paint')[0];
        return f ? Math.round(f.startTime) : -1;
      });
      out.push([fcp, usable]);
      await ctx.close();
    }
    console.log(p.padEnd(16) + (out[0][0] + 'ms').padStart(7) + (out[0][1] + 'ms').padStart(10) +
                '   ' + (out[1][0] + 'ms').padStart(7) + (out[1][1] + 'ms').padStart(10));
  }
  console.log('\n"usable" is when the page has something on it worth looking at, not when it stopped loading.');
}

// ---------------------------------------------------------------- shift
// A till is opened once and left. What matters is not how it starts but whether it is
// the same page six hours later.
async function shift(browser, base, db) {
  const HOURS = Number(process.env.HOURS || 6), PER_HOUR = Number(process.env.PER_HOUR || 40);
  console.log('\nA ' + HOURS + '-hour service on the till, ' + PER_HOUR + ' order cycles an hour\n');
  const { ctx, tab, cdp, errs } = await openPage(browser, base, db, {}, 'pos.html');
  await tab.waitForFunction(() => document.querySelectorAll('.swap-container').length > 20,
                            null, { timeout: 20000 }).catch(() => {});
  const sample = async (label) => {
    const g = await metrics(cdp);
    const dom = await tab.evaluate(() => ({
      nodes: document.getElementsByTagName('*').length,
      listeners: Object.values(window.__cbs || {}).reduce((s, a) => s + a.length, 0) }));
    return { label, heap: g('JSHeapUsedSize') / 1048576, nodes: dom.nodes, listeners: dom.listeners };
  };
  const rows = [await sample('after boot')];
  for (let h = 0; h < HOURS; h++) {
    await tab.evaluate(async (n) => {
      const pause = ms => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < n; i++) {
        const tables = {};
        for (let t = 1; t <= 1 + (i % 9); t++) tables[String(t)] = { total: 100 + i, paid: 0 };
        window.__fire('pos/activeTables', tables);
        window.__fire('orders/active/chef', { o1: { items: { x: 1 } } });
        window.__fire('orders/pendingWeb', { w1: { items: { 'Item 0-0': { qty: 1, price: 100 } }, total: 100 } });
        const btn = document.querySelector('[data-add]'); if (btn) { btn.click(); btn.click(); }
        if (window.clearCart) { try { window.clearCart(true); } catch (e) {} }
        if (i % 10 === 0) await pause(0);
      }
    }, PER_HOUR);
    rows.push(await sample('hour ' + (h + 1)));
  }
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  rows.push(await sample('after GC'));
  console.log('stage'.padEnd(12) + 'heap'.padStart(9) + 'nodes'.padStart(8) + 'db listeners'.padStart(14));
  for (const r of rows)
    console.log(r.label.padEnd(12) + (r.heap.toFixed(1) + ' MB').padStart(9) +
                String(r.nodes).padStart(8) + String(r.listeners).padStart(14));
  if (errs.length) console.log('\npage errors: ' + errs.slice(0, 2).join(' | '));
  console.log('\nGrowth in any column across the hours is the finding. Flat is the expected result.');
  await ctx.close();
}

// ---------------------------------------------------------------- kds
async function kds(browser, base, db) {
  console.log('\nA kitchen screen as the tickets pile up, at ' + CPU + '× CPU throttle\n');
  const { ctx, tab, cdp } = await openPage(browser, base, db, { role: 'chef' }, 'chef.html');
  await tab.waitForTimeout(600);
  const ITEMS = ['Pizza Margherita', 'Garlic Bread', 'Toastie', 'Pasta', 'Salad'];
  console.log('tickets   redraw   nodes     heap   worst frame');
  for (const n of [5, 10, 20, 40, 80]) {
    const board = {};
    for (let i = 0; i < n; i++) {
      const items = {}; const k = 1 + (i % 3);
      for (let j = 0; j < k; j++) items[ITEMS[(i + j) % ITEMS.length]] = { qty: 1 + (j % 2), price: 200 + j * 20 };
      board['t' + i] = { items, timestamp: Date.now() - (i % 20) * 60000,
                         table: 'Table ' + (1 + i % 9), orderType: 'Dine-in', notes: '', station: 'chef' };
    }
    const r = await tab.evaluate(async (b) => {
      const paint = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now()))));
      const t0 = performance.now();
      window.__fire('orders/active/chef', b);
      const done = await paint();
      const frames = []; let last = performance.now(), raf;
      const tick = () => { const x = performance.now(); frames.push(x - last); last = x; raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick);
      await new Promise(res => setTimeout(res, 1000));
      cancelAnimationFrame(raf);
      frames.sort((p, q) => p - q);
      return { ms: +(done - t0).toFixed(1), nodes: document.getElementsByTagName('*').length,
               worst: +frames[frames.length - 1].toFixed(1) };
    }, board);
    const g = await metrics(cdp);
    console.log(String(n).padStart(5) + (r.ms + 'ms').padStart(10) + String(r.nodes).padStart(8) +
                ((g('JSHeapUsedSize') / 1048576).toFixed(1) + ' MB').padStart(9) +
                (r.worst + 'ms').padStart(14));
  }
  console.log('\nA worst frame near 16.7ms is 60fps holding. Eighty tickets is hours of backlog, not a rush.');
  await ctx.close();
}

const PROBES = { payload, boot, wifi, shift, kds };

(async () => {
  const which = process.argv[2];
  if (!which || !PROBES[which]) {
    console.log('\n  npm run perf <probe>\n');
    Object.keys(PROBES).forEach(k => console.log('    ' + k));
    console.log('\n  PAGES=pos.html,index.html   CPU=4   DAYS_OPEN=550 BILLS_DAY=100\n');
    process.exit(which ? 1 : 0);
  }
  // payload is about bytes, so it gets the whole café. The timing probes get the
  // small fixture — see the comment on lite() for why that is the honest choice.
  const db = (which === 'payload') ? dataset.build() : dataset.lite();
  const { server, base } = await serve();
  const browser = await chromium.launch(launchOpts());
  try { await PROBES[which](browser, base, db); }
  finally { await browser.close(); server.close(); }
})();
