// What a refused read looks like to the person in front of the screen.
//
// refused-reads.test.js proves every listener PASSES a cancel callback. That is a
// shape, not a behaviour: a callback that does nothing would satisfy it exactly as
// well as one that works. This drives real pages with a database that refuses, and
// asks what is on screen afterwards.
//
// The distinction being checked is the one the whole change turns on. A refused read
// and an empty node are the same event from a browser, and the pages used to render
// both as "nothing here". Now:
//
//   a node the screen is about  -> the screen says it is incomplete, and names it
//   enrichment with a default   -> nothing on screen, because nothing is wrong
//
// Getting the second wrong is not harmless. A bar that appears when a wait-time
// model is briefly unreadable is a bar a cashier learns to ignore, and then the one
// that matters is ignored too.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Refused reads — what the screen says about them');

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json',
                '.png':'image/png', '.webmanifest':'application/manifest+json' };
const server = http.createServer((req,res)=>{
  const u = new URL(req.url,'http://x');
  const f = path.join(ROOT, u.pathname==='/'?'index.html':u.pathname.slice(1));
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('no');}
  res.writeHead(200,{'Content-Type':TYPES[path.extname(f)]||'application/octet-stream'});
  res.end(fs.readFileSync(f));
});

// deny: a list of paths the database refuses, the way live rules refuse a node they
// have never heard of — the cancel callback fires and the value callback never does.
const stub = (deny) => `
(() => {
  const noop=()=>{};
  const D={ menu:{Coffee:{Latte:{price:150}}}, 'settings/categoryOrder':['Coffee'],
            'eta/model':{itemBase:{}}, staff:{}, users:{},
            'inventory/stock':{}, 'inventory/config/items':{}, 'inventory/logs':{} };
  const DENY=${JSON.stringify(deny)};
  const denied=p=>DENY.indexOf(String(p))!==-1;
  const PD=()=>{const e=new Error("permission_denied at /"+"x: Client doesn't have permission to access the desired data.");e.code='PERMISSION_DENIED';return e;};
  const byPath=p=>{ if(D[p]!==undefined) return D[p];
    const parts=String(p).split('/');
    for(let i=parts.length-1;i>0;i--){const h=parts.slice(0,i).join('/');
      if(D[h]!==undefined){let v=D[h];for(const k of parts.slice(i))v=(v==null?undefined:v[k]);return v;}}
    return null; };
  const snap=v=>({val:()=>v,exists:()=>v!=null,numChildren:()=>v&&typeof v==='object'?Object.keys(v).length:0,
    forEach:cb=>{if(v&&typeof v==='object')Object.keys(v).forEach(k=>cb({key:k,val:()=>v[k]}));},key:null});
  const mk=(p,q)=>({
    on:(e,cb,cancel)=>{ if(e!=='value') return cb;
      if(p==='.info/connected'){ setTimeout(()=>{try{cb(snap(true))}catch(x){}},10); return cb; }
      if(denied(p)){ setTimeout(()=>{try{cancel&&cancel(PD())}catch(x){}},20); return cb; }
      setTimeout(()=>{try{cb(snap(byPath(p)))}catch(x){}},20); return cb; },
    once:()=>{ if(String(p).indexOf('users/')===0) return Promise.resolve(snap({role:'admin',name:'A'}));
      if(denied(p)) return Promise.reject(PD());
      return Promise.resolve(snap(byPath(p))); },
    off:noop, child:k=>mk(p+'/'+k,q),
    orderByChild:()=>mk(p,q), orderByKey:()=>mk(p,q), equalTo:()=>mk(p,q),
    startAt:()=>mk(p,q), endAt:()=>mk(p,q), limitToLast:()=>mk(p,q), limitToFirst:()=>mk(p,q),
    push:()=>({key:'k'}), set:()=>Promise.resolve(), update:()=>Promise.resolve(),
    remove:()=>Promise.resolve(),
    transaction:(f,cb)=>{ if(cb)cb(null,false,snap(null)); return Promise.resolve({committed:false}); }});
  const db={ref:p=>mk(String(p==null?'':p),{}),goOnline:noop,goOffline:noop};
  window.Chart=function(c,cfg){this.cfg=cfg;this.destroy=noop;this.update=noop;this.resize=noop;};
  window.Chart.defaults={font:{},plugins:{}}; window.Chart.register=noop;
  window.firebase={initializeApp:noop,apps:[{}],
    database:Object.assign(()=>db,{ServerValue:{TIMESTAMP:Date.now(),increment:n=>n}}),
    auth:()=>({onAuthStateChanged:cb=>setTimeout(()=>{try{cb({uid:'u1'})}catch(x){}},0),
      signInWithEmailAndPassword:()=>Promise.resolve({}),signOut:()=>Promise.resolve(),currentUser:{uid:'u1'}}),
    messaging:()=>({getToken:()=>Promise.resolve(null),onMessage:noop})};
  window.__stub=true;
  try{ localStorage.setItem('ila.role.v1', JSON.stringify({uid:'u1',role:'admin',name:'A'})); }catch(e){}
})();`;

