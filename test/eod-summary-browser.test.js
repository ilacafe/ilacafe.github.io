// Analytics stopped downloading the café's whole cash-up history to render a list.
//
// pos/eodArchive is the permanent record of a trading day: the report, the totals,
// and that day's ENTIRE bills and ledger. Admin's UPI history reads the ledger out
// of it and the Worker writes late bank verifications into it, so it stays exactly
// as it was.
//
// Analytics does not need any of that. renderEod shows five things per closing —
// cash, UPI, who closed it, when, and how many bills there were — and it was pulling
// 120 days of complete archives to do it. Measured against a café doing 100 bills a
// day: 5.2MB downloaded per open to render a list built from about 10KB, and 2.4MB
// of that was bills fetched solely so they could be counted. Firebase has no count
// and no way to ask for some fields of a record, so the count is written down at the
// one moment it is known — at close, beside the archive.
//
// Three things have to hold, and the third is the one that would go wrong quietly:
//   the till writes the summary, and cannot have its close broken by that write;
//   analytics renders from the summary and stops reading the archive;
//   closings made before any of this existed are rebuilt, once, rather than vanishing.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('End-of-day summaries — the list without the ledger');

const DAYS = 8, BILLS = 30;
const now = Date.now(), DAY = 86400000;

function archives(){
  const a = {};
  for (let d = 0; d < DAYS; d++){
    const bills = {}, ledger = {};
    for (let i = 0; i < BILLS; i++){
      bills['b'+i] = { id: now-i, table: 'Table '+(i%9), date: '14:32 - 03/09/2026',
                       items: { Latte: { qty:1, price:150 } }, total: 200+i, notes:'', phone:null };
      ledger['l'+i] = { date:'14:32', type: i%2?'upi_income':'cash_income', amount:200+i,
                        reason:'Table '+(i%9), ts: now-i, verifyState:'verified-bank' };
    }
    a['2026-08-'+String(d).padStart(2,'0')+'-'+(now - d*DAY)] = {
      report: 'ILA — END OF DAY — day '+d, upi: 1000+d, cash: 2000+d,
      bills, ledger, closedBy: 'Tara', closedAt: now - d*DAY };
  }
  return a;
}
const ARCH = archives();
const ARCH_KEYS = Object.keys(ARCH);

const TYPES = { '.html':'text/html','.js':'text/javascript','.json':'application/json',
                '.png':'image/png','.webmanifest':'application/manifest+json' };
const server = http.createServer((req,res)=>{
  const u = new URL(req.url,'http://x');
  const f = path.join(ROOT, u.pathname==='/'?'index.html':u.pathname.slice(1));
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('no');}
  res.writeHead(200,{'Content-Type':TYPES[path.extname(f)]||'application/octet-stream'});
  res.end(fs.readFileSync(f));
});

