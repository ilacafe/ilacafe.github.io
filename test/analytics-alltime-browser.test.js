// "All time" on the real page, with the rollups and without them.
//
// It used to drop the key filter and pull every order the café had ever taken: 13.3MB
// at 41,000 orders, roughly a minute on café wifi, to draw totals. Every figure on the
// page except the transactions table is a sum over orders, so orders/daily holds those
// sums per closed day and the range is served from them instead.
//
// analytics-agree.test.js already holds the two aggregation paths to the same numbers
// on a fixture. This holds the PAGE to them: the same café, opened twice, once with the
// rollups present and once with the node empty so it has to read the orders. Every
// figure on screen has to match, because the whole change is worthless — worse than
// worthless — if the faster path reports different money.
//
// It also checks the thing that is genuinely different, rather than pretending nothing
// is: the transactions table shows a window of the range, not all of it, and says so.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('All time — the same money, without the download');

const DAY = 86400000;
const DAYS = 40, PER_DAY = 12;
const ITEMS = ['Latte', 'Cappuccino', 'Pizza Margherita', 'Toastie', 'Cold Brew'];
const METHODS = ['Cash', 'UPI', 'Card'];
const TYPES = ['Dine-in', 'Takeaway', 'Delivery/Web'];

// Orders spread over closed days AND today, because today is the part no rollup covers
// and the page has to add it to them rather than instead of them.
function makeHistory() {
  const h = {}; let n = 0;
  const midnight = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  for (let day = DAYS; day >= 0; day--) {
    for (let i = 0; i < PER_DAY; i++) {
      const ts = midnight - day * DAY + (8 + (i % 12)) * 3600000 + i * 60000;
      if (ts > Date.now()) continue;
      const items = {};
      const k = 1 + (i % 3);
      for (let j = 0; j < k; j++) {
        const nm = ITEMS[(day + i + j) % ITEMS.length] + (j === 1 ? ' (Large)' : '');
        items[nm] = { qty: 1 + (j % 2), price: 100 + ((day + j) * 13) % 200 };
      }
      h[String(ts) + '-' + (n++).toString(36)] = {
        timestamp: '3 Sep 2026, 14:32', source: 'POS',
        orderType: TYPES[(day + i) % 3], tableOrAddress: 'Table ' + (i % 9), notes: '',
        payment: { method: METHODS[(day + i) % 3], total: 150 + ((day * 7 + i * 11) % 600), verified: true },
        items
      };
    }
  }
  return h;
}
const HIST = makeHistory();

// Today has to contain something, or "the page forgot today" is untestable. The
// generator skips slots in the future, so a run early in the morning would otherwise
// leave today empty and every check below would pass on a page that drops it.
{
  const midnight = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const todays = Object.keys(HIST).filter(k => parseInt(k, 10) >= midnight).length;
  if (!todays) {
    const ts = Math.min(Date.now() - 60000, midnight + 3600000);
    HIST[String(ts) + '-today'] = {
      timestamp: 'today', source: 'POS', orderType: 'Dine-in', tableOrAddress: 'T1', notes: '',
      payment: { method: 'Cash', total: 999, verified: true },
      items: { 'Latte': { qty: 3, price: 150 } } };
  }
}

// The rollups, built the way the page builds them.
function makeRollups() {
  const midnight = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const daily = {};
  for (const id in HIST) {
    const ts = parseInt(id, 10);
    if (ts >= midnight) continue;                       // today is never rolled up
    const d = new Date(ts);
    const dk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
               String(d.getDate()).padStart(2, '0');
    const o = HIST[id];
    const r = daily[dk] || (daily[dk] = { rev: 0, orders: 0, pay: {},
      type: { 'Dine-in': 0, Takeaway: 0, Delivery: 0 }, hour: new Array(24).fill(0), item: {} });
    const amt = Number(o.payment.total) || 0;
    r.rev += amt; r.orders++;
    r.pay[o.payment.method] = (r.pay[o.payment.method] || 0) + amt;
    const t = o.orderType;
    if (/Delivery|Web/i.test(t)) r.type.Delivery++;
    else if (/Takeaway/i.test(t)) r.type.Takeaway++;
    else r.type['Dine-in']++;
    r.hour[d.getHours()]++;
    for (const nm in o.items) {
      const base = String(nm).split(' (')[0];
      const it = r.item[base] || (r.item[base] = { q: 0, r: 0 });
      it.q += o.items[nm].qty; it.r += o.items[nm].price * o.items[nm].qty;
    }
  }
  return daily;
}
const ROLLUPS = makeRollups();

