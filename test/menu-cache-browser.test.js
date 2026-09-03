// The ordering page draws the last menu it saw, then corrects it.
//
// index.html painted in about 140ms and then showed "Loading..." until the
// database answered — measured at 484ms on a 400ms round trip and 956ms on a
// 900ms one. That is most of a second of a customer standing in the café looking
// at a page that was otherwise finished, and it gets worse exactly when the wifi
// is worst. Drawing the previous menu straight from localStorage puts it on
// screen in about 40ms instead, whatever the connection is doing.
//
// WHY THIS IS SAFE HERE AND NOT ON THE TILL
//
// Nothing on this page decides what anyone pays. Every line of a web order is
// re-priced against the live menu at the till before it is booked — reprice.test.js
// is what holds that — and a disagreement raises a banner on the order card and a
// confirmation in front of the cashier. So the worst a stale price can do here is
// show a customer a number the till then corrects out loud.
//
// pos.html is deliberately left alone: there the menu IS what the bill is priced
// from, so a stale one would be a wrong bill rather than a caught one.
//
// What this suite holds is the whole of that bargain: the cache is used, the live
// data always overrides it, a cache too old to trust is ignored, and a damaged one
// cannot stop the page working.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Ordering page — the menu it already knows, then the real one');

const RTDB_MS = 700;          // the round trip this is all about
// This page's own key. It used to be 'ila_cached_menu', which is the TILL's — same
// origin, same name, two different shapes, and the till drew this page's wrapper as if
// it were a menu. See the comment on MENU_CACHE_KEY in index.html.
const CACHE_KEY = 'ila_cust_menu';

const MENU = { Coffee: { 'Latte':  { price: 150, inStock: true, routing: 'barista' },
                         'Mocha':  { price: 200, inStock: true, routing: 'barista' } },
               Food:   { 'Toastie':{ price: 180, inStock: true, routing: 'chef' } } };
// the live menu disagrees with the cached one, which is the case that matters
const LIVE  = { Coffee: { 'Latte':  { price: 165, inStock: true, routing: 'barista' },
                          'Mocha':  { price: 200, inStock: true, routing: 'barista' } },
                Food:   { 'Toastie':{ price: 180, inStock: true, routing: 'chef' } } };

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

// The SDK, stubbed so this suite owns the one thing that matters: how long the
// menu takes to arrive, and what it says when it does.
const stub = (delay, menu) => `
(() => {
  const noop=()=>{}; const chain=()=>new Proxy(function(){},{get:()=>chain(),apply:()=>chain()});
  const snap=v=>({val:()=>v,exists:()=>v!=null,forEach:()=>{},numChildren:()=>v?Object.keys(v).length:0});
  const MENU=${JSON.stringify(menu)}, D=${delay};
  const later=(cb,v)=>setTimeout(()=>{try{cb(snap(v))}catch(e){}},D);
  const db={ref:p=>{const q=String(p==null?'':p);
    return {on:(e,cb)=>{ if(e!=='value') return cb;
        if(q==='menu') later(cb,MENU);
        else if(q==='settings/categoryOrder') later(cb,Object.keys(MENU));
        else if(q==='settings/isOpen') later(cb,true);
        else if(q==='settings/storeStatus') later(cb,{delivery:true,takeaway:true});
        else later(cb,null);
        return cb; },
      off:noop, once:()=>new Promise(r=>setTimeout(()=>r(snap(null)),D)),
      limitToLast:()=>chain(), orderByChild:()=>chain(), push:()=>({key:'k'}),
      set:()=>Promise.resolve(), transaction:(f,cb)=>{if(cb)cb(null,false,snap(null));return Promise.resolve({committed:false});}};},
    goOnline:noop,goOffline:noop};
  window.firebase={initializeApp:noop,apps:[{}],database:Object.assign(()=>db,{ServerValue:{TIMESTAMP:0}}),
    auth:()=>({onAuthStateChanged:cb=>setTimeout(()=>{try{cb({uid:'u1',isAnonymous:true})}catch(e){}},0),
      signInAnonymously:()=>Promise.resolve({}),signOut:()=>Promise.resolve(),currentUser:{uid:'u1'}}),
    messaging:()=>({getToken:()=>Promise.resolve(null),onMessage:noop})};
})();`;

