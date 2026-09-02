// The till shows the menu it already knows, and refuses to price anything with it.
//
// pos.html painted in about 200ms and then had an empty menu until the database
// answered — 492ms on a 400ms round trip, 968ms on a 900ms one. Every open of
// every shift began with the counter looking at nothing.
//
// index.html solves this by simply drawing the cached menu, and that is safe there
// because nothing on that page decides what anyone pays: a web order is re-priced
// against the live menu at the till before it is booked. Here the menu IS what the
// bill is priced from. A stale price is a wrong bill rather than a caught one, so
// the cache is shown and not trusted.
//
// There are exactly two ways a price reaches money on this page, and this suite
// exists to prove the cached menu can reach neither:
//
//   the add handler, which takes its price off the tapped button. It refuses while
//   the menu is provisional, in JavaScript — not by dimming, which can be overridden.
//
//   web-order acceptance, which re-prices from window.itemPriceMap. buildMenuMaps is
//   not called for a cached menu, so that map stays empty, and the accept path
//   already refuses on an empty map and says the menu has not loaded. That guard
//   keeps working without knowing any of this exists — which is why it is checked
//   here rather than assumed.
//
// The last check is the one that matters most: after the live menu lands, a price
// that CHANGED must be the live one, and the till must be fully usable again.
//
// The second half of the suite is about the OTHER cost of showing a cached menu:
// how much the till says while it is doing it. A restart that announces itself —
// OFFLINE MODE, then "last known menu — prices loading…" — feels slow no matter how
// fast it is, and a normal restart has nothing to report. So the refresh is silent,
// and each message has to earn its way onto the screen: the note when a tap is
// actually refused, OFFLINE MODE when connecting has actually failed.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('The till’s menu — shown from cache, priced only when live');

const RTDB_MS = 900;
const CACHED = { Coffee: { 'Latte': { price: 150, inStock: true, routing: 'barista' } },
                 Food:   { 'Toastie': { price: 180, inStock: true, routing: 'chef' } } };
const LIVE   = { Coffee: { 'Latte': { price: 165, inStock: true, routing: 'barista' } },
                 Food:   { 'Toastie': { price: 180, inStock: true, routing: 'chef' } } };

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

// The connect delay is not decoration. `.info/connected` is false for the first
// moment of EVERY load while the socket is opened, and this stub used to report
// true at 0ms — a sequence no real device produces. That hid the thing this suite
// is now also about: on a real cold start the offline branch fired on that first
// false, put OFFLINE MODE on screen and lifted the provisional guard, within a tick
// of every single open.
const stub = (delay, menu, connectAt = 400) => `
(() => {
  const noop=()=>{}; const chain=()=>new Proxy(function(){},{get:()=>chain(),apply:()=>chain()});
  const snap=v=>({val:()=>v,exists:()=>v!=null,forEach:()=>{},numChildren:()=>v?Object.keys(v).length:0});
  const MENU=${JSON.stringify(menu)}, D=${delay};
  const later=(cb,v)=>setTimeout(()=>{try{cb(snap(v))}catch(e){}},D);
  const db={ref:p=>{const q=String(p==null?'':p);
    return {on:(e,cb)=>{ if(e!=='value') return cb;
        if(q==='menu') later(cb,MENU);
        else if(q==='settings/categoryOrder') later(cb,Object.keys(MENU));
        else if(q==='.info/connected'){ setTimeout(()=>{try{cb(snap(false))}catch(e){}},0);
                                        setTimeout(()=>{try{cb(snap(true))}catch(e){}},${connectAt}); }
        else later(cb,null);
        return cb; },
      off:noop, once:()=>new Promise(r=>setTimeout(()=>r(snap(q.indexOf('users/')===0?{role:'cashier',name:'T'}:null)),0)),
      limitToLast:()=>chain(), orderByChild:()=>chain(), push:()=>({key:'k'}),
      set:()=>Promise.resolve(), remove:()=>Promise.resolve(), update:()=>Promise.resolve(),
      transaction:(f,cb)=>{if(cb)cb(null,false,snap(null));return Promise.resolve({committed:false});}};},
    goOnline:noop,goOffline:noop};
  window.firebase={initializeApp:noop,apps:[{}],database:Object.assign(()=>db,{ServerValue:{TIMESTAMP:0}}),
    auth:()=>({onAuthStateChanged:cb=>setTimeout(()=>{try{cb({uid:'u1'})}catch(e){}},0),
      signInWithEmailAndPassword:()=>Promise.resolve({}),signOut:()=>Promise.resolve(),currentUser:{uid:'u1'}}),
    messaging:()=>({getToken:()=>Promise.resolve(null),onMessage:noop})};
  try{ localStorage.setItem('ila.role.v1', JSON.stringify({uid:'u1',role:'cashier',name:'T'})); }catch(e){}
})();`;