const TYPESMAP = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
                   '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const f = path.join(ROOT, u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'Content-Type': TYPESMAP[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});

const stub = (withRollups) => `
(() => {
  const noop=()=>{};
  const D = { 'orders/history': ${JSON.stringify(HIST)},
              'orders/daily': ${withRollups ? JSON.stringify(ROLLUPS) : '{}'},
              menu: { Coffee:{ Latte:{price:150}, Cappuccino:{price:180}, 'Cold Brew':{price:200} },
                      Food:{ 'Pizza Margherita':{price:450}, Toastie:{price:180} } },
              'settings/categoryOrder': ['Coffee','Food'] };
  window.__db = D; window.__stub = true; window.__reads = {};
  const byPath = p => { if (D[p] !== undefined) return D[p];
    const parts=String(p).split('/');
    for (let i=parts.length-1;i>0;i--){ const head=parts.slice(0,i).join('/');
      if (D[head] !== undefined){ let v=D[head]; for(const k of parts.slice(i)) v=(v==null?undefined:v[k]); return v; } }
    return null; };
  const setPath = (p,v) => { const parts=String(p).split('/');
    for (let i=parts.length-1;i>0;i--){ const head=parts.slice(0,i).join('/');
      if (D[head] !== undefined){ let o=D[head]; const rest=parts.slice(i);
        for (let j=0;j<rest.length-1;j++){ o[rest[j]]=o[rest[j]]||{}; o=o[rest[j]]; }
        o[rest[rest.length-1]]=v; return; } }
    D[p]=v; };
  const size = v => { try { return new TextEncoder().encode(JSON.stringify(v==null?null:v)).length; } catch(e){ return 0; } };
  const tally = (p,v) => { const e=window.__reads[p]||(window.__reads[p]={calls:0,bytes:0}); e.calls++; e.bytes+=size(v); };
  const snap = v => ({ val:()=>v, exists:()=>v!=null,
    forEach:cb=>{ if(v&&typeof v==='object') Object.keys(v).forEach(k=>cb({key:k,val:()=>v[k]})); },
    numChildren:()=>v&&typeof v==='object'?Object.keys(v).length:0, key:null });
  const applyQ = (val,q) => { if(!val||typeof val!=='object'||Array.isArray(val)) return val;
    let keys=Object.keys(val); if(q.orderByKey||q.orderByChild) keys.sort();
    if(q.startAt!=null) keys=keys.filter(k=>String(k)>=String(q.startAt));
    if(q.limitToLast!=null) keys=keys.slice(-q.limitToLast);
    const o={}; keys.forEach(k=>o[k]=val[k]); return o; };
  const mk = (p,q) => ({
    on:(e,cb)=>{ if(e!=='value') return cb;
      if(p==='.info/connected'){ setTimeout(()=>{try{cb(snap(true))}catch(x){}},10); return cb; }
      const v=applyQ(byPath(p),q); tally(p,v);
      setTimeout(()=>{try{cb(snap(v))}catch(x){}},25); return cb; },
    once:()=>{ if(p.indexOf('users/')===0) return Promise.resolve(snap({role:'admin',name:'A'}));
      const v=applyQ(byPath(p),q); tally(p,v); return Promise.resolve(snap(v)); },
    off:noop, child:k=>mk(p+'/'+k,q),
    orderByChild:()=>mk(p,{...q,orderByChild:true}), orderByKey:()=>mk(p,{...q,orderByKey:true}),
    startAt:v=>mk(p,{...q,startAt:v}), limitToLast:n=>mk(p,{...q,limitToLast:n}),
    push:()=>({key:'k'}), set:v=>{ setPath(p,v); return Promise.resolve(); },
    update:v=>{ if(p==='') Object.keys(v).forEach(k=>setPath(k,v[k])); return Promise.resolve(); },
    remove:()=>Promise.resolve(),
    transaction:(f,cb)=>{ if(cb) cb(null,false,snap(null)); return Promise.resolve({committed:false}); } });
  const db = { ref:p=>mk(String(p==null?'':p),{}), goOnline:noop, goOffline:noop };
  window.Chart=function(c,cfg){this.cfg=cfg;this.destroy=noop;this.update=noop;this.resize=noop;};
  window.Chart.defaults={font:{},plugins:{}}; window.Chart.register=noop;
  window.firebase={initializeApp:noop,apps:[{}],
    database:Object.assign(()=>db,{ServerValue:{TIMESTAMP:Date.now(),increment:n=>n}}),
    auth:()=>({onAuthStateChanged:cb=>setTimeout(()=>{try{cb({uid:'u1'})}catch(x){}},0),
      signInWithEmailAndPassword:()=>Promise.resolve({}),signOut:()=>Promise.resolve(),currentUser:{uid:'u1'}}),
    messaging:()=>({getToken:()=>Promise.resolve(null),onMessage:noop})};
  try{ localStorage.setItem('ila.role.v1', JSON.stringify({uid:'u1',role:'admin',name:'A'})); }catch(e){}
})();`;

