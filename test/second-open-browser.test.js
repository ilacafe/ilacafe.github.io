// The second open, which is the one that used to be slow.
//
// "Sometimes it opens instantly, other times a white screen and then the app" was
// reported from the floor for months and never reproduced, because it is not
// intermittent — it was the SECOND open of any page, every time, and whoever was
// testing had already opened it three times.
//
// The shape of it, before this was fixed:
//
//   open 1  nothing controls the page, so every file goes to the network and the
//           worker — registered at the foot of the page — installs after they have
//           all been and gone. It saw none of them and cached nothing.
//   open 2  it is controlling now, so it sees them, and every one is a MISS. Each
//           falls through to the network with the page blank until it lands.
//   open 3  hits, and it is instant from here on.
//
// So this suite is about open 2 and nothing else. It asserts the page's own document
// comes out of the cache rather than off the wire, which is the difference between
// the two things the report described.
//
// It is a browser suite because none of it can be read off the source: sw.js can be
// inspected all day and it will not say when the worker starts seeing requests.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('The second open — served, not downloaded again');

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json',
                '.png':'image/png', '.webmanifest':'application/manifest+json' };
const server = http.createServer((req,res)=>{
  const u = new URL(req.url,'http://x');
  const f = path.join(ROOT, u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('no');}
  res.writeHead(200,{'Content-Type':TYPES[path.extname(f)]||'application/octet-stream'});
  res.end(fs.readFileSync(f));
});

// Enough of a database for the pages to run without throwing. What is measured here
// is where the DOCUMENT came from, which happens long before any of this matters.
const STUB = `(() => {
  const snap = v => ({ val: () => v, numChildren: () => 0, forEach(){}, exists: () => v != null });
  const ref = () => ({ on: (e,cb) => { if (e==='value') setTimeout(()=>{try{cb(snap(null))}catch(x){}},0); return cb; },
    once: () => Promise.resolve(snap(null)), off(){}, child: ref, orderByChild: ref, orderByKey: ref,
    startAt: ref, limitToLast: ref, push: () => ({ key: 'k' }), set: () => Promise.resolve(),
    update: () => Promise.resolve(), remove: () => Promise.resolve(),
    transaction: (f,cb) => { if(cb) cb(null,false,snap(null)); return Promise.resolve({committed:false}); } });
  window.firebase = { initializeApp(){}, database: Object.assign(() => ({ ref, goOnline(){}, goOffline(){} }),
      { ServerValue: { TIMESTAMP: 0, increment: n => n } }),
    auth: () => ({ onAuthStateChanged(cb){ setTimeout(()=>{try{cb(null)}catch(x){}},0); },
      signInAnonymously: () => Promise.resolve({ user: { uid: 'u' } }), signOut: () => Promise.resolve(),
      currentUser: null }) };
})();`;

// How many bytes the navigation itself pulled. 0 is the worker answering it.
const transfer = (tab) => tab.evaluate(() => {
  const n = performance.getEntriesByType('navigation')[0];
  return n ? n.transferSize : -1;
});

(async () => {
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const base = 'http://127.0.0.1:'+server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE)?{executablePath:PRE}:{});

  // One page per role, so a change that helps the till and forgets the kitchen fails.
  for (const page of ['index.html', 'pos.html', 'chef.html', 'admin.html', 'inventory.html']) {
    // One context is one device: same profile, same cache, opened twice.
    const ctx = await browser.newContext({ serviceWorkers: 'allow' });
    await ctx.addInitScript(STUB);
    await ctx.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());

    const first = await ctx.newPage();
    first.on('dialog', d => d.dismiss().catch(()=>{}));
    await first.goto(base + '/' + page, { waitUntil: 'load' });
    // The worker installs and claims at the foot of the page; give it that long.
    await first.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 })
               .catch(() => {});
    await first.waitForTimeout(1500);
    await first.close();

    const second = await ctx.newPage();
    second.on('dialog', d => d.dismiss().catch(()=>{}));
    await second.goto(base + '/' + page, { waitUntil: 'load' });
    const bytes = await transfer(second);
    check(page + ' comes out of the cache on the second open', bytes === 0,
          'the navigation pulled ' + bytes + ' bytes — the worker did not answer it');
    await second.close();
    await ctx.close();
  }
  note('open 1 cannot be helped: nothing is on the device yet. Open 2 is the one that was avoidable.');

  // ------------------------------------------------------------ the double load
  // sw.js claims its clients the moment it activates, so controllerchange fires on a
  // FIRST visit as well as on a real update. index.html reloads on it, and reloading
  // because a worker took control for the first time throws away a page that was
  // already loading — on the one page that is mostly opened by people who have never
  // seen it, from the QR code on a table.
  for (const page of ['index.html', 'pos.html']) {
    const ctx = await browser.newContext({ serviceWorkers: 'allow' });
    await ctx.addInitScript(STUB);
    await ctx.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    const tab = await ctx.newPage();
    let navs = 0;
    tab.on('framenavigated', f => { if (f === tab.mainFrame()) navs++; });
    tab.on('dialog', d => d.dismiss().catch(()=>{}));
    await tab.goto(base + '/' + page, { waitUntil: 'load' });
    await tab.waitForTimeout(4000);                       // long enough for a reload to land
    check(page + ' loads once on a first visit, not twice', navs === 1,
          'the main frame navigated ' + navs + ' times');
    await ctx.close();
  }
  note('pos.html is the control: same worker, no reload handler, and it always navigated once');

  // ------------------------------------------------- one entry per page, not per table
  // The table QR codes are ila.cafe/?table=3, ?table=7, and so on round the room. The
  // cache keys on the whole URL unless told otherwise, so each table used to be its own
  // entry that had to be filled by its own slow open — and a customer moving tables got
  // a cold page on a phone holding the identical bytes under another number.
  {
    const ctx = await browser.newContext({ serviceWorkers: 'allow' });
    await ctx.addInitScript(STUB);
    await ctx.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    const first = await ctx.newPage();
    first.on('dialog', d => d.dismiss().catch(()=>{}));
    await first.goto(base + '/index.html?table=3', { waitUntil: 'load' });
    await first.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 })
               .catch(() => {});
    await first.waitForTimeout(1500);
    await first.close();

    const second = await ctx.newPage();
    second.on('dialog', d => d.dismiss().catch(()=>{}));
    await second.goto(base + '/index.html?table=7', { waitUntil: 'load' });
    const bytes = await transfer(second);
    check('a different table hits the page cached for the first one', bytes === 0,
          'table 7 pulled ' + bytes + ' bytes after table 3 had been opened');
    await second.close();
    await ctx.close();
  }

  await browser.close();
  server.close();
  done();
})();
