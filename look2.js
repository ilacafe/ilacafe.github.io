const fs=require('fs'), path=require('path'), http=require('http');
const {chromium}=require('playwright');
const ROOT=__dirname, OUT=process.argv[2];
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json','.png':'image/png','.webmanifest':'application/manifest+json'};
const srv=http.createServer((rq,rs)=>{const u=new URL(rq.url,'http://x');const f=path.join(ROOT,u.pathname==='/'?'index.html':u.pathname.slice(1));
 if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){rs.writeHead(404);return rs.end('no');}
 rs.writeHead(200,{'Content-Type':T[path.extname(f)]||'application/octet-stream'});rs.end(fs.readFileSync(f));});
const MENU={Coffee:{"Flat White":{price:180,inStock:true},"Cold Brew":{price:220,inStock:false},
  "Latte":{hasSizes:true,priceReg:170,priceLrg:210,inStock:true},"Mocha":{hasSizes:true,priceReg:190,priceLrg:230,inStock:false}},
  Food:{"Avocado Toast":{price:340,inStock:true},"Banana Bread":{price:160,inStock:false}}};
const STUB=`(()=>{const MENU=${JSON.stringify(MENU)};
const snap=(o)=>({val:()=>(o===undefined?null:o),exists:()=>o!=null,numChildren:()=>0,forEach:()=>{},key:null});
const mk=(p)=>{const s={key:'k',child:()=>mk(p),orderByChild:()=>s,orderByKey:()=>s,limitToLast:()=>s,limitToFirst:()=>s,startAt:()=>s,endAt:()=>s,equalTo:()=>s,
on:(_e,cb)=>{try{if(cb)cb(snap(String(p)==='menu'?MENU:null));}catch(e){}return cb;},off:()=>{},
once:(_e,cb)=>{const x=snap(String(p)==='menu'?MENU:null);if(cb)cb(x);return Promise.resolve(x);},
push:()=>mk(p),set:()=>Promise.resolve(),update:()=>Promise.resolve(),remove:()=>Promise.resolve(),
transaction:(_f,cb)=>{const x=snap(null);if(cb)cb(null,false,x);return Promise.resolve({committed:false,snapshot:x});}};return s;};
const database=()=>({ref:(p)=>mk(p||''),goOnline:()=>{},goOffline:()=>{}});
database.ServerValue={TIMESTAMP:1756200000000,increment:(n)=>({'.sv':{increment:n}})};
window.firebase={initializeApp:()=>({}),apps:[],database:database,
auth:()=>({currentUser:{uid:'a'},onAuthStateChanged:(cb)=>{setTimeout(()=>{try{cb({uid:'a'});}catch(e){}},0);return()=>{};},
signOut:()=>Promise.resolve(),signInWithEmailAndPassword:()=>Promise.resolve({user:{uid:'a'}}),signInAnonymously:()=>Promise.resolve({user:{uid:'a'}})})};
window.Chart=function(){return{destroy(){},update(){},data:{datasets:[]},options:{}};};})();`;
(async()=>{
 await new Promise(r=>srv.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+srv.address().port;
 const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
 fs.mkdirSync(OUT,{recursive:true});
 // customer menu: OUT tags + build stamp
 let ctx=await b.newContext({serviceWorkers:'block',viewport:{width:420,height:760}});
 await ctx.addInitScript(STUB); let pg=await ctx.newPage();
 await pg.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
 await pg.goto(base+'/index.html',{waitUntil:'domcontentloaded'}); await pg.waitForTimeout(900);
 await pg.screenshot({path:path.join(OUT,'menu.png')}); await ctx.close();
 // sign-in error
 ctx=await b.newContext({serviceWorkers:'block',viewport:{width:460,height:400}});
 await ctx.addInitScript(STUB); pg=await ctx.newPage();
 await pg.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
 await pg.goto(base+'/pos.html',{waitUntil:'domcontentloaded'}); await pg.waitForTimeout(500);
 await pg.evaluate(()=>{const ov=document.getElementById('login-overlay');
   ov.classList.remove('hidden'); ov.innerHTML='';
   ov.appendChild(document.getElementById('login-box-template').content.cloneNode(true));
   document.getElementById('login-error').textContent='This account has no staff access. Ask the owner to add it.';});
 await pg.screenshot({path:path.join(OUT,'signin.png')}); await ctx.close();
 await b.close(); srv.close();
})();