// waitForFunction THROWS on timeout, and a suite that throws reports "failed"
// without saying which expectation was not met. The two regressions this exists to
// catch — the cached render removed, and the live menu no longer overriding it —
// both show up as a wait that never resolves, so every wait here is turned into a
// plain true/false and checked. Written after both of those crashed it silently.
const waitFor = async (tab, fn, ms) => {
  try { await tab.waitForFunction(fn, null, { timeout: ms }); return true; }
  catch (e) { return false; }
};
const rowsNow = (tab) => tab.evaluate(() => document.querySelectorAll('.menu-row,.coffee-row').length);
const priceText = (tab) => tab.evaluate(() =>
  [...document.querySelectorAll('.menu-row')].map(r => r.textContent.replace(/\s+/g, ' ')).join(' | '));

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const threw = [];

  // One context throughout, so localStorage carries between opens the way a
  // returning customer's phone does.
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(stub(RTDB_MS, MENU));
  const open = async () => {
    const tab = await ctx.newPage();
    tab.on('pageerror', e => threw.push(e.message));
    await tab.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await tab.goto(base + '/', { waitUntil: 'commit' });
    return tab;
  };

  // ---- first open: nothing cached, so the menu can only come from the network
  {
    const tab = await open();
    await tab.waitForTimeout(Math.round(RTDB_MS * 0.4));
    const early = await rowsNow(tab);
    check('with nothing cached, the first open has no menu to show early', early === 0, String(early));
    const drew = await waitFor(tab, () => document.querySelectorAll('.menu-row,.coffee-row').length > 0, 8000);
    check('and draws it once the database answers', drew && (await rowsNow(tab)) > 0,
          drew ? '' : 'no menu appeared at all');
    const cached = await tab.evaluate(k => !!localStorage.getItem(k), CACHE_KEY);
    check('and remembers it for next time', cached);
    await tab.close();
  }

  // ---- second open: the menu must be up before the network could possibly answer
  {
    const tab = await open();
    const early = await waitFor(tab, () => document.querySelectorAll('.menu-row,.coffee-row').length > 0,
                                RTDB_MS - 250);
    const at = await tab.evaluate(() => Math.round(performance.now()));
    check('the next open draws the menu without waiting for the database',
          early && at < RTDB_MS - 200,
          early ? ('menu at ' + at + 'ms, round trip is ' + RTDB_MS + 'ms')
                : 'nothing was drawn before the round trip could have answered');
    note('measured on the real page: ~956ms before this, ~40ms after');
    await tab.close();
  }

  // ---- the live menu must win, or a stale price could stand
  {
    const ctx2 = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    // seed the cache with the OLD prices, then serve the NEW ones live
    await ctx2.addInitScript(`try{ localStorage.setItem(${JSON.stringify(CACHE_KEY)},
      JSON.stringify({at: Date.now(), menu: ${JSON.stringify(MENU)}, order: ${JSON.stringify(Object.keys(MENU))}, items: {}})); }catch(e){}`);
    await ctx2.addInitScript(stub(RTDB_MS, LIVE));
    const tab = await ctx2.newPage();
    tab.on('pageerror', e => threw.push(e.message));
    await tab.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await tab.goto(base + '/', { waitUntil: 'commit' });

    const shown = await waitFor(tab, () => document.querySelectorAll('.menu-row').length > 0, 5000);
    const before = shown ? await priceText(tab) : '';
    check('the cached price is what is shown first', shown && /150/.test(before),
          shown ? before.slice(0, 80) : 'nothing was drawn from the cache');

    const replaced = await waitFor(tab, () => /165/.test(document.body.textContent), 8000);
    const after = await priceText(tab);
    check('and the live menu replaces it when it lands',
          replaced && /165/.test(after) && !/(^|\D)150(\D|$)/.test(after),
          replaced ? after.slice(0, 80) : 'the live price never appeared — a stale price would stand');
    note('a stale price is a price the till re-prices — but it must not be the one that stands');
    await ctx2.close();
  }

  // ---- a cache older than the cap is not shown at all
  {
    const ctx3 = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    await ctx3.addInitScript(`try{ localStorage.setItem(${JSON.stringify(CACHE_KEY)},
      JSON.stringify({at: Date.now() - 30*24*60*60*1000, menu: ${JSON.stringify(MENU)}, order: [], items: {}})); }catch(e){}`);
    await ctx3.addInitScript(stub(RTDB_MS, LIVE));
    const tab = await ctx3.newPage();
    tab.on('pageerror', e => threw.push(e.message));
    await tab.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await tab.goto(base + '/', { waitUntil: 'commit' });
    await tab.waitForTimeout(Math.round(RTDB_MS * 0.4));
    const early = await rowsNow(tab);
    check('a month-old cache is not put on screen', early === 0,
          early + ' rows drawn from a cache past the age cap');
    note('the live data would correct it anyway; this is so nobody is shown a menu the café retired');
    await ctx3.close();
  }

  // ---- a damaged cache must not stop the page working
  {
    const ctx4 = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    await ctx4.addInitScript(`try{ localStorage.setItem(${JSON.stringify(CACHE_KEY)}, '{not json'); }catch(e){}`);
    await ctx4.addInitScript(stub(RTDB_MS, LIVE));
    const tab = await ctx4.newPage();
    const errs = [];
    tab.on('pageerror', e => errs.push(e.message));
    await tab.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await tab.goto(base + '/', { waitUntil: 'commit' });
    const opened = await waitFor(tab, () => document.querySelectorAll('.menu-row,.coffee-row').length > 0, 8000);
    check('a corrupted cache is ignored and the page still opens', opened && errs.length === 0,
          errs.length ? errs.join(' | ') : (opened ? '' : 'the page never drew a menu'));
    await ctx4.close();
  }

  await ctx.close();
  check('no page threw while any of that ran', threw.length === 0, threw.join(' | '));
  await browser.close();
  server.close();
  done();
})();