const waitFor = async (tab, fn, ms) => {
  try { await tab.waitForFunction(fn, null, { timeout: ms }); return true; } catch (e) { return false; }
};
const rows = (tab) => tab.evaluate(() => document.querySelectorAll('.menu-row,.coffee-row').length);

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const threw = [];

  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1024, height: 900 } });
  // seed the cache with the OLD price, then serve the NEW one live
  await ctx.addInitScript(`try{
    localStorage.setItem('ila_cached_menu', ${JSON.stringify(JSON.stringify(CACHED))});
    localStorage.setItem('ila_cached_category_order', ${JSON.stringify(JSON.stringify(Object.keys(CACHED)))});
    localStorage.setItem('ila_cached_item_order', '{}');
    localStorage.removeItem('ila_pos_cart');
  }catch(e){}`);
  await ctx.addInitScript(stub(RTDB_MS, LIVE));
  const tab = await ctx.newPage();
  tab.on('pageerror', e => threw.push(e.message));
  tab.on('dialog', d => d.dismiss().catch(() => {}));      // the accept path alerts; don't hang on it
  await tab.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
  await tab.goto(base + '/pos.html', { waitUntil: 'commit' });

  // ---- the menu is up long before the database could have answered
  const early = await waitFor(tab, () => document.querySelectorAll('.menu-row,.coffee-row').length > 0,
                              RTDB_MS - 300);
  const at = await tab.evaluate(() => Math.round(performance.now()));
  check('the till draws its last known menu without waiting for the database',
        early && at < RTDB_MS - 250,
        early ? ('menu at ' + at + 'ms, round trip is ' + RTDB_MS + 'ms')
              : 'nothing was drawn before the round trip could have answered');
  note('measured on the real page: ~968ms before this, ~50ms after');

  // ---- it knows the menu is not live, and does not go on about it
  const marked = await tab.evaluate(() => ({
    flag: window.menuIsProvisional === true,
    cls: document.getElementById('live-menu-container').classList.contains('menu-provisional'),
    noteShown: getComputedStyle(document.getElementById('provisional-note')).display !== 'none',
    offlineShown: getComputedStyle(document.getElementById('offline-indicator')).display !== 'none',
  }));
  check('and knows it is not live, in the flag and the class', marked.flag && marked.cls,
        JSON.stringify(marked));
  check('but says nothing about it — a refresh that narrates itself feels slow',
        !marked.noteShown && !marked.offlineShown, JSON.stringify(marked));
  note('the counter is looking at a full menu half a second in; being told so helps nobody');

  // ---- THE POINT: a cached price cannot reach a cart
  const tapped = await tab.evaluate(() => {
    const btn = document.querySelector('.swap-container [data-add], .add-btn[data-add]');
    if (!btn) return { noButton: true };
    btn.click();
    return { clicked: true, cartLines: Object.keys(window.cart || {}).length,
             total: window.totalAmount || 0 };
  });
  check('tapping an item while the menu is provisional adds nothing to the cart',
        !tapped.noButton && tapped.cartLines === 0 && tapped.total === 0,
        JSON.stringify(tapped));
  note('the refusal is in the click handler; dimming alone would be a suggestion, not a guarantee');

  // A silent refusal is a dead button. The note is what turns one into the other, so
  // it has to arrive with the tap and not before it.
  const explained = await tab.evaluate(() => {
    const n = document.getElementById('provisional-note');
    return { shown: getComputedStyle(n).display !== 'none', text: (n.textContent || '').trim() };
  });
  check('and the refusal explains itself the moment it happens', explained.shown,
        JSON.stringify(explained));

  // ---- and cannot reach the web-order re-pricing map either
  const priced = await tab.evaluate(() => ({
    map: Object.keys(window.itemPriceMap || {}).length,
    routing: Object.keys(window.itemRoutingMap || {}).length,
  }));
  check('and the re-pricing map stays empty, so web orders are held not mispriced',
        priced.map === 0, JSON.stringify(priced));
  note('that empty map is what pos.html already refuses on — the existing guard does the work');

  // ---- the live menu lands: everything becomes live, at the live price
  const live = await waitFor(tab, () => window.menuIsProvisional === false, RTDB_MS + 4000);
  check('the live menu clears the provisional state', live);

  const after = await tab.evaluate(() => ({
    priced: (window.itemPriceMap || {})['Latte'],
    cls: document.getElementById('live-menu-container').classList.contains('menu-provisional'),
    noteShown: getComputedStyle(document.getElementById('provisional-note')).display !== 'none',
    shown: document.body.textContent.includes('165'),
    stale: /(^|\D)150(\D|$)/.test(document.getElementById('live-menu-container').textContent),
  }));
  check('the price the till now holds is the live one, not the cached one',
        after.priced === 165 && !after.stale && after.shown, JSON.stringify(after));
  check('and the menu no longer says it is provisional', !after.cls && !after.noteShown,
        JSON.stringify(after));

  // ---- and the till takes an order again
  const nowWorks = await tab.evaluate(async () => {
    const btn = document.querySelector('.swap-container [data-add], .add-btn[data-add]');
    if (!btn) return { noButton: true };
    btn.click();
    await new Promise(r => requestAnimationFrame(r));
    return { cartLines: Object.keys(window.cart || {}).length, total: window.totalAmount || 0 };
  });
  check('a tap works again once the menu is live, at the live price',
        !nowWorks.noButton && nowWorks.cartLines === 1 && nowWorks.total === 165,
        JSON.stringify(nowWorks));

  await ctx.close();

  // ------------------------------------------------------------ A RESTART
  // The complaint that produced this block, in the words it arrived in: "When POS
  // restarts it shows offline and last known menu, prices loading. It is irritating."
  //
  // Both were true, and both were the till describing a boot that was going fine.
  // `.info/connected` is false for the first moment of every load, so OFFLINE MODE
  // went up at ~140ms and came down again when the socket opened; the note went up
  // with the cached menu at ~110ms and came down when the live one landed. Three
  // announcements — the global connection bar joins in on a slow connect — for a
  // restart that had nothing wrong with it.
  //
  // Checking the end state cannot catch this: by the time anything has settled, all
  // of it has already cleared. So this watches every frame from the first one, and
  // the assertion is about what was ever on screen, not what is on screen now.
  {
    const quiet = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true });
    await quiet.addInitScript(`try{
      localStorage.setItem('ila_cached_menu', ${JSON.stringify(JSON.stringify(CACHED))});
      localStorage.setItem('ila_cached_category_order', ${JSON.stringify(JSON.stringify(Object.keys(CACHED)))});
      localStorage.setItem('ila_cached_item_order', '{}');
      localStorage.removeItem('ila_pos_cart');
    }catch(e){}`);
    // A perfectly ordinary restart: socket open in 700ms, menu 150ms behind it.
    await quiet.addInitScript(stub(850, LIVE, 700));
    const qtab = await quiet.newPage();
    qtab.on('pageerror', e => threw.push('restart: ' + String(e.message).split('\n')[0]));
    qtab.on('dialog', d => d.dismiss().catch(() => {}));
    await qtab.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await qtab.goto(base + '/pos.html', { waitUntil: 'commit' });

    // Installed on commit, before the page's own scripts have run.
    await qtab.evaluate(() => {
      window.__said = [];
      const vis = (el) => { if (!el) return false; const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
        const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      (function tick() {
        [['the offline chip', 'offline-indicator'],
         ['the prices-loading note', 'provisional-note'],
         ['the connection bar', 'ila-offline-bar']].forEach(([what, id]) => {
          if (vis(document.getElementById(id)) && window.__said.indexOf(what) < 0) window.__said.push(what);
        });
        requestAnimationFrame(tick);
      })();
    });

    const wentLive = await waitFor(qtab, () => window.menuIsProvisional === false, 6000);
    const said = await qtab.evaluate(() => window.__said);
    check('a restart on a working connection reaches the live menu', wentLive);
    check('and gets there without saying one word about it', said.length === 0,
          said.length ? 'it said: ' + said.join(', ') : '');
    note('before this: “the offline chip, the prices-loading note” on every single open');
    await quiet.close();
  }

  // ---------------------------------------------------------------- OFFLINE
  // The till must still take orders with no connection. This is not a nice-to-have
  // on this page: a counter mid-service whose wifi has gone is the case the offline
  // branch exists for, and it works from this same cached menu.
  //
  // Showing the cache without trusting it nearly broke that. The provisional flag
  // was cleared only by the live menu listener — and a till that OPENS while
  // disconnected never receives that listener at all, so nothing would ever clear
  // it. Menu on screen, price map populated, OFFLINE showing, and every tap
  // refused, for as long as the wifi stayed down. It was caught by being asked
  // whether the till still worked offline, not by anything here, which is why it is
  // here now.
  {
    const off = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1024, height: 900 } });
    await off.addInitScript(`try{
      localStorage.setItem('ila.role.v1', JSON.stringify({uid:'u1',role:'cashier',name:'T'}));
      localStorage.setItem('ila_cached_menu', ${JSON.stringify(JSON.stringify(CACHED))});
      localStorage.setItem('ila_cached_category_order', ${JSON.stringify(JSON.stringify(Object.keys(CACHED)))});
      localStorage.setItem('ila_cached_item_order', '{}');
      localStorage.removeItem('ila_pos_cart');
    }catch(e){}`);
    // .info/connected answers false and NOTHING else ever answers — which is what a
    // disconnected Realtime Database actually does. No menu listener, ever.
    await off.addInitScript(`
      (() => {const noop=()=>{};const chain=()=>new Proxy(function(){},{get:()=>chain(),apply:()=>chain()});
       const snap=v=>({val:()=>v,exists:()=>v!=null,forEach:()=>{},numChildren:()=>0});
       const db={ref:p=>{const q=String(p==null?'':p);return {on:(e,cb)=>{
           if(e==='value'&&q==='.info/connected')setTimeout(()=>{try{cb(snap(false))}catch(e){}},30);
           return cb;},
         off:noop,once:()=>new Promise(()=>{}),
         limitToLast:()=>chain(),orderByChild:()=>chain(),push:()=>({key:'k'}),
         set:()=>Promise.resolve(),remove:()=>Promise.resolve(),update:()=>Promise.resolve(),
         transaction:(f,cb)=>{if(cb)cb(null,false,snap(null));return Promise.resolve({committed:false});}};},
        goOnline:noop,goOffline:noop};
       window.firebase={initializeApp:noop,apps:[{}],database:Object.assign(()=>db,{ServerValue:{TIMESTAMP:0}}),
        auth:()=>({onAuthStateChanged:cb=>setTimeout(()=>{try{cb({uid:'u1'})}catch(e){}},0),
         signInWithEmailAndPassword:()=>Promise.resolve({}),signOut:()=>Promise.resolve(),currentUser:{uid:'u1'}}),
        messaging:()=>({getToken:()=>Promise.resolve(null),onMessage:noop})};})();`);

    const otab = await off.newPage();
    otab.on('pageerror', e => threw.push('offline: ' + e.message));
    otab.on('dialog', d => d.dismiss().catch(() => {}));
    await otab.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await otab.goto(base + '/pos.html', { waitUntil: 'commit' });

    const drew = await waitFor(otab, () => document.querySelectorAll('.menu-row').length > 0, 8000);
    check('a till that opens with no connection still gets its menu', drew,
          drew ? '' : 'no menu was drawn at all');

    // Wait for the offline branch to have RUN, rather than assuming it already has.
    // The cached menu is drawn from a microtask within about 50ms, well before
    // .info/connected has reported anything — so checking straight after the rows
    // appear catches the page mid-boot and fails a page that is perfectly fine. It
    // did exactly that on the first run of this block.
    const wentOffline = await waitFor(otab,
      () => getComputedStyle(document.getElementById('offline-indicator')).display !== 'none', 8000);
    check('and says it is offline', wentOffline,
          wentOffline ? '' : 'the offline indicator never appeared');

    const state = await otab.evaluate(() => {
      const btn = document.querySelector('.swap-container [data-add], .add-btn[data-add]');
      if (btn) btn.click();
      return { provisional: window.menuIsProvisional,
               offlineShown: getComputedStyle(document.getElementById('offline-indicator')).display !== 'none',
               priceMap: Object.keys(window.itemPriceMap || {}).length,
               cartLines: Object.keys(window.cart || {}).length,
               total: window.totalAmount || 0 };
    });
    check('and can still take an order — the whole point of the offline path',
          state.cartLines === 1 && state.total === 150, JSON.stringify(state));
    check('because offline deliberately trusts the cached menu, flag and price map together',
          state.provisional === false && state.priceMap > 0, JSON.stringify(state));
    note('online the truth is half a second away; offline the cache is all there is');
    await off.close();
  }

  check('no page threw while any of that ran', threw.length === 0, threw.join(' | '));
  await browser.close();
  server.close();
  done();
})();
