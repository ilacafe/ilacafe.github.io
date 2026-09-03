// Three things about the analytics page that are not its arithmetic.
//
// THE BUILD IT SAYS IT IS. Every other page reads its build from the tag that
// build-check.js carries, and `npm run bump` moves all of them together. This page
// had a literal typed into the markup — "layout build · 2026-07-10 · demand-merge h"
// — so the one page an owner opens TO find out what is running was the only one that
// could not say, and it answered July for two months. It had no watcher either, so
// it never noticed a deploy.
//
// CHART.JS IS SOMEBODY ELSE'S FILE. It comes off a CDN, and on café wifi a fetch
// that does not arrive is an ordinary Tuesday. `new Chart(...)` then throws, part-way
// through render() — after the KPIs are written and before the transactions table is
// — so the page half-drew and said nothing: numbers at the top, "Loading…" forever
// in the table, six blank rectangles, no explanation. (Before render() was moved onto
// a frame it was worse still: the throw landed in the try/catch around the sign-in
// check and came back as "Could not verify access. Check connection and retry.",
// which blamed a connection that was working.)
//
// THE DATE RANGE WAS MOST OF THE PAGE. Nine 44px pills over three rows, a custom-date
// block that wrapped onto five lines, and the chosen span on a line of its own: 503px
// of a 412px-wide phone, which put the revenue figure at y=822 — below the fold of
// every phone the café owns. The fix is the till's own category-strip pattern, so the
// suite checks the two things that pattern trades between: one line, and a 44px target
// on a chip that is nothing like 44px tall.
//
// The class rename that made that possible also fixed a bug it uncovered. .range-btn
// is a pill SHAPE worn by three different groups — the presets, the Analytics/Demand
// Map switch, and the Chef/Barista toggle — and init() bound the shape. So every view
// switch also ran setPreset(undefined), which falls through to the 30-day branch and
// threw away the range the owner had picked, and then cleared .active from the two
// buttons that say which view you are looking at.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Analytics — its build, its charts, and the size of its date picker');

const BUILD = JSON.parse(fs.readFileSync(path.join(ROOT, 'build.json'), 'utf8')).build;
const PHONE = { width: 412, height: 900 };

const ITEMS = ['Latte', 'Cappuccino', 'Pizza Margherita', 'Toastie'];
function makeHistory(count) {
  let seed = 987654321;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const h = {}; const now = Date.now();
  for (let i = 0; i < count; i++) {
    const ts = now - Math.floor(rnd() * 45 * 86400000);
    const items = {}; const nm = ITEMS[Math.floor(rnd() * ITEMS.length)];
    items[nm] = { qty: 1, price: 100 + Math.floor(rnd() * 100) };
    h[String(ts) + '_' + i] = { items,
      payment: { total: 200 + Math.floor(rnd() * 400), method: ['Cash', 'UPI'][i % 2] },
      orderType: ['Dine-in', 'Takeaway'][i % 2], tableOrAddress: 'T' + (i % 8),
      timestamp: new Date(ts).toISOString(), notes: '' };
  }
  return h;
}
const HIST = makeHistory(900);

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