const waitFor = async (tab, fn, ms) => {
  try { await tab.waitForFunction(fn, null, { timeout: ms }); return true; } catch (e) { return false; }
};

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE) ? { executablePath: PRE } : {});

  const openAllTime = async (withRollups) => {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(stub(withRollups));
    const tab = await ctx.newPage();
    const threw = [];
    tab.on('pageerror', e => threw.push(e.message));
    tab.on('dialog', d => d.dismiss().catch(() => {}));
    await tab.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await tab.goto(base + '/analytics.html', { waitUntil: 'commit' });
    await waitFor(tab, () => { const e = document.getElementById('k-ord');
      return e && e.textContent && e.textContent !== '0'; }, 20000);
    await tab.evaluate(() => document.querySelector('[data-range="all"]').click());
    await tab.waitForTimeout(2500);
    const shown = await tab.evaluate(() => ({
      rev: (document.getElementById('k-rev') || {}).textContent,
      ord: (document.getElementById('k-ord') || {}).textContent,
      aov: (document.getElementById('k-aov') || {}).textContent,
      itm: (document.getElementById('k-itm') || {}).textContent,
      top: [...document.querySelectorAll('#top-body tr')].slice(0, 8)
             .map(r => r.textContent.replace(/\s+/g, ' ').trim()),
      count: (document.getElementById('txn-count') || {}).textContent.replace(/\s+/g, ' ').trim()
    }));
    const reads = await tab.evaluate(() => window.__reads);
    // What it left behind. A café opening this for the first time has no rollups, so
    // the page reads the history once and writes them — if it does not, every open
    // pays full price forever and nothing above would notice.
    const wrote = await tab.evaluate(() => Object.keys(window.__db['orders/daily'] || {}).length);
    await ctx.close();
    return { shown, reads, threw, wrote };
  };

  const withRollups = await openAllTime(true);
  const without = await openAllTime(false);

  check('both opens drew All time', !!withRollups.shown.ord && !!without.shown.ord,
        JSON.stringify({ a: withRollups.shown.ord, b: without.shown.ord }));
  check('and neither threw', withRollups.threw.length === 0 && without.threw.length === 0,
        (withRollups.threw[0] || without.threw[0] || '').slice(0, 120));

  // ---- against a walk of the same orders, done here
  //
  // Comparing the two opens to EACH OTHER is not enough and the first version of this
  // suite was wrong for exactly that reason: the open with no rollups builds them and
  // then folds them, so both opens end up on the same code path and agree even when
  // that path is broken. Dropping today's raw orders and double-counting today were
  // both real bugs that this suite passed. The control has to be arithmetic nobody on
  // the page did.
  const truth = (() => {
    let rev = 0, orders = 0, items = 0;
    for (const id in HIST) {
      const o = HIST[id];
      rev += Number(o.payment.total) || 0;
      orders++;
      for (const nm in o.items) items += Number(o.items[nm].qty) || 0;
    }
    return { rev, orders, items };
  })();
  const digits = v => parseInt(String(v || '').replace(/[^0-9]/g, ''), 10);
  // BOTH opens, against the same arithmetic. Checking only the seeded one left a real
  // bug alive: rolling today up as though the day were over double-counts it against
  // the raw orders for today, and that code only runs on the open that has no rollups
  // yet — the very case the seeded open never reaches.
  for (const [label, r] of [['with the rollups already there', withRollups],
                            ['and on the open that builds them', without]]) {
    check(label + ': revenue is the sum of every order, worked out here',
          digits(r.shown.rev) === truth.rev,
          'page ' + digits(r.shown.rev) + ', expected ' + truth.rev);
    check(label + ': the order count is every order',
          digits(r.shown.ord) === truth.orders,
          'page ' + digits(r.shown.ord) + ', expected ' + truth.orders);
    check(label + ': and the items sold',
          digits(r.shown.itm) === truth.items,
          'page ' + digits(r.shown.itm) + ', expected ' + truth.items);
  }
  note('rollups for the closed days plus raw for today — miss either, or count today');
  note('twice, and these fail with the difference on the line');

  // ---- the numbers, figure for figure
  const same = (name, k) => check(name, withRollups.shown[k] === without.shown[k],
    'with rollups ' + JSON.stringify(withRollups.shown[k]) +
    ', reading the orders ' + JSON.stringify(without.shown[k]));
  same('revenue is the same either way', 'rev');
  same('and the order count', 'ord');
  same('and the average order', 'aov');
  same('and the items sold', 'itm');
  check('and the top items table, row for row',
        JSON.stringify(withRollups.shown.top) === JSON.stringify(without.shown.top),
        'with: ' + JSON.stringify(withRollups.shown.top.slice(0, 2)) +
        '  without: ' + JSON.stringify(without.shown.top.slice(0, 2)));
  note('a faster page that reports different money is worse than a slow one');
  check('the figures are not both empty', /[1-9]/.test(withRollups.shown.rev || ''),
        'revenue reads ' + JSON.stringify(withRollups.shown.rev));

  // ---- what it cost
  const bytes = (r) => Object.values(r).reduce((s, e) => s + e.bytes, 0);
  const hist = (r) => (r['orders/history'] || { bytes: 0 }).bytes;
  check('with rollups it does not read the whole order history',
        hist(withRollups.reads) < hist(without.reads),
        'with ' + hist(withRollups.reads) + ' bytes, without ' + hist(without.reads));
  check('and it reads the rollups instead', !!withRollups.reads['orders/daily'],
        Object.keys(withRollups.reads).join(', '));
  note('history read: ' + Math.round(hist(without.reads) / 1024) + 'KB → ' +
       Math.round(hist(withRollups.reads) / 1024) + 'KB, plus ' +
       Math.round((withRollups.reads['orders/daily'] || { bytes: 0 }).bytes / 1024) + 'KB of rollups');

  // ---- the first open builds what every later one uses
  check('an open with no rollups writes them for next time', without.wrote > 1,
        without.wrote + ' days written after reading the history');
  check('and does not roll up today, which is not over',
        without.wrote === Object.keys(ROLLUPS).length,
        without.wrote + ' written, ' + Object.keys(ROLLUPS).length + ' closed days in the fixture');
  note('a rollup written at noon would be wrong all afternoon and never corrected');

  // ---- and the one thing that IS different, said out loud
  check('the transactions card says its rows are a window of the range',
        /most recent/i.test(withRollups.shown.count), JSON.stringify(withRollups.shown.count));
  check('and offers to load the rest', /load them all/i.test(withRollups.shown.count),
        JSON.stringify(withRollups.shown.count));
  note('a rollup cannot answer "find the order with this note in it" — so it says so');

  await browser.close();
  server.close();
  done();
})();
