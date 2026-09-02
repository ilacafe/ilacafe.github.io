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

// The stubs above run a fixed timeline. These two cases need the connection turned
// on and off from the test, because what is under test IS the transition.
const CONTROLLED = (startConnected) => `
(() => {
  const noop=()=>{}; const chain=()=>new Proxy(function(){},{get:()=>chain(),apply:()=>chain()});
  const snap=v=>({val:()=>v,exists:()=>v!=null,forEach:()=>{},numChildren:()=>0,key:null});
  window.__conn={cbs:[],value:${startConnected}};
  window.__setConnected=v=>{window.__conn.value=v;
    window.__conn.cbs.forEach(cb=>{try{cb(snap(v))}catch(e){}});};
  const db={ref:p=>{const q=String(p==null?'':p);return {on:(e,cb)=>{
      if(e==='value'&&q==='.info/connected'){ window.__conn.cbs.push(cb);
        setTimeout(()=>{try{cb(snap(window.__conn.value))}catch(e){}},20); }
      return cb;},
    off:noop, once:()=>new Promise(()=>{}), child:()=>db.ref(q),
    limitToLast:()=>chain(), orderByChild:()=>chain(), push:()=>({key:'k'}),
    set:()=>Promise.resolve(), remove:()=>Promise.resolve(), update:()=>Promise.resolve(),
    transaction:(f,cb)=>{if(cb)cb(null,false,snap(null));return Promise.resolve({committed:false});}};},
   goOnline:noop,goOffline:noop};
  window.firebase={initializeApp:noop,apps:[{}],database:Object.assign(()=>db,{ServerValue:{TIMESTAMP:0,increment:n=>n}}),
    auth:()=>({onAuthStateChanged:cb=>setTimeout(()=>{try{cb({uid:'u1'})}catch(e){}},0),
      signInWithEmailAndPassword:()=>Promise.resolve({}),signOut:()=>Promise.resolve(),currentUser:{uid:'u1'}}),
    messaging:()=>({getToken:()=>Promise.resolve(null),onMessage:noop})};
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
    // This one REMEMBERS the writes. Answering them and forgetting them meant nothing
    // could ask the question that actually matters offline — not "did a tap register"
    // but "did the order go anywhere". The real SDK holds these in memory and flushes
    // them on reconnect, which is the SDK's job and not what is under test; whether
    // pos.html gets far enough to issue them at all, with no connection, is.
    await off.addInitScript(`
      (() => {const noop=()=>{};const chain=()=>new Proxy(function(){},{get:()=>chain(),apply:()=>chain()});
       const snap=v=>({val:()=>v,exists:()=>v!=null,forEach:()=>{},numChildren:()=>0,key:null});
       window.__writes=[];
       const rec=(op,p)=>{window.__writes.push(op+' '+p);return Promise.resolve();};
       const mk=p=>{const q=String(p==null?'':p);const s={
         key:'k'+window.__writes.length,
         on:(e,cb)=>{ if(e==='value'&&q==='.info/connected')setTimeout(()=>{try{cb(snap(false))}catch(e){}},30);
           return cb;},
         off:noop,once:()=>new Promise(()=>{}),child:c=>mk(q+'/'+c),
         orderByChild:()=>s,orderByKey:()=>s,limitToLast:()=>s,limitToFirst:()=>s,
         startAt:()=>s,endAt:()=>s,equalTo:()=>s,
         push:v=>{if(v!==undefined)rec('push',q);const n=mk(q+'/pushed');n.key='k'+window.__writes.length;return n;},
         set:()=>rec('set',q),update:()=>rec('update',q),remove:()=>rec('remove',q),
         transaction:(f,cb)=>{rec('transaction',q);if(cb)cb(null,true,snap(null));
           return Promise.resolve({committed:true,snapshot:snap(null)});}};return s;};
       const db={ref:p=>mk(p||''),goOnline:noop,goOffline:noop};
       window.firebase={initializeApp:noop,apps:[{}],database:Object.assign(()=>db,{ServerValue:{TIMESTAMP:1756200000000,increment:n=>({'.sv':{increment:n}})}}),
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

    // "Takes an order" is not the same as "works". A till with a cart it cannot send
    // is no more use than one that cannot take the order — so this drives the rest of
    // the sale: a second item routed to a DIFFERENT station, the send, and the bill.
    const sale = await otab.evaluate(async () => {
      const btns = [...document.querySelectorAll('.swap-container [data-add], .add-btn[data-add]')];
      if (btns[1]) btns[1].click();                       // the Toastie — chef, not barista
      await new Promise(r => requestAnimationFrame(r));
      window.__writes = [];
      let threw = null;
      try { window.sendOrder('5'); } catch (e) { threw = String(e.message); }
      await new Promise(r => setTimeout(r, 300));
      const afterSend = window.__writes.slice();
      window.__writes = [];
      try {
        const t = window.activeTables['5'];
        window.settleTablePayment('5', t.total, 'Cash', {}, () => {});
      } catch (e) { threw = threw || String(e.message); }
      await new Promise(r => setTimeout(r, 400));
      return { threw, afterSend, afterSettle: window.__writes.slice(),
               table: JSON.parse(JSON.stringify(window.activeTables['5'] || null)) };
    });

    const toKitchen = (sale.afterSend || []).filter(w => /orders\/active\//.test(w));
    check('an order taken offline still reaches the kitchen, at both stations',
          !sale.threw && toKitchen.length === 2, sale.threw || toKitchen.join(', ') || 'nothing was sent');
    note('routing comes off the cached menu too — a ticket with no station is a lost ticket');

    check('and lands on the table, item by item',
          (sale.afterSend || []).some(w => /pos\/activeTables\/5\/items\//.test(w)) &&
          sale.table && sale.table.total === 330,
          JSON.stringify({ table: sale.table, wrote: sale.afterSend }));

    check('and the bill still settles',
          (sale.afterSettle || []).some(w => /transaction pos\/activeTables\/5/.test(w)),
          JSON.stringify(sale.afterSettle));
    note('the SDK holds these until the wifi is back; the till must still get far enough to issue them');

    await off.close();
  }

  // ------------------------------------------------- THE WIFI IS SIMPLY OFF
  // Making the quiet path the default puts the loud ones at risk, and this is the
  // one with nothing else holding it up. A till whose wifi is switched off does not
  // have to be waited for: navigator.onLine false means there is no network
  // interface at all, so the run-up is skipped and the counter is working from cache
  // within a frame or two. Delete that one clause and every other check in this repo
  // still passes while a wifi-off open silently becomes a five second stare.
  {
    const dark = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true });
    await dark.addInitScript(`try{
      localStorage.setItem('ila.role.v1', JSON.stringify({uid:'u1',role:'cashier',name:'T'}));
      localStorage.setItem('ila_cached_menu', ${JSON.stringify(JSON.stringify(CACHED))});
      localStorage.setItem('ila_cached_category_order', ${JSON.stringify(JSON.stringify(Object.keys(CACHED)))});
      localStorage.setItem('ila_cached_item_order', '{}');
      localStorage.removeItem('ila_pos_cart');
    }catch(e){}`);
    await dark.addInitScript(`Object.defineProperty(navigator,'onLine',{get:()=>false,configurable:true});`);
    await dark.addInitScript(CONTROLLED(false));      // and the socket never comes up
    const dtab = await dark.newPage();
    dtab.on('pageerror', e => threw.push('wifi-off: ' + String(e.message).split('\n')[0]));
    dtab.on('dialog', d => d.dismiss().catch(() => {}));
    await dtab.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await dtab.goto(base + '/pos.html', { waitUntil: 'commit' });

    const said = await waitFor(dtab,
      () => getComputedStyle(document.getElementById('offline-indicator')).display !== 'none', 2000);
    const when = await dtab.evaluate(() => Math.round(performance.now()));
    check('a till whose wifi is off says so at once, without serving out the run-up',
          said && when < 2000, said ? ('OFFLINE at ' + when + 'ms; the run-up is 5000ms')
                                    : 'it never said it was offline');
    const works = await dtab.evaluate(() => {
      const btn = document.querySelector('.swap-container [data-add], .add-btn[data-add]');
      if (btn) btn.click();
      return { cartLines: Object.keys(window.cart || {}).length, total: window.totalAmount || 0 };
    });
    check('and is taking orders from the cached menu straight away',
          works.cartLines === 1 && works.total === 150, JSON.stringify(works));
    note('the device already knows the answer; there is nothing to wait for');
    await dark.close();
  }

  // ------------------------------------------------ AND LOSING IT MID-SERVICE
  // The case the offline chip exists for, and the one the quiet boot must not have
  // touched: a till that has been working all morning and loses the wifi at eleven.
  // That is a fault from the moment it happens — nothing is still "opening" — so it
  // is said immediately, not after a run-up. The suite tested a till that opens with
  // no connection and never tested this, which is the wrong way round: this is the
  // one that happens during service, with a queue.
  {
    const mid = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true });
    await mid.addInitScript(`try{
      localStorage.setItem('ila.role.v1', JSON.stringify({uid:'u1',role:'cashier',name:'T'}));
      localStorage.setItem('ila_cached_menu', ${JSON.stringify(JSON.stringify(CACHED))});
      localStorage.setItem('ila_cached_category_order', ${JSON.stringify(JSON.stringify(Object.keys(CACHED)))});
      localStorage.setItem('ila_cached_item_order', '{}');
      localStorage.removeItem('ila_pos_cart');
    }catch(e){}`);
    await mid.addInitScript(CONTROLLED(true));        // a till that is up and serving
    const mtab = await mid.newPage();
    mtab.on('pageerror', e => threw.push('mid-service: ' + String(e.message).split('\n')[0]));
    mtab.on('dialog', d => d.dismiss().catch(() => {}));
    await mtab.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await mtab.goto(base + '/pos.html', { waitUntil: 'commit' });
    await mtab.waitForTimeout(600);

    const quietWhileUp = await mtab.evaluate(
      () => getComputedStyle(document.getElementById('offline-indicator')).display === 'none');
    check('a connected till shows no offline chip', quietWhileUp);

    // Eleven o'clock. The wifi goes.
    const lost = await mtab.evaluate(() => { window.__setConnected(false); return Math.round(performance.now()); });
    const appeared = await waitFor(mtab,
      () => getComputedStyle(document.getElementById('offline-indicator')).display !== 'none', 1500);
    const at = await mtab.evaluate(() => Math.round(performance.now()));
    check('and says so the moment it goes — no run-up once it has been connected',
          appeared && (at - lost) < 1000,
          appeared ? ('OFFLINE ' + (at - lost) + 'ms after the drop') : 'the chip never appeared');
    note('the run-up is for a connection being opened, never for one that was working');

    // And it clears again, or the next quiet ten minutes reads as an outage.
    await mtab.evaluate(() => window.__setConnected(true));
    const cleared = await waitFor(mtab,
      () => getComputedStyle(document.getElementById('offline-indicator')).display === 'none', 1500);
    check('and takes it down again when the wifi returns', cleared,
          'the chip outlived the outage');
    await mid.close();
  }

  check('no page threw while any of that ran', threw.length === 0, threw.join(' | '));
  await browser.close();
  server.close();
  done();
})();
