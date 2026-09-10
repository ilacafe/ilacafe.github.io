// The app draws itself before the SDK arrives.
//
// A cold start on café wifi paints the shell at about half a second and then has
// NOTHING on it until the till reaches 3.4 seconds. Almost all of that gap is one
// thing: every page's own script sits below three Firebase bundles, the better part of
// 400KB, and cannot run until they have arrived and compiled. On an installed iPhone
// or iPad the whole stretch is the launch screen, which is black — so what the café
// reported as "black screen then the app" is mostly this.
//
// connection.js runs ABOVE those tags, so ilaLastScreen.paint() puts the markup the
// page really drew last time back on screen while the SDK is still on the wire.
//
// This proves the property rather than the mechanism: with the database answering
// NOTHING AT ALL, a device that has used the app before still has its menu on screen.
// If that holds, what is on screen cannot have come off the network.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('The last screen — drawn before the SDK, and without the database');

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json',
                '.png':'image/png', '.webmanifest':'application/manifest+json' };
const server = http.createServer((req,res)=>{
  const u = new URL(req.url,'http://x');
  const f = path.join(ROOT, u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('no');}
  res.writeHead(200,{'Content-Type':TYPES[path.extname(f)]||'application/octet-stream'});
  res.end(fs.readFileSync(f));
});

const MENU = { Coffee: { Latte:{price:120,inStock:true}, Cortado:{price:110,inStock:true} },
               Food:   { Toastie:{price:180,inStock:true} } };

// A database that answers, until the page itself says otherwise. The switch is a
// localStorage key so it survives into the second open of the same device, which is
// the only way to turn the network off BETWEEN two opens rather than during one.
const STUB = `(() => {
  const MENU = ${JSON.stringify(MENU)};
  const snap = v => ({ val:()=>v, numChildren:()=>0, forEach(){}, exists:()=>v!=null });
  let on = true;
  try { on = localStorage.getItem('__ila_test_offline') !== '1'; } catch(e){}
  const val = p => (on && p === 'menu') ? MENU : null;
  const ref = p => ({
    on:(e,cb)=>{ if(e==='value'&&on) setTimeout(()=>{try{cb(snap(val(p)))}catch(x){}},20); return cb; },
    once:()=> on ? Promise.resolve(snap(val(p))) : new Promise(()=>{}),
    off(){}, child:k=>ref(p+'/'+k), orderByChild:()=>ref(p), orderByKey:()=>ref(p),
    startAt:()=>ref(p), limitToLast:()=>ref(p), push:()=>({key:'k'}),
    set:()=>Promise.resolve(), update:()=>Promise.resolve(), remove:()=>Promise.resolve(),
    transaction:(f,cb)=>{ if(cb) cb(null,false,snap(null)); return Promise.resolve({committed:false}); } });
  window.__stub = true;
  window.__initCalled = false;
  window.firebase = { initializeApp(){ window.__initCalled = true; }, database: Object.assign(()=>({ ref, goOnline(){}, goOffline(){} }),
      { ServerValue:{ TIMESTAMP:0, increment:n=>n } }),
    auth:()=>({ onAuthStateChanged(cb){ setTimeout(()=>{try{cb({uid:'u'})}catch(x){}},10); },
      signInAnonymously:()=>Promise.resolve({user:{uid:'u'}}), signOut:()=>Promise.resolve(),
      currentUser:{uid:'u'} }) };
})();`;

const PAGES = [
  { page: 'pos.html',   rows: '.menu-row,.coffee-row' },
  { page: 'index.html', rows: '.menu-row,.coffee-row' },
];

(async () => {
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const base = 'http://127.0.0.1:'+server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE)?{executablePath:PRE}:{});

  for (const { page, rows } of PAGES) {
    // ONE context is one device. Two contexts would be two devices, and would prove
    // the opposite of what this is about.
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    await ctx.addInitScript(STUB);
    // THE SDK IS HELD, NOT BLOCKED, ON THE SECOND OPEN.
    //
    // Blocking it fails the tag, and a failed script does not stop the parser — the
    // page's own code runs anyway and draws the menu out of its own cache, which is a
    // different mechanism that already existed. This suite passed with the early paint
    // deleted for exactly that reason, which made it worth nothing.
    //
    // Held, the parser stops at the tag and everything below it — the whole of the
    // page's own script — never runs. Anything on screen then can only have been put
    // there by the tag ABOVE the SDK, which is the thing under test.
    // Playwright matches routes LAST-registered-first, so the catch-all goes on first
    // and the SDK handler on top of it. The other way round the catch-all swallows
    // gstatic, aborts it, and the hold never happens — which is how an earlier version
    // of this suite came to be measuring nothing.
    let stall = false;
    await ctx.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await ctx.route('https://www.gstatic.com/firebasejs/**', async (r) => {
      if (!stall) return r.abort().catch(() => {});
      await new Promise(res => setTimeout(res, 20000));
      return r.abort().catch(() => {});
    });

    const a = await ctx.newPage();
    a.on('dialog', d => d.dismiss().catch(()=>{}));
    await a.goto(base + '/' + page, { waitUntil:'load' });
    const drew = await a.waitForFunction(s => document.querySelectorAll(s).length > 0, rows, { timeout: 15000 })
                        .then(() => true).catch(() => false);
    check(page + ' draws its menu while the database is answering', drew);
    await a.waitForTimeout(600);                          // it stores the finished menu
    const kept = await a.evaluate(() => { try { return !!localStorage.getItem('ila.lastscreen.v1'); } catch(e){ return false; } });
    check('and keeps what it drew', kept);
    await a.evaluate(() => localStorage.setItem('__ila_test_offline','1'));   // the network goes
    await a.close();

    stall = true;
    const b = await ctx.newPage();
    b.on('dialog', d => d.dismiss().catch(()=>{}));
    await b.goto(base + '/' + page, { waitUntil:'commit' });
    const showed = await b.waitForFunction(s => document.querySelectorAll(s).length > 0, rows, { timeout: 12000 })
                          .then(() => true).catch(() => false);
    // The page's own script calls firebase.initializeApp on its first working line,
    // so this is exactly "did the code below the SDK get to run".
    const ran = await b.evaluate(() => window.__initCalled === true);
    check('and has it on screen with the SDK still on the wire', showed,
          'nothing drawn while the SDK was held');
    check('with the page\u2019s own script not having run at all', !ran,
          'the page script ran, so this proves nothing about the early paint');
    await b.close();
    await ctx.close();
  }
  note('nothing answered, so what is on screen came off the device — which is why it is instant');

  await browser.close();
  server.close();
  done();
})();