// Records every read and write by path, so the suite can assert on what the page
// ASKED FOR rather than on what it happened to display.
const stub = (withSummary, withMarker) => `
(() => {
 const noop=()=>{};
 const ARCH = ${JSON.stringify(ARCH)};
 const D = { 'pos/eodArchive': ARCH, menu:{Coffee:{Latte:{price:150,routing:'barista'}}},
             'orders/history': {}, 'settings/categoryOrder':['Coffee'] };
 ${withSummary ? `D['pos/eodSummary'] = Object.fromEntries(Object.entries(ARCH).map(([k,d])=>[k,
     {cash:d.cash,upi:d.upi,bills:Object.keys(d.bills).length,closedBy:d.closedBy,closedAt:d.closedAt}]));` : ''}
 ${withMarker ? `D['pos/eodSummaryBackfill'] = { at: 1, days: ${DAYS} };` : ''}
 // Present but empty when it has not been seeded: Firebase creates a node on first
 // write, and setPath below can only write INTO one that exists. Without this the
 // rebuild's writes landed on a flat key and the suite read them as "none written",
 // which looked like a page bug and was a harness one.
 D['pos/eodSummary'] = D['pos/eodSummary'] || {};
 window.__reads = {}; window.__writes = {};
 const byPath = p => { if (D[p] !== undefined) return D[p];
   const parts = String(p).split('/');
   for (let i=parts.length-1;i>0;i--){ const head=parts.slice(0,i).join('/');
     if (D[head] !== undefined){ let v=D[head]; for(const k of parts.slice(i)) v=(v==null?undefined:v[k]); return v; } }
   return null; };
 const setPath = (p,v) => { const parts=String(p).split('/');
   for (let i=parts.length-1;i>0;i--){ const head=parts.slice(0,i).join('/');
     if (D[head] !== undefined){ let o=D[head]; const rest=parts.slice(i);
       for (let j=0;j<rest.length-1;j++){ o[rest[j]] = o[rest[j]]||{}; o=o[rest[j]]; }
       o[rest[rest.length-1]] = v; return; } }
   D[p] = v; };
 const note=(bag,p,bytes)=>{ const e=bag[p]||(bag[p]={calls:0,bytes:0}); e.calls++; e.bytes+=bytes||0; };
 const snap=v=>({val:()=>v,exists:()=>v!=null,
   forEach:cb=>{ if(v&&typeof v==='object') Object.keys(v).forEach(k=>cb({key:k,val:()=>v[k]})); },
   numChildren:()=>v&&typeof v==='object'?Object.keys(v).length:0,key:null});
 const sizeOf=v=>{ try{ return new TextEncoder().encode(JSON.stringify(v===undefined?null:v)).length; }catch(e){ return 0; } };
 const applyQ=(val,q)=>{ if(!val||typeof val!=='object'||Array.isArray(val)) return val;
   let keys=Object.keys(val); if(q.orderByKey||q.orderByChild) keys.sort();
   if(q.startAt!=null) keys=keys.filter(k=>String(k)>=String(q.startAt));
   if(q.limitToLast!=null) keys=keys.slice(-q.limitToLast);
   const o={}; keys.forEach(k=>o[k]=val[k]); return o; };
 const mk=(p,q)=>({
   on:(e,cb)=>{ if(e!=='value') return cb;
     if(p==='.info/connected'){ setTimeout(()=>{try{cb(snap(true))}catch(x){}},20); return cb; }
     const v=applyQ(byPath(p),q); note(window.__reads,p,sizeOf(v));
     setTimeout(()=>{try{cb(snap(v))}catch(x){}},30); return cb; },
   once:()=>{ if(p.indexOf('users/')===0) return Promise.resolve(snap({role:'admin',name:'A'}));
     const v=applyQ(byPath(p),q); note(window.__reads,p,sizeOf(v));
     return Promise.resolve(snap(v)); },
   off:noop, child:k=>mk(p+'/'+k,q),
   orderByChild:()=>mk(p,{...q,orderByChild:true}), orderByKey:()=>mk(p,{...q,orderByKey:true}),
   startAt:v=>mk(p,{...q,startAt:v}), limitToLast:n=>mk(p,{...q,limitToLast:n}),
   push:()=>({key:'k'+Math.random().toString(36).slice(2)}),
   set:v=>{ note(window.__writes,p,sizeOf(v)); setPath(p,v); return Promise.resolve(); },
   update:v=>{ if(p===''){ Object.keys(v).forEach(k=>{ note(window.__writes,k,sizeOf(v[k])); setPath(k,v[k]); }); }
               else note(window.__writes,p,sizeOf(v)); return Promise.resolve(); },
   remove:()=>Promise.resolve(),
   transaction:(f,cb)=>{ if(cb)cb(null,false,snap(null)); return Promise.resolve({committed:false}); }});
 const db={ref:p=>mk(String(p==null?'':p),{}), goOnline:noop, goOffline:noop};
 window.__db = D;
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

const waitFor = async (tab, fn, ms) => {
  try { await tab.waitForFunction(fn, null, { timeout: ms }); return true; } catch(e){ return false; }
};

(async () => {
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const base = 'http://127.0.0.1:'+server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE)?{executablePath:PRE}:{});

  const open = async (withSummary, withMarker) => {
    const ctx = await browser.newContext({ serviceWorkers:'block', viewport:{width:1280,height:900} });
    await ctx.addInitScript(stub(withSummary, withMarker));
    const tab = await ctx.newPage();
    const threw = [];
    tab.on('pageerror', e => threw.push(e.message));
    tab.on('dialog', d => d.dismiss().catch(()=>{}));
    await tab.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await tab.goto(base+'/analytics.html', { waitUntil:'commit' });
    await waitFor(tab, () => document.querySelectorAll('#eod-container > div').length > 0, 20000);
    await tab.waitForTimeout(600);
    return { ctx, tab, threw };
  };

  // ---------------------------------------- a café that has already been rebuilt
  {
    const { ctx, tab, threw } = await open(true, true);
    const io = await tab.evaluate(() => ({ reads: window.__reads, writes: window.__writes }));
    check('the closings are read from the summary', !!io.reads['pos/eodSummary'],
          Object.keys(io.reads).join(', '));
    check('and the archive is not touched at all', !io.reads['pos/eodArchive'],
          'archive read ' + JSON.stringify(io.reads['pos/eodArchive']));
    note('this is the read that was 5.2MB on a café doing 100 bills a day');
    const arch = io.reads['pos/eodArchive'], sum = io.reads['pos/eodSummary'];
    check('and the summary is a fraction of the size the archive was',
          sum && sum.bytes < 4000, sum ? sum.bytes + ' bytes' : 'not read');

    // the rebuild must not run again once the marker is there
    check('the rebuild does not run a second time', !io.writes['pos/eodSummaryBackfill'],
          'it wrote the marker again');

    // the list itself
    const rows = await tab.evaluate(() => [...document.querySelectorAll('#eod-container > div')]
      .map(d => d.textContent.replace(/\s+/g,' ').trim()));
    check('every closing is listed', rows.length === DAYS , rows.length + ' rows for ' + DAYS + ' closings');
    check('with its bill count, not an empty one',
          rows.every(r => /\d+ bill\(s\)/.test(r)) &&
          rows.some(r => new RegExp('\\b' + BILLS + ' bill\\(s\\)').test(r)),
          rows[0] || '(no rows)');
    note('the count is written at close now — Firebase has no way to count without downloading');
    // Worked out from the archive rather than typed in: the first row is the newest
    // closing, and the first version of this asserted day 0's total against day 7's row.
    const newest = ARCH[ARCH_KEYS.slice().sort((a,b)=>b.localeCompare(a))[0]];
    const wantTotal = (newest.cash + newest.upi).toLocaleString('en-IN');
    check('and the totals are the ones the archive holds',
          rows[0].indexOf(wantTotal) !== -1,
          'row reads ' + JSON.stringify(rows[0]) + ', expected to contain ' + wantTotal);

    // the report is fetched only when asked for
    const before = await tab.evaluate(() => (window.__reads['pos/eodArchive/'+Object.keys(window.__db['pos/eodArchive'])[0]+'/report']||{calls:0}).calls);
    const report = await tab.evaluate(async () => {
      const btn = [...document.querySelectorAll('#eod-container button')].find(b => /View report/.test(b.textContent));
      btn.click();
      await new Promise(r => setTimeout(r, 400));
      const pre = btn.parentElement.querySelector('pre');
      return { text: pre ? pre.textContent : null, shown: pre && pre.style.display !== 'none',
               archiveReads: Object.keys(window.__reads).filter(k => /eodArchive\/.*\/report/.test(k)).length };
    });
    check('the report is not downloaded until it is opened', before === 0, before + ' reads before the tap');
    check('and then it is, and it is the right one',
          report.shown && /END OF DAY/.test(report.text || ''), JSON.stringify(report).slice(0,160));
    check('by reading one report, not every one', report.archiveReads === 1,
          report.archiveReads + ' report paths read');
    check('nothing threw', threw.length === 0, threw.slice(0,2).join(' | '));
    await ctx.close();
  }

  // ---------------------------------------- a café opening analytics for the first time
  {
    const { ctx, tab, threw } = await open(false, false);
    await tab.waitForTimeout(1200);
    const io = await tab.evaluate(() => ({ reads: window.__reads, writes: window.__writes,
                                           summary: window.__db['pos/eodSummary'],
                                           marker: window.__db['pos/eodSummaryBackfill'] }));
    check('with no summaries yet, the archive is read once to rebuild them',
          !!io.reads['pos/eodArchive'] && io.reads['pos/eodArchive'].calls === 1,
          JSON.stringify(io.reads['pos/eodArchive']));
    check('and every closing gets a summary', io.summary && Object.keys(io.summary).length === DAYS,
          io.summary ? Object.keys(io.summary).length + ' written' : 'none written');
    check('each carrying the count the archive would have had to be downloaded for',
          io.summary && Object.values(io.summary).every(v => v.bills === BILLS),
          JSON.stringify(Object.values(io.summary || {})[0]));
    check('and the totals it holds', io.summary &&
          Object.values(io.summary).every(v => typeof v.cash === 'number' && typeof v.upi === 'number'),
          JSON.stringify(Object.values(io.summary || {})[0]));
    check('and a marker is written so this never happens again', !!io.marker && !!io.marker.at,
          JSON.stringify(io.marker));
    note('without the marker analytics cannot know the index is complete without listing the archive');
    check('nothing threw during the rebuild', threw.length === 0, threw.slice(0,2).join(' | '));
    await ctx.close();
  }

  await browser.close();
  server.close();
  done();
})();