(async () => {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const PRE='/opt/pw-browsers/chromium';
  const browser=await chromium.launch(fs.existsSync(PRE)?{executablePath:PRE}:{});

  const open = async (page, deny) => {
    const ctx=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
    await ctx.addInitScript(stub(deny));
    const tab=await ctx.newPage();
    const threw=[];
    tab.on('pageerror',e=>threw.push(e.message));
    tab.on('dialog',d=>d.dismiss().catch(()=>{}));
    await tab.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
    await tab.goto(base+'/'+page,{waitUntil:'commit'});
    await tab.waitForTimeout(1200);
    const seen=await tab.evaluate(()=>{
      const b=document.getElementById('ila-refused-bar');
      return { bar: !!b, text: b?b.textContent.trim():'', title: b?b.title:'',
               recorded: (window.ilaRefused&&window.ilaRefused.seen)?window.ilaRefused.seen():null,
               quiet: (window.ilaRefused&&window.ilaRefused.seenQuiet)?window.ilaRefused.seenQuiet():null };
    });
    await ctx.close();
    return { seen, threw };
  };

  // ---------------------------------------------- a node the screen is about
  {
    const r = await open('inventory.html', ['inventory/stock']);
    check('a refused read the screen is about puts a bar up', r.seen.bar,
          JSON.stringify(r.seen));
    check('and the bar says the screen is incomplete rather than that it is empty',
          /incomplete/i.test(r.seen.text), JSON.stringify(r.seen.text));
    check('and names what could not be loaded, so somebody knows where to look',
          /inventory\/stock/.test(r.seen.text + ' ' + r.seen.title),
          JSON.stringify([r.seen.text, r.seen.title]));
    check('nothing threw while it did that', r.threw.length===0,
          (r.threw[0]||'').slice(0,140));
    note('the stock page with no stock is the exact shape of the outage this came from');
  }

  // ---------------------------------------------- enrichment with a default
  {
    // chef.html, because it actually LISTENS to eta/model. The first version of this
    // denied it on inventory.html, which has no such listener — so nothing was
    // refused, no bar appeared, and the check passed without testing anything.
    const r = await open('chef.html', ['eta/model']);
    check('the refusal reached the page at all', (r.seen.quiet||[]).indexOf('eta/model') !== -1,
          JSON.stringify(r.seen));
    check('and a read the page has a default for puts NO bar up', !r.seen.bar,
          JSON.stringify(r.seen));
    note('recorded but not announced — "no bar" and "the callback never fired" are');
    note('otherwise the same thing to look at, and only one of them is correct');
    note('a bar nobody needs is a bar everybody learns to ignore, and then the one');
    note('that matters is ignored too');
  }

  // ---------------------------------------------- nothing refused, nothing said
  {
    const r = await open('inventory.html', []);
    check('and with nothing refused there is no bar at all', !r.seen.bar,
          JSON.stringify(r.seen));
  }

  // ---------------------------------------------- more than one, on a busy page
  {
    const r = await open('admin.html', ['staff','users','menu']);
    check('several refusals are one bar, not three', r.seen.bar &&
          (r.seen.recorded||[]).length >= 2,
          JSON.stringify(r.seen));
    check('and the bar counts them rather than listing them across the screen',
          /\d+ things/.test(r.seen.text), JSON.stringify(r.seen.text));
    check('with the names kept where they can still be read',
          /staff/.test(r.seen.title), JSON.stringify(r.seen.title));
  }

  await browser.close();
  server.close();
  done();
})();