// withChart false is the whole point of half this suite: the page has to survive the
// library never arriving, which is what a blocked CDN looks like from in here.
const stub = (withChart) => `
(() => {
  const noop=()=>{}; const chain=()=>new Proxy(function(){},{get:()=>chain(),apply:()=>chain()});
  const snap=v=>({val:()=>v,exists:()=>v!=null,forEach:()=>{},numChildren:()=>v?Object.keys(v).length:0,key:null});
  const HIST=${JSON.stringify(HIST)};
  ${withChart ? `window.Chart=function(c,cfg){this.cfg=cfg;this.destroy=noop;this.update=noop;this.resize=noop;};
  window.Chart.defaults={font:{},plugins:{}}; window.Chart.register=noop;` : ''}
  const mk=(q)=>({
    on:(e,cb)=>{ if(e!=='value') return cb;
      if(q==='.info/connected'){ setTimeout(()=>{try{cb(snap(true))}catch(err){}},0); return cb; }
      let v=null;
      if(q==='orders/history') v=HIST;
      else if(q==='menu') v={Coffee:{Latte:{price:150,routing:'barista'}}};
      setTimeout(()=>{try{cb(snap(v))}catch(err){}},30); return cb; },
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

const waitFor = async (tab, fn, ms) => {
  try { await tab.waitForFunction(fn, null, { timeout: ms }); return true; } catch (e) { return false; }
};

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});

  const open = async (withChart) => {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: PHONE });
    await ctx.addInitScript(stub(withChart));
    const tab = await ctx.newPage();
    const threw = [];
    tab.on('pageerror', e => threw.push(e.message));
    tab.on('dialog', d => d.dismiss().catch(() => {}));
    // Off-origin aborted, so the real Chart.js can never quietly stand in for the stub.
    await tab.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await tab.goto(base + '/analytics.html', { waitUntil: 'commit' });
    const drew = await waitFor(tab, () => {
      const e = document.getElementById('k-ord');
      return e && e.textContent && e.textContent !== '0' && e.textContent !== '—';
    }, 30000);
    return { ctx, tab, threw, drew };
  };

  // ------------------------------------------------ the build it says it is
  {
    const { ctx, tab, drew } = await open(true);
    check('the page draws', drew, 'k-ord never filled');
    const stamp = await tab.evaluate(() => {
      const e = document.getElementById('build-stamp');
      return e ? e.textContent.trim() : null;
    });
    check('the build stamp is the build that shipped', stamp === 'build ' + BUILD,
          'stamp says ' + JSON.stringify(stamp) + ', build.json says ' + BUILD);
    note('it said "layout build · 2026-07-10 · demand-merge h" for two months');
    // Comments stripped FIRST. Without that this matched the comment in the page that
    // quotes the old literal to explain it — the check failed on its own explanation,
    // which is the same trap render-blocking.test.js fell into with a <noscript>.
    const literal = fs.readFileSync(path.join(ROOT, 'analytics.html'), 'utf8')
                      .replace(/<!--[\s\S]*?-->/g, '');
    check('and no build is written into the markup by hand',
          !/demand-merge|layout build/.test(literal),
          'a hand-typed build is back in the page');

    // ---------------------------------------------- the date picker is not the page
    const geo = await tab.evaluate(() => {
      const card = [...document.querySelectorAll('.card')]
        .find(c => c.querySelector('h2') && /Date Range/.test(c.querySelector('h2').textContent));
      const krev = document.getElementById('k-rev');
      const chips = [...document.querySelectorAll('.range-chip')];
      const bar = document.getElementById('range-bar');
      return {
        cardH: Math.round(card.getBoundingClientRect().height),
        revTop: Math.round(krev.getBoundingClientRect().top + window.scrollY),
        chipRows: new Set(chips.map(c => Math.round(c.getBoundingClientRect().top))).size,
        chipCount: chips.length,
        chipH: Math.round(chips[0].getBoundingClientRect().height),
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        stripScrolls: bar.scrollWidth > bar.clientWidth,
        activeInView: (() => {
          const a = bar.querySelector('.range-chip.active'); if (!a) return false;
          const ab = a.getBoundingClientRect(), bb = bar.getBoundingClientRect();
          return ab.left >= bb.left - 1 && ab.right <= bb.right + 1;
        })()
      };
    });
    check('all nine presets sit on one line', geo.chipRows === 1 && geo.chipCount === 9,
          geo.chipCount + ' chips over ' + geo.chipRows + ' rows');
    check('and the chosen one is scrolled into view rather than off the edge',
          geo.activeInView, 'the active chip is outside the strip');
    check('the strip scrolls sideways instead of the page', geo.stripScrolls && geo.pageOverflow <= 0,
          'strip scrolls: ' + geo.stripScrolls + ', page overflow: ' + geo.pageOverflow + 'px');
    check('the date range card is a fraction of what it was',
          geo.cardH < 220, geo.cardH + 'px on a ' + PHONE.width + 'px phone — it was 503px');
    check('and the revenue figure is above the fold of a small phone',
          geo.revTop < 640, 'revenue at y=' + geo.revTop + ' — it was y=822');
    note('the fold on the smallest phone the café uses is around 650px');

    // a chip is small; the TARGET is 44 — the trade pos.html already makes
    const target = await tab.evaluate(() => {
      // A chip scrolled outside the strip is not on the glass, so elementFromPoint
      // answers about whatever IS — which read as a failed target the first time this
      // ran. The question is only meaningful for a chip you can currently see, so the
      // probe picks one that is fully inside the strip's own box.
      const bar = document.getElementById('range-bar');
      const bb = bar.getBoundingClientRect();
      const c = [...bar.querySelectorAll('.range-chip')].find(ch => {
        const r = ch.getBoundingClientRect();
        return r.left >= bb.left + 2 && r.right <= bb.right - 2;
      });
      if (!c) return { drawnH: 0, covered: false, none: true };
      const b = c.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const q = 44 / 2 - 1;
      const hit = (dx, dy) => { const e = document.elementFromPoint(cx + dx, cy + dy);
                                return e === c || c.contains(e); };
      return { drawnH: Math.round(b.height),
               covered: [[0,-q],[0,q],[-q,0],[q,0]].every(([x,y]) => hit(x,y)) };
    });
    check('a chip is drawn small but answers to a 44px thumb',
          target.drawnH < 40 && target.covered,
          'drawn ' + target.drawnH + 'px tall, 44px target covered: ' + target.covered);
    note('a 44px chip would put the strip back over three rows; a 44px TARGET does not');

    // ------------------------------------ the shape is not the group (the bound bug)
    const groups = await tab.evaluate(async () => {
      const pause = ms => new Promise(r => setTimeout(r, ms));
      const label = () => document.getElementById('range-label').textContent.trim();
      const lit = () => [...document.querySelectorAll('.range-chip.active')].map(b => b.dataset.range);
      document.querySelector('[data-range="today"]').click(); await pause(120);
      const picked = { label: label(), lit: lit(),
                       viewStillLit: document.getElementById('view-analytics').classList.contains('active') };
      document.getElementById('view-demand').click(); await pause(120);
      const swapped = { label: label(), lit: lit(),
                        demand: document.getElementById('view-demand').classList.contains('active'),
                        analytics: document.getElementById('view-analytics').classList.contains('active') };
      return { picked, swapped };
    });
    check('picking a range leaves the view switch alone',
          groups.picked.viewStillLit && groups.picked.lit.join() === 'today',
          JSON.stringify(groups.picked));
    check('and switching view does not silently throw the range away',
          groups.swapped.label === groups.picked.label && groups.swapped.lit.join() === 'today',
          'range was ' + groups.picked.label + ', became ' + groups.swapped.label +
          ' with ' + JSON.stringify(groups.swapped.lit) + ' lit');
    check('and exactly one view reads as selected',
          groups.swapped.demand && !groups.swapped.analytics, JSON.stringify(groups.swapped));
    note('setPreset(undefined) fell through to the 30-day branch — the range just changed under you');

    // custom dates: folded away, but whole
    const custom = await tab.evaluate(async () => {
      const det = document.querySelector('.range-more');
      const closed = !det.open;
      det.open = true;
      const f = document.getElementById('date-from'), t = document.getElementById('date-to');
      f.value = '2026-08-01'; t.value = '2026-08-31';
      window.applyCustom();
      await new Promise(r => setTimeout(r, 200));
      return { closed, label: document.getElementById('range-label').textContent.trim(),
               lit: [...document.querySelectorAll('.range-chip.active')].length };
    });
    check('custom dates are folded away by default', custom.closed, 'the disclosure starts open');
    check('and still apply when opened', /1 Aug 2026/.test(custom.label) && /31 Aug 2026/.test(custom.label),
          'label reads ' + JSON.stringify(custom.label));
    check('and applying one un-lights the presets', custom.lit === 0,
          custom.lit + ' presets still lit while a custom range is showing');
    await ctx.close();
  }

  // ------------------------------------------------ the library that did not arrive
  {
    const { ctx, tab, threw, drew } = await open(false);
    check('without Chart.js the page still draws its numbers', drew,
          'k-ord never filled — ' + (threw[0] || 'no error'));
    const state = await tab.evaluate(() => ({
      rows: document.querySelectorAll('#txn-body tr').length,
      loading: /Loading/.test((document.getElementById('txn-body') || {}).textContent || ''),
      notice: getComputedStyle(document.getElementById('charts-offline')).display,
      loginShown: !document.getElementById('login-overlay').classList.contains('hidden'),
      loginErr: (document.getElementById('login-error') || { textContent: '' }).textContent
    }));
    check('the transactions table fills instead of sticking on "Loading…"',
          state.rows > 50 && !state.loading, state.rows + ' rows, loading: ' + state.loading);
    note('render() threw at the first chart, after the KPIs and before this table');
    check('and the page says why the charts are blank', state.notice === 'block',
          'the notice is display:' + state.notice);
    check('and does not blame the sign-in for it',
          !state.loginShown && !/verify access/i.test(state.loginErr),
          'login shown: ' + state.loginShown + ' — ' + JSON.stringify(state.loginErr));
    check('and nothing throws', threw.length === 0, threw.slice(0, 2).join(' | '));
    await ctx.close();
  }

  await browser.close();
  server.close();
  done();
})();
