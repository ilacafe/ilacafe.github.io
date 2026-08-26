// ============================================================================
//  Café Ila — push relay, payment ingest, ETA recalibration (Cloudflare Worker)
//
//  This is the most privileged component in the system. It holds the only
//  credential that can write eta/model and payments/incoming (robot@cafeila.app),
//  and it is the only part of Café Ila that runs somewhere a customer's browser
//  cannot reach. Everything else here is a static page whose checks are advice.
//
//  It lives in this repo so it can be reviewed, diffed and rolled back. It is
//  NOT deployed by pushing to main — see worker/README.md. GitHub Pages serves
//  this repo raw (.nojekyll), so treat this file as world-readable: every secret
//  comes from an env binding, never a literal. test/worker.test.js fails the
//  build if one is ever pasted back in.
// ============================================================================

// ---- configuration ---------------------------------------------------------
// Secrets arrive as env bindings and are cached per isolate. Cloudflare passes
// env to each handler rather than to module scope, so every entry point
// (fetch, scheduled, email) calls loadConfig(env) before doing any work.
let VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT, FIREBASE_PROJECT;
let INGEST_SECRET, RECAL_SECRET;
let ROBOT_EMAIL, ROBOT_PASSWORD, FIREBASE_API_KEY, DB_URL, EMAIL_FORWARD_TO;

function loadConfig(env){
  env = env || {};
  // public by design — all three already appear in the site's own source
  VAPID_PUBLIC     = env.VAPID_PUBLIC;
  FIREBASE_API_KEY = env.FIREBASE_API_KEY;
  FIREBASE_PROJECT = env.FIREBASE_PROJECT;
  DB_URL           = env.DB_URL;
  // secret
  VAPID_PRIVATE    = env.VAPID_PRIVATE;
  INGEST_SECRET    = env.INGEST_SECRET;
  RECAL_SECRET     = env.RECAL_SECRET;
  ROBOT_PASSWORD   = env.ROBOT_PASSWORD;
  // addresses — not secret, but personal, so they stay out of the repo too
  VAPID_SUBJECT    = env.VAPID_SUBJECT;
  ROBOT_EMAIL      = env.ROBOT_EMAIL;
  EMAIL_FORWARD_TO = env.EMAIL_FORWARD_TO;
}

// Fail closed on a missing binding. Without this an unset secret makes the
// route it guards WIDE OPEN, because `data.secret === undefined` is true for a
// request that simply omits the field — a deploy that forgot one `wrangler
// secret put` would silently publish an authenticated route.
function authOk(provided, expected){
  return typeof expected === 'string' && expected.length >= 16 &&
         typeof provided === 'string' && provided === expected;
}

// ---- Web Push crypto (RFC 8291 aes128gcm + RFC 8292 VAPID) -----------------
const _enc = new TextEncoder();
function b64urlToBytes(s){ s=String(s).replace(/-/g,'+').replace(/_/g,'/'); const pad='='.repeat((4-s.length%4)%4); const bin=atob(s+pad); const a=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i); return a; }
function bytesToB64url(a){ const b=new Uint8Array(a); let s=''; for(let i=0;i<b.length;i++)s+=String.fromCharCode(b[i]); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function _cat(...arrs){ let n=0; for(const a of arrs)n+=a.length; const o=new Uint8Array(n); let p=0; for(const a of arrs){o.set(a,p);p+=a.length;} return o; }
async function _hkdf(salt, ikm, info, len){ const k=await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']); return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF', hash:'SHA-256', salt, info}, k, len*8)); }

async function encryptPayload(plaintext, p256dhB64, authB64){
  const uaPub = b64urlToBytes(p256dhB64);
  const authSecret = b64urlToBytes(authB64);
  const as = await crypto.subtle.generateKey({name:'ECDH', namedCurve:'P-256'}, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, {name:'ECDH', namedCurve:'P-256'}, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH', public: uaKey}, as.privateKey, 256));
  const ikm = await _hkdf(authSecret, ecdh, _cat(_enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await _hkdf(salt, ikm, _enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await _hkdf(salt, ikm, _enc.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, {name:'AES-GCM'}, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv:nonce, tagLength:128}, aesKey, _cat(plaintext, new Uint8Array([2]))));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return _cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
async function _importVapid(privB64, pubB64){
  const pub = b64urlToBytes(pubB64);
  return crypto.subtle.importKey('jwk', { kty:'EC', crv:'P-256', d: privB64, x: bytesToB64url(pub.slice(1,33)), y: bytesToB64url(pub.slice(33,65)), ext:true }, {name:'ECDSA', namedCurve:'P-256'}, false, ['sign']);
}
async function vapidJwt(audience, subject, privB64, pubB64){
  const h = bytesToB64url(_enc.encode(JSON.stringify({typ:'JWT', alg:'ES256'})));
  const p = bytesToB64url(_enc.encode(JSON.stringify({aud:audience, exp:Math.floor(Date.now()/1000)+12*3600, sub:subject})));
  const si = h + '.' + p;
  const key = await _importVapid(privB64, pubB64);
  const sig = new Uint8Array(await crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, key, _enc.encode(si)));
  return si + '.' + bytesToB64url(sig);
}

// ---- Payment SMS/email parsing ---------------------------------------------
const _num = (re, t) => { const m = t.match(re); return m ? parseFloat(m[1].replace(/,/g,'')) : null; };
const _grp = (re, t) => { const m = t.match(re); return m ? m[1] : null; };
function parseICICI(t){ return { source:'icici',
  amount:_num(/credited with Rs\.?\s*([\d,]+(?:\.\d+)?)/i,t), acct:_grp(/Acct\s+([A-Z0-9]+)/i,t),
  payer:(_grp(/from\s+(.+?)\.?\s*UPI:/i,t)||'').trim()||null, ref:_grp(/UPI:\s*(\d+)/i,t) }; }
function parseAirtel(t){ return { source:'airtel',
  amount:_num(/credited with Rs\.?\s*([\d,]+(?:\.\d+)?)/i,t), acct:null, payer:null,
  ref:_grp(/Txn ID:\s*(\d+)/i,t) }; }
function parseAxis(t){ const info=_grp(/Transaction Info:\s*([^\n\r]+)/i,t)||''; const m=info.match(/\/(\d{6,})\/([^\/]+)\//);
  return { source:'axis', amount:_num(/Amount Credited:\s*INR\s*([\d,]+(?:\.\d+)?)/i,t),
  acct:_grp(/Account Number:\s*([A-Z0-9]+)/i,t), bankTime:(_grp(/Date & Time:\s*([0-9:\- ,]+IST)/i,t)||'').trim()||null,
  ref:m?m[1]:null, payer:m?m[2].trim():null }; }
function parsePayment(source, text){
  source=(source||'').toLowerCase();
  if(source==='icici') return parseICICI(text);
  if(source==='airtel') return parseAirtel(text);
  if(source==='axis') return parseAxis(text);
  if(/icici/i.test(text)) return parseICICI(text);   // fallback auto-detect
  if(/airtel/i.test(text)) return parseAirtel(text);
  if(/axis/i.test(text)) return parseAxis(text);
  return null;
}

// ---- Robot sign-in: short-lived token so the Worker can write payments ------
let _robotTok=null, _robotExp=0;
async function getRobotToken(){
  if(_robotTok && Date.now() < _robotExp-60000) return _robotTok;   // reuse on warm isolate
  // The Firebase Web API key is HTTP-referrer restricted (that's why browsers work but a
  // server fetch, which sends no Referer, is blocked). Send our own domain as the referer
  // to match the key's existing allowlist. No Google Cloud change needed.
  const res=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key='+FIREBASE_API_KEY,{
    method:'POST', headers:{'Content-Type':'application/json', 'Referer':'https://ila.cafe'},
    body:JSON.stringify({email:ROBOT_EMAIL,password:ROBOT_PASSWORD,returnSecureToken:true})});
  const j=await res.json();
  if(!j.idToken) throw new Error('robot sign-in failed: '+((j.error&&j.error.message)||'unknown'));
  _robotTok=j.idToken; _robotExp=Date.now()+(parseInt(j.expiresIn||'3600',10)*1000);
  return _robotTok;
}

// ---- Ingest: parse one alert, write payments/incoming/{ref} -----------------
// Keyed by the bank reference so a re-sent alert overwrites itself (idempotent).
// Match-state is NOT stored here — the POS claims under payments/claims/{ref} —
// so a re-ingest can never wipe a match.
async function handleIngest(data){
  if(!data || !authOk(data.secret, INGEST_SECRET)) return { status:401, body:{ error:'unauthorized' } };
  const p = parsePayment(data.source, data.text||'');
  if(!p || !p.amount || !p.ref) return { status:422, body:{ error:'could not parse', parsed:p } };
  const payment = { amount:p.amount, payer:p.payer||null, ref:String(p.ref), source:p.source,
    acct:p.acct||null, bankTime:p.bankTime||null, at: Date.now() };
  let token; try{ token=await getRobotToken(); }catch(e){ return { status:502, body:{ error:String(e.message||e) } }; }
  const url = DB_URL + '/payments/incoming/' + encodeURIComponent(p.ref) + '.json?auth=' + token;
  const res = await fetch(url, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payment) });
  if(!res.ok) return { status:502, body:{ error:'db write failed', code:res.status, detail:(await res.text()).slice(0,200) } };
  return { status:200, body:{ ok:true, payment } };
}

const CORS = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'POST, OPTIONS', 'Access-Control-Allow-Headers':'Content-Type', 'Access-Control-Max-Age':'86400' };
function json(obj, status){ return new Response(JSON.stringify(obj), { status: status||200, headers: { 'Content-Type':'application/json', ...CORS } }); }

// ============================================================================
//  WHO IS ALLOWED TO SEND A PUSH
//
//  The relay used to accept SHARED_SECRET, which is a literal in pos.html,
//  admin.html, barista.html and chef.html — all served from ila.cafe. Anyone who
//  opened view-source could send any notification they liked to every admin
//  device: a fabricated "Bill voided ₹50,000" arrives looking exactly like the
//  real thing, because it came down the real pipe. The caller also supplied the
//  recipient list, so the Worker doubled as an open push relay signed with the
//  café's own VAPID key.
//
//  No secret can fix that. A secret a browser must hold is a public secret. So
//  the caller now proves it is a signed-in staff member with a Firebase ID
//  token, which is signed by Google, expires in an hour, and cannot be read out
//  of a page. Recipients are no longer taken from the caller at all — the Worker
//  reads pushSubscriptions itself.
// ============================================================================

const STAFF_ROLES = ['admin', 'cashier', 'barista', 'chef'];

// Google's public keys for Firebase ID tokens, cached for as long as the
// response says they are good for.
let _jwkCache = null, _jwkExp = 0;
async function googleJwks(){
  if (_jwkCache && Date.now() < _jwkExp) return _jwkCache;
  const res = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  if (!res.ok) throw new Error('jwks fetch failed: ' + res.status);
  const body = await res.json();
  const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  _jwkExp = Date.now() + (m ? parseInt(m[1], 10) : 3600) * 1000;
  _jwkCache = body.keys || [];
  return _jwkCache;
}

// Verify a Firebase ID token and return its payload, or null. Every failure
// returns null rather than throwing: a caller must never be able to tell a bad
// signature from an expired token from the wrong project.
async function verifyIdToken(jwt){
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  let header, payload;
  try {
    const dec = new TextDecoder();
    header  = JSON.parse(dec.decode(b64urlToBytes(h)));
    payload = JSON.parse(dec.decode(b64urlToBytes(p)));
  } catch(e){ return null; }

  if (header.alg !== 'RS256' || !header.kid) return null;   // never trust alg:none
  if (!FIREBASE_PROJECT) return null;                        // fail closed on a missing binding

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== 'https://securetoken.google.com/' + FIREBASE_PROJECT) return null;
  if (payload.aud !== FIREBASE_PROJECT) return null;
  if (!payload.sub || typeof payload.sub !== 'string') return null;
  if (!(payload.exp > now)) return null;
  if (!(payload.iat <= now + 300)) return null;              // allow a little clock skew

  let keys; try { keys = await googleJwks(); } catch(e){ return null; }
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) return null;

  let key;
  try {
    key = await crypto.subtle.importKey('jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  } catch(e){ return null; }

  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key,
    b64urlToBytes(sig), _enc.encode(h + '.' + p));
  return ok ? payload : null;
}

// A verified token is not enough. The ordering page signs in anonymously, so
// every customer holds a valid ID token for this project — what separates staff
// is an entry under users/{uid}. That lookup needs the robot credential, since
// the rules do not let one user read another's role.
async function staffRoleOf(uid){
  let token; try { token = await getRobotToken(); } catch(e){ return null; }
  const res = await fetch(DB_URL + '/users/' + encodeURIComponent(uid) + '/role.json?auth=' + token);
  if (!res.ok) return null;
  const role = await res.json();
  return STAFF_ROLES.indexOf(role) >= 0 ? role : null;
}

// The notification is still free text — staff legitimately send amounts, table
// names and item names — but it reaches a lock screen, so it is bounded and
// stripped of control characters. `url` is the one field with teeth: sw.js hands
// it to clients.openWindow() on tap, so an absolute URL would open an attacker's
// site from a notification that looks like the café's. Same-origin paths only.
function safeText(v, max){
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}
function safeNotification(n){
  n = n || {};
  const url = safeText(n.url, 200);
  return {
    title: safeText(n.title, 80) || 'Café Ila',
    body:  safeText(n.body, 300),
    tag:   safeText(n.tag, 64) || 'ila',
    url:   /^\/[^\/\\]/.test(url) ? url : '/admin.html'
  };
}

// ---- reusable single-push sender (shared by the relay loop and by the
//      recalibration / monitoring notifications, so there is one VAPID path) ----
async function sendOne(sub, payload){
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw new Error('bad subscription');
  const jwt = await vapidJwt(new URL(sub.endpoint).origin, VAPID_SUBJECT, VAPID_PRIVATE, VAPID_PUBLIC);
  const body = await encryptPayload(payload, sub.keys.p256dh, sub.keys.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '300', 'Urgency': 'high',
      'Authorization': 'vapid t=' + jwt + ', k=' + VAPID_PUBLIC
    },
    body
  });
  return res.status;
}

// ============================================================================
//  ETA RECALIBRATION — the self-learning half of the estimate
//
//  The pages ship a model (eta/model) that quotes waits. This refits that model
//  monthly from what the kitchen actually did, so the estimate tracks the café
//  rather than the assumptions it launched with.
// ============================================================================

// ---- config for recalibration ----
const RECAL_MIN_NEW_ORDERS   = 1500;   // skip refit unless >= this many completed SINCE THE LAST RUN
const RECAL_SWING_REJECT_PCT = 0.40;   // reject whole refit if a core coefficient moves > 40%
const RECAL_LOOKBACK_DAYS    = 75;     // window of completed orders to derive from
// per-coefficient minimum clean sample sizes (else keep previous value for that coef)
const RECAL_MIN_N = { itemBase: 30, pizzaBaseAll: 120, oven: 10, sat: 10, qty: 8, cushion: 30, margin: 30 };
// hard sanity bounds (minutes) — a derived value outside these => reject refit
const RECAL_BOUNDS = {
  pizzaBase: [4, 20], drinkBase: [2, 15], bakedBase: [1, 12],
  ovenMax: [0, 35], satMax: [0, 40], cushion: [0, 15], margin: [0, 15]
};

// pizza/baked keyword sets (mirror the app engine)
const RC_PIZZA = ["margherita","funghi","burrata","formaggi","marc","pizza","fav","quattro","vodka"];
const RC_BAKED = ["cake","bread","banana"];

function rcIsPizza(name){ const n=(name||'').toLowerCase(); return RC_PIZZA.some(k=>n.includes(k)); }
function rcIsBaked(name){ const n=(name||'').toLowerCase(); return RC_BAKED.some(k=>n.includes(k)); }
function rcQty(it){ const q=parseInt(it&&it.qty); return isNaN(q)?1:q; }

// ---- stats helpers ----
function rcMedian(arr){ if(!arr.length) return null; const a=[...arr].sort((x,y)=>x-y); const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
function rcPctl(arr,p){ if(!arr.length) return null; const a=[...arr].sort((x,y)=>x-y); return a[Math.min(Math.floor(p*a.length), a.length-1)]; }
function rcIQRClean(arr){
  if(arr.length<8) return arr.slice();
  const a=[...arr].sort((x,y)=>x-y);
  const q1=a[Math.floor(a.length/4)], q3=a[Math.floor(3*a.length/4)];
  const fence=q3+1.5*(q3-q1);
  return a.filter(x=>x<=fence);
}

// ---- the volume gate ----
// How many completions are NEW — finished since the last recalibration attempt.
//
// This used to compare RECAL_MIN_NEW_ORDERS against every order in the 75-day
// window, and read eta/recalMeta into a variable it then threw away. At ~61
// completions a day the window holds ~4,600, so the gate sat permanently open
// and "wait for enough new evidence" never happened — the constant's own name
// says what was intended. A rejected run also advances lastRunAt: the refit is
// deterministic given the same orders, so retrying the same evidence would only
// be rejected again.
function rcCountFresh(orders, since){
  const cut = Number(since) || 0;
  let n = 0;
  for(const o of orders){ if(o && o.done > cut) n++; }
  return n;
}

// ---- read all completed orders in the lookback window, both stations ----
// Returns array of { start, done, dur(min), items, station }
async function rcLoadCompleted(token){
  const since = Date.now() - RECAL_LOOKBACK_DAYS*86400*1000;
  const out=[];
  for(const station of ['chef','barista']){
    const url = DB_URL + '/orders/completed/' + station + '.json?auth=' + token;
    const res = await fetch(url);
    if(!res.ok) continue;
    const data = await res.json();
    if(!data) continue;
    for(const id in data){
      const o=data[id]; if(!o) continue;
      const start = o.createdAt, done = o.completedAt;
      if(!start || !done) continue;            // need both timestamps (clean data only)
      if(done < since) continue;                // outside lookback window
      const dur = (done - start)/60000;
      if(dur < 1 || dur > 180) continue;        // hard sanity bounds
      out.push({ start, done, dur, items: o.items||{}, station, table: o.destination||'' });
    }
  }
  out.sort((a,b)=>a.start-b.start);
  return out;
}

// ---- compute "orders ahead" (load) per order: same-station intervals active at its start ----
function rcAttachLoad(orders){
  for(const station of ['chef','barista']){
    const arr = orders.filter(o=>o.station===station);
    for(const o of arr){
      let ahead=0;
      for(const c of arr){ if(c.start<o.start && c.done>o.start) ahead++; }
      o.ahead = ahead;
    }
  }
}

// ---- oven idle per pizza: time since previous pizza's completion (chef pizzas) ----
function rcAttachOvenIdle(orders){
  const pzs = orders.filter(o=>o.station==='chef' && Object.keys(o.items).some(rcIsPizza)).sort((a,b)=>a.start-b.start);
  let prevDone=null;
  for(const p of pzs){
    p.idle = prevDone!=null ? (p.start - prevDone)/60000 : 9999;
    prevDone = prevDone!=null ? Math.max(prevDone, p.done) : p.done;
  }
}

// ---- dessert-after-food exclusion: a single-dessert order at a table whose
//      duration is long AND a non-dessert order at the same table overlapped it
//      => it was served after the meal by choice, not prep delay. Exclude.
function rcIsDessertAfterFood(o, orders){
  if(!(Object.keys(o.items).every(rcIsBaked))) return false;  // only desserts
  if(o.dur <= 6) return false;                                 // quick = served now, keep
  // any non-dessert order at same table overlapping this dessert's window?
  for(const c of orders){
    if(c===o) continue;
    if(c.table!==o.table) continue;
    if(Object.keys(c.items).every(rcIsBaked)) continue;        // need a real meal item
    if(c.start <= o.done && c.done >= o.start) return true;    // overlapping meal => after-food
  }
  return false;
}

// ---- the full derivation: returns a proposed model (same shape as eta/model) ----
function rcDerive(orders){
  rcAttachLoad(orders);
  rcAttachOvenIdle(orders);
  const idleOf = new Map(orders.map(o=>[o, o.idle]));

  // filter out dessert-after-food contamination up front
  const clean = orders.filter(o=>!rcIsDessertAfterFood(o, orders));

  const notes = [];

  // ---------- per-item base (hot oven idle<10 for pizzas, low load<=2, single qty1) ----------
  const itemDurs = {};
  for(const o of clean){
    const names = Object.keys(o.items);
    if(names.length!==1) continue;
    if(rcQty(o.items[names[0]])!==1) continue;
    if(o.ahead>2) continue;
    if(o.dur>45) continue;
    const nm = names[0];
    if(o.station==='chef' && rcIsPizza(nm)){
      const idl = idleOf.get(o);
      if(!(idl!=null && idl>=0 && idl<10)) continue;  // truly hot, exclude overlapping (neg idle)
    }
    (itemDurs[nm] = itemDurs[nm] || []).push(o.dur);
  }
  const itemBase = {};
  for(const nm in itemDurs){
    const cleaned = rcIQRClean(itemDurs[nm]);
    if(cleaned.length >= RECAL_MIN_N.itemBase){ itemBase[nm.toLowerCase()] = +rcMedian(cleaned).toFixed(1); }
  }

  // pizza hot base (all pizzas pooled) — the shared baseline
  const pizzaHot = [];
  for(const o of clean){
    const names=Object.keys(o.items);
    if(names.length!==1 || rcQty(o.items[names[0]])!==1) continue;
    if(o.station!=='chef' || !rcIsPizza(names[0])) continue;
    if(o.ahead>2) continue;
    const idl=idleOf.get(o);
    if(!(idl!=null && idl>=0 && idl<10)) continue;
    if(o.dur>45) continue;
    pizzaHot.push(o.dur);
  }
  const pizzaHotClean = rcIQRClean(pizzaHot);
  const pizzaBase = pizzaHotClean.length>=RECAL_MIN_N.pizzaBaseAll ? +rcMedian(pizzaHotClean).toFixed(1) : null;

  // ---------- oven curve (delta from pizza hot base), single low-load pizzas by idle ----------
  function ovenPool(){
    return clean.filter(o=>{
      const names=Object.keys(o.items);
      return names.length===1 && rcQty(o.items[names[0]])===1 && o.station==='chef'
        && rcIsPizza(names[0]) && o.ahead<=2 && o.dur<=90;
    });
  }
  const ovenBands = [[0,10],[10,15],[15,20],[20,30],[30,45],[45,60],[60,120],[120,99999]];
  const ovenCurve=[]; const op = ovenPool(); const base = pizzaBase!=null?pizzaBase:7.5;
  for(const [lo,hi] of ovenBands){
    const sub = rcIQRClean(op.filter(o=>{const i=idleOf.get(o); return i>=lo && i<hi;}).map(o=>o.dur));
    if(sub.length>=RECAL_MIN_N.oven){
      const delta = Math.max(0, +(rcMedian(sub)-base).toFixed(1));
      ovenCurve.push([lo===0?0:lo, delta]);
    }
  }
  if(ovenCurve.length===0 || ovenCurve[0][0]!==0) ovenCurve.unshift([0,0]);

  // ---------- saturation curves, station-specific ----------
  // chef: single hot pizzas by load
  function satChef(){
    const pool = clean.filter(o=>{
      const names=Object.keys(o.items);
      if(!(names.length===1 && rcQty(o.items[names[0]])===1)) return false;
      if(o.station!=='chef' || !rcIsPizza(names[0])) return false;
      const i=idleOf.get(o); return i!=null && i>=0; // any load, but exclude neg-idle
    });
    const bands=[[0,2],[3,4],[5,7],[8,99]]; const out=[];
    const b = pizzaBase!=null?pizzaBase:7.5;
    for(const [lo,hi] of bands){
      const sub=rcIQRClean(pool.filter(o=>o.ahead>=lo && o.ahead<=hi).map(o=>o.dur));
      if(sub.length>=RECAL_MIN_N.sat){ out.push([lo, Math.max(0,+(rcMedian(sub)-b).toFixed(1))]); }
    }
    if(out.length && out[0][0]!==0) out.unshift([0, out[0][1]]);
    return out.length?out:null;
  }
  // barista: single drinks by load (no oven)
  function satBar(){
    const pool = clean.filter(o=>{
      const names=Object.keys(o.items);
      return names.length===1 && o.station==='barista' && !rcIsBaked(names[0]);
    });
    const b = rcMedian(rcIQRClean(pool.filter(o=>o.ahead<=1).map(o=>o.dur)));
    if(b==null) return null;
    const bands=[[0,1],[2,3],[4,6],[7,99]]; const out=[];
    for(const [lo,hi] of bands){
      const sub=rcIQRClean(pool.filter(o=>o.ahead>=lo && o.ahead<=hi).map(o=>o.dur));
      if(sub.length>=RECAL_MIN_N.sat){ out.push([lo, Math.max(0,+(rcMedian(sub)-b).toFixed(1))]); }
    }
    if(out.length && out[0][0]!==0) out.unshift([0,0]);
    return out.length?out:null;
  }

  // ---------- quantity curve (chef, hot, low load) ----------
  function qtyCurve(){
    const pool = clean.filter(o=>{
      if(o.station!=='chef') return false;
      const anyPizza = Object.keys(o.items).some(rcIsPizza);
      if(anyPizza){ const i=idleOf.get(o); if(!(i!=null && i>=0 && i<15)) return false; }
      return o.ahead<=2 && o.dur<=60;
    });
    function totQty(o){ let q=0; for(const nm in o.items) q+=rcQty(o.items[nm]); return q; }
    const b = rcMedian(rcIQRClean(pool.filter(o=>totQty(o)===1).map(o=>o.dur)));
    if(b==null) return null;
    const bands=[[1,1],[2,2],[3,4],[5,99]]; const out=[];
    for(const [lo,hi] of bands){
      const sub=rcIQRClean(pool.filter(o=>{const q=totQty(o); return q>=lo&&q<=hi;}).map(o=>o.dur));
      if(sub.length>=RECAL_MIN_N.qty){ out.push([lo, Math.max(0,+(rcMedian(sub)-b).toFixed(1))]); }
    }
    if(out.length && out[0][0]!==1) out.unshift([1,0]);
    return out.length?out:null;
  }

  // ---------- per-category cushion — DERIVED AS CURVES over the driving condition ----------
  // (residual spread GROWS with load/oven, so a flat number is wrong; we fit a small curve)
  function spreadOf(orderSubset){
    const cleaned = rcIQRClean(orderSubset.map(o=>o.dur));
    if(cleaned.length < RECAL_MIN_N.cushion) return null;
    return Math.max(0, +(rcPctl(cleaned,0.85) - rcMedian(cleaned)).toFixed(1));
  }
  // drink cushion over load
  const drinkPool = clean.filter(o=>o.station==='barista' && !Object.keys(o.items).some(rcIsBaked) && Object.keys(o.items).length===1);
  const cushionDrinkByLoad=[];
  for(const [lo,hi,pt] of [[0,1,0],[2,3,3],[4,99,5]]){
    const s=spreadOf(drinkPool.filter(o=>o.ahead>=lo && o.ahead<=hi));
    if(s!=null) cushionDrinkByLoad.push([pt,s]);
  }
  // pizza cushion over oven idle (low load)
  const pizzaPool = clean.filter(o=>{const names=Object.keys(o.items);return o.station==='chef' && rcIsPizza(names[0]) && names.length===1 && rcQty(o.items[names[0]])===1 && o.ahead<=2;});
  const cushionPizzaByOven=[];
  for(const [lo,hi,pt] of [[0,10,0],[10,30,20],[30,9999,60]]){
    const s=spreadOf(pizzaPool.filter(o=>{const i=idleOf.get(o); return i>=lo && i<hi;}));
    if(s!=null) cushionPizzaByOven.push([pt,s]);
  }
  if(cushionPizzaByOven.length && cushionPizzaByOven[0][0]!==0) cushionPizzaByOven.unshift([0,cushionPizzaByOven[0][1]]);
  // dessert (served-now) cushion — flat, data shows it's stable
  const cushionBaked = spreadOf(clean.filter(o=>Object.keys(o.items).every(rcIsBaked) && o.dur<=6));

  // ---------- per-category margin (p95-median at fixed conditions) ----------
  function marginFor(catFilter, fixedFilter){
    const pool = clean.filter(o=> catFilter(o) && fixedFilter(o));
    const cleaned = rcIQRClean(pool.map(o=>o.dur));
    if(cleaned.length < RECAL_MIN_N.margin) return null;
    return Math.max(0, +(rcPctl(cleaned,0.95) - rcMedian(cleaned)).toFixed(1));
  }
  const margin = {
    pizza: marginFor(
      o=>o.station==='chef' && Object.keys(o.items).some(rcIsPizza),
      o=>{const i=idleOf.get(o); const names=Object.keys(o.items); return names.length===1 && rcQty(o.items[names[0]])===1 && i!=null && i>=0 && i<10 && o.ahead<=2;}),
    drink: marginFor(
      o=>o.station==='barista' && !Object.keys(o.items).some(rcIsBaked),
      o=>{const names=Object.keys(o.items); return names.length===1 && o.ahead<=1;}),
    baked: marginFor(
      o=>Object.keys(o.items).every(rcIsBaked),
      o=>o.dur<=6)
  };

  return {
    derived: {
      itemBase, pizzaBase,
      ovenCurve: ovenCurve.length>1?ovenCurve:null,
      satCurveChef: satChef(), satCurveBarista: satBar(),
      qtyCurve: qtyCurve(),
      cushionDrinkByLoad: cushionDrinkByLoad.length?cushionDrinkByLoad:null,
      cushionPizzaByOven: cushionPizzaByOven.length>1?cushionPizzaByOven:null,
      cushionBaked,
      margin
    },
    counts: {
      totalClean: clean.length,
      pizzaHot: pizzaHotClean.length,
      items: Object.keys(itemBase).length
    },
    notes
  };
}

// ---- merge derived values into the current model, honoring per-coef volume gates ----
// (a derived value that passed its sample gate replaces; otherwise current value is kept)
function rcMergeModel(current, derived){
  const m = JSON.parse(JSON.stringify(current));   // start from current (keeps anything not re-derived)
  // item bases: merge per item
  if(derived.itemBase){ m.itemBase = Object.assign({}, m.itemBase, derived.itemBase); }
  if(derived.ovenCurve)        m.ovenCurve        = derived.ovenCurve;
  if(derived.satCurveChef)     m.satCurveChef     = derived.satCurveChef;
  if(derived.satCurveBarista)  m.satCurveBarista  = derived.satCurveBarista;
  if(derived.qtyCurve)         m.qtyCurve         = derived.qtyCurve;
  if(derived.cushionDrinkByLoad)  m.cushionDrinkByLoad = derived.cushionDrinkByLoad;
  if(derived.cushionPizzaByOven)  m.cushionPizzaByOven = derived.cushionPizzaByOven;
  if(derived.cushionBaked!=null)  m.cushionBaked = derived.cushionBaked;
  if(derived.margin){ m.margin = m.margin||{}; for(const k in derived.margin){ if(derived.margin[k]!=null) m.margin[k]=derived.margin[k]; } }
  if(derived.pizzaBase!=null){ m.fallback = m.fallback||{}; m.fallback.pizza = derived.pizzaBase; }
  m.version = (current.version||1) + 1;
  m.updatedAt = Date.now();
  m.source = 'recalibration';
  return m;
}

// ---- guardrails: returns {ok, reasons[]} ----
function rcCheckGates(current, derived, counts){
  const reasons=[];
  // bounds checks on the headline numbers
  function inb(v, [lo,hi]){ return v==null || (v>=lo && v<=hi); }
  if(derived.pizzaBase!=null && !inb(derived.pizzaBase, RECAL_BOUNDS.pizzaBase)) reasons.push('pizzaBase '+derived.pizzaBase+' out of bounds');
  if(derived.cushionBaked!=null && !inb(derived.cushionBaked, RECAL_BOUNDS.cushion)) reasons.push('cushionBaked out of bounds');
  if(derived.cushionDrinkByLoad){ for(const pt of derived.cushionDrinkByLoad){ if(!inb(pt[1], RECAL_BOUNDS.cushion)) reasons.push('cushionDrink point out of bounds'); } }
  if(derived.cushionPizzaByOven){ for(const pt of derived.cushionPizzaByOven){ if(!inb(pt[1], RECAL_BOUNDS.cushion)) reasons.push('cushionPizza point out of bounds'); } }
  if(derived.margin){ for(const k in derived.margin){ if(!inb(derived.margin[k], RECAL_BOUNDS.margin)) reasons.push('margin.'+k+' out of bounds'); } }
  // swing check vs current (only for values we actually re-derived)
  function swing(now, was){ if(now==null||was==null||was===0) return 0; return Math.abs(now-was)/was; }
  if(derived.pizzaBase!=null && current.fallback && current.fallback.pizza){
    const s = swing(derived.pizzaBase, current.fallback.pizza);
    if(s > RECAL_SWING_REJECT_PCT) reasons.push('pizzaBase swing '+(s*100).toFixed(0)+'%');
  }
  // (cushion is now condition-curves; bounds-checked above. Swing check focuses on the headline base.)
  // volume floor
  if(counts.totalClean < 200) reasons.push('too few clean orders ('+counts.totalClean+')');
  return { ok: reasons.length===0, reasons };
}

// A cron job that throws is the quietest failure there is. ctx.waitUntil takes the
// rejected promise, the Worker's own log records it, and nobody reads a log they
// have no reason to open — the monthly refit would simply stop happening.
//
// This never rethrows: the aim is to leave a trace, not to change what the runtime
// does with a failed tick. Notifying is itself best-effort, because the usual cause
// of a throw here is the robot token or the database being unreachable, which is
// also what a notification needs.
//
// At most one push a day per job. The monitor cron runs hourly and sw.js sets
// renotify on every tagged notification, so an unthrottled report would buzz the
// owner's phone twenty-four times a day until someone fixed it — and the practical
// response to that is turning notifications off, which also silences the payment
// alerts this Worker exists to send. Every tick is still logged, and every tick
// still updates ops/cronFailure, so the record is complete even when the phone is
// quiet.
const CRON_REPORT_GAP_MS = 20 * 3600 * 1000;

async function reportIfItThrows(job, promise){
  let result;
  try {
    result = await promise;
  } catch(e){
    const detail = (e && (e.message || String(e))) || 'unknown error';
    console.log('cron ' + job + ' threw: ' + (e && e.stack ? e.stack : detail));
    try {
      const token = await getRobotToken();
      const path = DB_URL + '/ops/cronFailure/' + encodeURIComponent(job) + '.json?auth=' + token;
      const prevRes = await fetch(path);
      const prev = prevRes.ok ? (await prevRes.json()) || {} : {};
      const now = Date.now();
      const due = !prev.lastNotifiedAt || (now - Number(prev.lastNotifiedAt)) > CRON_REPORT_GAP_MS;
      const wrote = await fetch(path, { method:'PUT', body: JSON.stringify({
        lastAt: now,
        lastError: String(detail).slice(0, 300),
        lastNotifiedAt: due ? now : (prev.lastNotifiedAt || null),
        failingSince: prev.failingSince || now,
        consecutive: (Number(prev.consecutive) || 0) + 1
      }) });

      // The push is gated on the record having been written, not just on the gap.
      // If this node cannot be written — the rules for it are not deployed yet, say,
      // since the Worker ships on a push to main and the rules do not — then a
      // failed read looks like "never notified" on every single tick, and the
      // throttle would let every one of them through. An unrecordable notification
      // is precisely the one that repeats forever, so it is not sent. The log line
      // above still goes out on every tick.
      if (due && wrote.ok){
        await pushOwner(token, '\u274c Scheduled job failed: ' + job, detail, 'cron-' + job, '/admin.html');
      } else if (!wrote.ok){
        console.log('cron ' + job + ': could not record the failure (' + wrote.status +
                    '), so not pushing — an unthrottled report would repeat every tick');
      } else {
        console.log('cron ' + job + ': reported within the last 20h, not pushing again');
      }
    } catch(inner){
      console.log('cron ' + job + ': could not report the failure either: ' + (inner && inner.message));
    }
    return { ran:false, threw:true, error:detail };
  }

  // Finished. Clear the record, so failingSince and consecutive mean what they say
  // and a job that recovered does not sit there looking broken — and so the next
  // failure after a good run pushes immediately instead of waiting out the gap.
  try {
    const token = await getRobotToken();
    await fetch(DB_URL + '/ops/cronFailure/' + encodeURIComponent(job) + '.json?auth=' + token,
                { method:'DELETE' });
  } catch(inner){ /* a clean run that could not clear its flag is not worth failing over */ }
  return result;
}

// ---- main recalibration entry (dryRun => derive + gate, but DON'T write) ----
async function runRecalibration(dryRun){
  const token = await getRobotToken();
  const metaRes = await fetch(DB_URL + '/eta/recalMeta.json?auth=' + token);
  const meta = metaRes.ok ? (await metaRes.json())||{} : {};
  const orders = await rcLoadCompleted(token);

  // volume gate: how many completed SINCE the last recalibration attempt. A dry
  // run deliberately skips the gate — its whole job is to report what a refit
  // would do right now.
  const fresh = rcCountFresh(orders, meta.lastRunAt);
  if(!dryRun && fresh < RECAL_MIN_NEW_ORDERS){
    // Say so. This was the one exit from the monthly run that told nobody
    // anything: a rejected refit notifies, a successful refit notifies, and a
    // skipped one used to return a reason string into a discarded promise. From
    // the outside a frozen model looked exactly like a healthy one, and the only
    // way to find out was to notice the ETAs drifting.
    //
    // lastRunAt is deliberately NOT advanced: the café is waiting to accumulate
    // enough new evidence, and resetting the count each month would mean it never
    // does. lastSkippedAt records the attempt without touching that.
    const waiting = RECAL_MIN_NEW_ORDERS - fresh;
    console.log('recal: skipped, ' + fresh + '/' + RECAL_MIN_NEW_ORDERS + ' new orders since ' +
                (meta.lastRunAt ? new Date(meta.lastRunAt).toISOString() : 'ever'));
    await fetch(DB_URL + '/eta/recalMeta/lastSkippedAt.json?auth=' + token, {
      method:'PUT', body: JSON.stringify(Date.now())
    });
    await fetch(DB_URL + '/eta/recalMeta/lastSkippedFresh.json?auth=' + token, {
      method:'PUT', body: JSON.stringify(fresh)
    });
    await rcNotifyOwner(token, '\u23f8\ufe0f ETA refit skipped',
      fresh + ' new orders since the last refit \u00b7 needs ' + RECAL_MIN_NEW_ORDERS +
      ' \u00b7 ' + waiting + ' to go. The model is unchanged.');
    return { ran:false, reason:'volume gate: only '+fresh+' completed since the last run (need '+RECAL_MIN_NEW_ORDERS+')',
             ordersConsidered: orders.length, freshOrders: fresh, lastRunAt: meta.lastRunAt || null };
  }

  // current model
  const curRes = await fetch(DB_URL + '/eta/model.json?auth=' + token);
  const current = curRes.ok ? (await curRes.json()) : null;
  if(!current){ return { ran:false, reason:'no current eta/model to compare against' }; }

  const { derived, counts, notes } = rcDerive(orders);
  const gate = rcCheckGates(current, derived, counts);

  const summary = {
    ran: !dryRun && gate.ok,
    dryRun: !!dryRun,
    ordersConsidered: orders.length,
    freshOrders: fresh,
    lastRunAt: meta.lastRunAt || null,
    cleanOrders: counts.totalClean,
    pizzaBase: derived.pizzaBase,
    cushionDrink: derived.cushionDrinkByLoad,
    cushionPizza: derived.cushionPizzaByOven,
    margin: derived.margin,
    itemsUpdated: counts.items,
    gatePassed: gate.ok,
    gateReasons: gate.reasons
  };

  if(dryRun){ return summary; }

  if(!gate.ok){
    // rejected: keep current model, record the attempt + notify
    await fetch(DB_URL + '/eta/recalMeta.json?auth=' + token, {
      method:'PUT', body: JSON.stringify({ lastRunAt: Date.now(), lastResult:'rejected', reasons: gate.reasons, orders: orders.length })
    });
    await rcNotifyOwner(token, '⚠️ ETA recalibration REJECTED', 'Kept current model. ' + gate.reasons.join('; '));
    return summary;
  }

  // passed: snapshot current -> previous, write merged new model
  await fetch(DB_URL + '/eta/modelPrevious.json?auth=' + token, { method:'PUT', body: JSON.stringify(current) });
  const merged = rcMergeModel(current, derived);
  await fetch(DB_URL + '/eta/model.json?auth=' + token, { method:'PUT', body: JSON.stringify(merged) });
  await fetch(DB_URL + '/eta/recalMeta.json?auth=' + token, {
    method:'PUT', body: JSON.stringify({ lastRunAt: Date.now(), lastResult:'updated', version: merged.version, orders: orders.length })
  });
  await rcNotifyOwner(token, '✅ ETA model updated (v'+merged.version+')',
    'pizza '+(current.fallback&&current.fallback.pizza)+'→'+derived.pizzaBase+
    ' · '+counts.totalClean+' orders · '+counts.items+' items refit');
  return summary;
}

// ---- notify the owner via the existing push subscriptions ----
async function rcNotifyOwner(token, title, body){
  return pushOwner(token, title, body, 'recal', '/admin.html');
}
// admin.html stores each device as { subscription, uid, name, at } — the actual
// PushSubscription is one level down, and the pages unwrap it before calling the
// relay. pushOwner did not: it handed the wrapper to sendOne, which requires
// .endpoint, so sendOne threw 'bad subscription' into a swallowed catch and every
// scheduled notification — recalibration result, the 2-hour unverified-payment
// alert, the per-bank alarm, the weekly digest — silently sent nothing at all.
// Tolerates a bare subscription too, in case one was ever stored unwrapped.
//
// The database key comes back with each one. A push service answers 404 or 410
// for a subscription that no longer exists — a reinstalled app, cleared site
// data, a rotated endpoint — and the only way to delete that record is to know
// what it is called.
function unwrapSubs(subsObj){
  return Object.entries(subsObj || {})
    .map(([key, x]) => ({ key, sub: (x && x.subscription) ? x.subscription : x }))
    .filter(e => e.sub && e.sub.endpoint && e.sub.keys && e.sub.keys.p256dh && e.sub.keys.auth);
}

// generalized owner push (arbitrary tag + url) — used by the scheduled verification checks
//
// EVERY AUTOMATIC NOTIFICATION GOES THROUGH HERE
//
// The cash-out reports, the unverified-payment alert, the per-bank alarm, the
// weekly digest, the recalibration result and the cron-failure report are all
// this function. It used to throw every status away, so if every registered
// device had gone stale it would loop, be told "gone" each time, swallow it and
// return as though it had delivered. Nothing anywhere recorded that the café's
// alerting had stopped.
//
// That is not a hypothetical. A push subscription dies whenever the app is
// reinstalled, site data is cleared, or the push service rotates an endpoint —
// and the record is keyed by endpoint, so a new one is written alongside the
// dead one rather than replacing it. Left alone, the dead ones accumulate and
// the live one can disappear entirely.
//
// So: count what actually landed, delete what the push service says is gone,
// and write down the outcome. The outcome cannot be a notification, for the
// obvious reason.
async function pushOwner(token, title, body, tag, url){
  let devices = 0, delivered = 0, expired = 0, failed = 0;
  try{
    const res = await fetch(DB_URL + '/pushSubscriptions.json?auth=' + token);
    const subsObj = res.ok ? (await res.json()) : null;
    const subs = unwrapSubs(subsObj);
    devices = subs.length;
    const payload = _enc.encode(JSON.stringify({ title, body, tag: tag||'ila', url: url||'/admin.html' }));
    for(const { key, sub } of subs){
      try{
        const status = await sendOne(sub, payload);
        if(status >= 200 && status < 300){ delivered++; continue; }
        if(status === 404 || status === 410){
          expired++;
          // Gone for good, not a transient error — drop it so the next send is
          // not slowed by a device that no longer exists, and so "devices" means
          // devices that could still be reached.
          await fetch(DB_URL + '/pushSubscriptions/' + encodeURIComponent(key) + '.json?auth=' + token,
                      { method:'DELETE' }).catch(()=>{});
          console.log('push: dropped expired subscription ' + key + ' (' + status + ')');
        } else {
          failed++;
          console.log('push: ' + key + ' returned ' + status);
        }
      }catch(e){
        failed++;
        console.log('push: ' + key + ' threw: ' + (e && e.message));
      }
    }
  }catch(e){
    console.log('push: could not read subscriptions: ' + (e && e.message));
  }

  console.log('push "' + title + '": ' + delivered + '/' + devices + ' delivered, ' +
              expired + ' expired, ' + failed + ' failed');
  await recordPushHealth(token, { devices, delivered, expired, failed, title });
  return { devices, delivered, expired, failed };
}

// Where "did anyone actually get that?" is answerable. admin.html reads this and
// says when the café last reached a phone, because a notification saying that
// notifications are broken is not a thing that can be sent.
async function recordPushHealth(token, r){
  try{
    const path = DB_URL + '/ops/pushHealth.json?auth=' + token;
    const prevRes = await fetch(path);
    const prev = prevRes.ok ? (await prevRes.json()) || {} : {};
    const now = Date.now();
    await fetch(path, { method:'PUT', body: JSON.stringify({
      lastAttemptAt: now,
      lastAttemptTitle: safeText(r.title, 80),
      devices: r.devices,
      delivered: r.delivered,
      expired: r.expired,
      failed: r.failed,
      // Only moved by a send that truly landed, so its age is the real answer to
      // "are alerts still working?"
      lastDeliveredAt: r.delivered > 0 ? now : (prev.lastDeliveredAt || null),
      consecutiveUndelivered: r.delivered > 0 ? 0 : (Number(prev.consecutiveUndelivered) || 0) + 1
    }) });
  }catch(e){ console.log('push: could not record health: ' + (e && e.message)); }
}

// ===== EMAIL INGEST (bank credit alerts -> payments/incoming) =====
// Cloudflare Email Routing delivers bank alert emails straight to this worker.
// Each custom address maps to one bank; the parser extracts {amount, UTR, payer,
// acct} from CREDIT alerts only and writes the same idempotent payments/incoming
// record the SMS path used — plus a `bank` tag that the POS uses to match a
// credit to the table whose VPA belongs to that bank.
//
// EMAIL_FORWARD_TO is an env binding (a verified Email Routing destination).
// Every email is forwarded there AFTER processing. Bank identification is by
// SENDER domain, so any ila.cafe address routed to this worker works — multiple
// banks can share one address (accounts@).
const EMAIL_SENDER_BANKS = [
  { bank: 'axis', match: ['@axis.bank.in'] },
  { bank: 'yes',  match: ['@yes.bank.in'] }
];

function qpDecode(s){ return String(s||'').replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (m,h) => String.fromCharCode(parseInt(h,16))); }
function b64TextDecode(s){ try { return atob(String(s||'').replace(/[^A-Za-z0-9+\/=]/g, '')); } catch(e){ return ''; } }
function stripHtml(h){
  return String(h||'')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ');
}
// Walk a raw MIME message and return its readable text (prefers text/plain,
// falls back to tag-stripped text/html; recurses into nested multiparts).
function emailExtractText(raw){
  raw = String(raw||'');
  const hEnd = raw.search(/\r?\n\r?\n/);
  if (hEnd < 0) return stripHtml(qpDecode(raw));
  const head = raw.slice(0, hEnd), body = raw.slice(hEnd);
  const bm = head.match(/boundary="?([^";\r\n]+)"?/i);
  if (!bm){
    let pb = body;
    if (/content-transfer-encoding:\s*base64/i.test(head)) pb = b64TextDecode(pb);
    else if (/quoted-printable/i.test(head)) pb = qpDecode(pb);
    return /text\/html/i.test(head) ? stripHtml(pb) : stripHtml(qpDecode(pb));
  }
  const parts = body.split('--' + bm[1]);
  const plain = [], html = [];
  for (const part of parts){
    const pi = part.search(/\r?\n\r?\n/); if (pi < 0) continue;
    const ph = part.slice(0, pi), pbRaw = part.slice(pi);
    if (/boundary="?[^";\r\n]+"?/i.test(ph)) { const inner = emailExtractText(part); if (inner) plain.push(inner); continue; }
    let pb = pbRaw;
    if (/content-transfer-encoding:\s*base64/i.test(ph)) pb = b64TextDecode(pb);
    else if (/quoted-printable/i.test(ph)) pb = qpDecode(pb);
    if (/content-type:\s*text\/plain/i.test(ph)) plain.push(pb);
    else if (/content-type:\s*text\/html/i.test(ph)) html.push(stripHtml(pb));
  }
  return (plain.length ? plain.join(' ') : html.join(' ')).replace(/\s+/g, ' ');
}
// Per-bank CREDIT parsers — return null for anything that isn't a parseable credit.
function parseBankEmail(bank, t){
  t = String(t||'');
  if (bank === 'axis'){
    if (!/Amount\s+Credited/i.test(t)) return null;
    const am  = t.match(/Amount\s+Credited[^0-9]{0,60}?INR\s*([\d,]+(?:\.\d+)?)/i);
    const ref = t.match(/UPI\/[A-Z0-9]{1,8}\/(\d{9,18})\/([^\/\r\n<]{1,40})/i);
    const ac  = t.match(/Account\s+Number[^0-9]{0,40}?(\d{3,6})/i);
    if (!am || !ref) return null;
    return { amount: parseFloat(am[1].replace(/,/g,'')), ref: ref[1], payer: (ref[2]||'').trim() || null, acct: ac ? ac[1] : null };
  }
  if (bank === 'yes'){
    const am  = t.match(/INR\s*([\d,]+(?:\.\d+)?)\s+has\s+been\s+credited/i);
    const ref = t.match(/UPI:(\d{9,18})/i);
    const py  = t.match(/\/From:([\w.\-]+@[A-Za-z]+)/i);
    const ac  = t.match(/A\/?C\.?\s*No\.?\s*X*(\d{3,6})/i);
    if (!am || !ref) return null;
    return { amount: parseFloat(am[1].replace(/,/g,'')), ref: ref[1], payer: py ? py[1].replace(/\.$/,'') : null, acct: ac ? ac[1] : null };
  }
  return null;
}
// ===== END EMAIL INGEST =====

// ===== VERIFICATION MONITORING (scheduled) =====
// Runs on the hourly cron. Three jobs, all reading the live POS ledger + upiReview:
//   #1 2-hour alert  — any UPI payment unverified >2h → one summary push (once per payment)
//   #4 bank failure  — a bank's last 3 payments all unverified-past-2h → systemic alarm (per bank)
//   #2 weekly digest — Mondays: auto-verify stats for the past week
// Alert-state is persisted at monitor/* so nothing re-nags: each payId is alerted once, each
// bank's failure alarm fires once until the streak breaks.
const MON_UNVERIFIED_MS = 2*60*60000;     // "unverified" = manual/no-credit AND older than 2h
const MON_BANK_STREAK   = 3;              // consecutive past-2h failures for one bank → alarm

// ---- CASH LEAVING THE DRAWER ----
// Four ledger types take money out or write it off, and all four are gated behind
// a staff PIN that also stamps the name into `reason`.
//
// That stamp is not evidence. pos.html writes ledger entries straight from the
// browser and the rule on pos/ is only "has a staff role", so anyone who can open
// the till can push an entry with any name on it, without knowing a PIN at all.
// Hardening the PIN would not change that; the attribution is advisory either way.
//
// So this does not try to prevent it. It makes it visible the same hour instead of
// at end-of-day: the owner sees the amount, the reason and the name it claims, and
// the named person can say whether it was them.
const MON_CASHOUT_TYPES = ['expense', 'withdrawal', 'tip_payout', 'unpaid_writeoff'];
const MON_CASHOUT_MIN   = 500;            // ₹ — below this it is milk and gas, and a push
                                          //     nobody reads is worse than no push
const MON_CASHOUT_WINDOW_MS = 6*60*60000; // don't flood on first run after a deploy
const MON_CASHOUT_LOUD  = 2000;           // ₹ — named individually rather than summarised

// Which cash-outs are new enough, big enough, and not already reported.
// Pure, so the selection can be tested without a database.
function monNewCashOuts(entries, alerted, nowMs){
  const out = [];
  for (const e of entries){
    if (!e || !e.key || MON_CASHOUT_TYPES.indexOf(e.type) < 0) continue;
    if (alerted && alerted[e.key]) continue;
    if (!e.ts || (nowMs - e.ts) > MON_CASHOUT_WINDOW_MS) continue;
    const amt = Math.abs(parseFloat(e.amount) || 0);
    // A written-off bill is reported whatever its size — it is revenue disappearing,
    // not money spent, and it is rare enough that every one is worth seeing.
    if (amt < MON_CASHOUT_MIN && e.type !== 'unpaid_writeoff') continue;
    out.push(e);
  }
  return out.sort((a, b) => (Math.abs(parseFloat(b.amount)||0)) - (Math.abs(parseFloat(a.amount)||0)));
}

function monCashOutMessage(list){
  const money = n => '₹' + Math.round(n).toLocaleString('en-IN');
  const total = list.reduce((s, e) => s + Math.abs(parseFloat(e.amount) || 0), 0);
  const top = list[0];
  const topAmt = Math.abs(parseFloat(top.amount) || 0);
  const label = String(top.type || '').replace(/_/g, ' ');
  if (list.length === 1){
    return { title: money(topAmt) + ' ' + label,
             body: String(top.reason || '(no reason given)').slice(0, 200) };
  }
  return { title: money(total) + ' out of the drawer · ' + list.length + ' entries',
           body: 'largest ' + money(topAmt) + ' ' + label + ' — ' +
                 String(top.reason || '(no reason given)').slice(0, 140) };
}

async function monLoad(token, path){ try{ const r = await fetch(DB_URL + path + '.json?auth=' + token); return r.ok ? (await r.json()) : null; }catch(e){ return null; } }

// Determine each UPI ledger entry's effective verification state, folding in admin decisions.
function monEntryState(e, reviewMap){
  const rv = e && e.payId ? (reviewMap||{})[e.payId] : null;
  if (rv && rv.state === 'ignored') return 'ignored';        // admin resolved — not a failure
  if (rv && rv.state === 'verified') return 'verified';
  if (e && e.state === 'verified') return 'verified';        // bank credit matched
  return 'unverified';
}

async function runVerificationMonitor(nowMs, isWeekly){
  const token = await getRobotToken();
  const ledgerObj = await monLoad(token, '/pos/ledgerEntries') || {};
  const reviewMap = await monLoad(token, '/upiReview') || {};
  const monState  = await monLoad(token, '/monitor') || {};
  const alerted   = monState.alertedPayIds || {};     // payId -> true (already pinged for #1)
  const bankAlarm = monState.bankAlarm || {};         // bank -> true (alarm currently active)

  // all UPI entries, newest first. `all` keeps every entry WITH its push key, which
  // the cash-out check needs to remember what it has already reported.
  const entries = [], all = [];
  for (const k in ledgerObj){
    const e = ledgerObj[k]; if (!e) continue;
    all.push(Object.assign({ key: k }, e));
    if (e.type === 'upi_income') entries.push(e);
  }
  entries.sort((a,b)=> (b.ts||0) - (a.ts||0));

  // ---- #1: payments unverified past 2h (exclude admin-ignored — those are resolved) ----
  const overdue = [];
  for (const e of entries){
    if (!e.ts || (nowMs - e.ts) < MON_UNVERIFIED_MS) continue;
    if (monEntryState(e, reviewMap) === 'unverified') overdue.push(e);
  }
  const newOverdue = overdue.filter(e => e.payId && !alerted[e.payId]);
  const updates = {};
  if (newOverdue.length){
    const total = newOverdue.reduce((s,e)=> s + (parseFloat(e.amount)||0), 0);
    const n = newOverdue.length;
    await pushOwner(token,
      '⏳ ' + n + ' UPI payment' + (n>1?'s':'') + ' unverified >2h',
      '₹' + Math.round(total).toLocaleString('en-IN') + ' not confirmed by a bank credit. Tap to review.',
      'unverified-2h', '/admin.html');
    for (const e of newOverdue) updates['monitor/alertedPayIds/' + e.payId] = true;
  }

  // ---- #4: per-bank consecutive-failure alarm ----
  // Group past-2h entries by bank (from bankTag), in time order; if a bank's most recent
  // MON_BANK_STREAK past-2h payments are ALL unverified, the pipeline for that bank is likely
  // broken. If its latest past-2h payment verified, clear any existing alarm.
  const byBank = {};
  for (const e of entries){
    if (!e.ts || (nowMs - e.ts) < MON_UNVERIFIED_MS) continue;   // only settled-long-enough payments judge the pipeline
    const tag = e.bankTag ? String(e.bankTag).trim().toLowerCase().split(/\s+/)[0] : null;
    if (!tag) continue;
    (byBank[tag] = byBank[tag] || []).push(e);   // already newest-first from entries sort
  }
  for (const bank in byBank){
    const recent = byBank[bank].slice(0, MON_BANK_STREAK);
    const allFail = recent.length === MON_BANK_STREAK && recent.every(e => monEntryState(e, reviewMap) === 'unverified');
    const latestOk = byBank[bank][0] && monEntryState(byBank[bank][0], reviewMap) === 'verified';
    if (allFail && !bankAlarm[bank]){
      await pushOwner(token,
        '🚨 ' + bank.toUpperCase() + ' verification failing',
        'Last ' + MON_BANK_STREAK + ' ' + bank.toUpperCase() + ' payments went unverified — check that bank’s email pipeline.',
        'bankfail-' + bank, '/admin.html');
      updates['monitor/bankAlarm/' + bank] = true;
    } else if (latestOk && bankAlarm[bank]){
      updates['monitor/bankAlarm/' + bank] = null;   // pipeline recovered — clear so it can alarm again later
    }
  }

  // ---- cash leaving the drawer ----
  const cashOuts = monNewCashOuts(all, monState.alertedCashOut || {}, nowMs);
  if (cashOuts.length){
    const loud = cashOuts.filter(e => Math.abs(parseFloat(e.amount)||0) >= MON_CASHOUT_LOUD);
    const msg = monCashOutMessage(loud.length ? loud : cashOuts);
    await pushOwner(token, '💸 ' + msg.title, msg.body, 'cashout', '/admin.html');
    for (const e of cashOuts) updates['monitor/alertedCashOut/' + e.key] = true;
  }
  // prune alertedCashOut alongside alertedPayIds — EOD wipes the ledger, so the keys
  // it refers to stop existing and the map would otherwise grow forever
  const liveKeys = new Set(all.map(e => e.key));
  const alertedCash = monState.alertedCashOut || {};
  for (const k in alertedCash){ if (!liveKeys.has(k)) updates['monitor/alertedCashOut/' + k] = null; }

  // prune alertedPayIds that are no longer in the ledger (EOD wiped them) to bound growth
  if (Object.keys(alerted).length){
    const live = new Set(entries.map(e=>e.payId).filter(Boolean));
    for (const pid in alerted){ if (!live.has(pid)) updates['monitor/alertedPayIds/' + pid] = null; }
  }

  if (Object.keys(updates).length){
    try{ await fetch(DB_URL + '/.json?auth=' + token, { method:'PATCH', body: JSON.stringify(updates) }); }catch(e){}
  }

  // ---- #2: weekly digest (Mondays) ----
  if (isWeekly){ try{ await runWeeklyDigest(token, nowMs); }catch(e){} }
}

// Weekly digest from the EOD archive: how much verified vs manual vs ignored last 7 days.
async function runWeeklyDigest(token, nowMs){
  const arch = await monLoad(token, '/pos/eodArchive') || {};
  const weekAgo = nowMs - 7*24*60*60000;
  let verified=0, unverified=0, ignored=0, vAmt=0, uAmt=0, days=0;
  for (const key in arch){
    const day = arch[key]; if (!day || !Array.isArray(day.ledger)) continue;
    if (day.closedAt && day.closedAt < weekAgo) continue;
    days++;
    for (const e of day.ledger){
      if (!e || e.type !== 'upi_income') continue;
      const vs = e.verifyState || 'unverified';
      const amt = parseFloat(e.amount)||0;
      if (vs === 'ignored'){ ignored++; }
      else if (vs === 'verified-bank' || vs === 'verified-admin'){ verified++; vAmt += amt; }
      else { unverified++; uAmt += amt; }
    }
  }
  const totalN = verified + unverified + ignored;
  if (!totalN) return;   // nothing to report
  const pct = Math.round(100 * verified / totalN);
  await pushOwner(token,
    '📈 Weekly UPI verification',
    pct + '% auto-verified · ' + unverified + ' manual (₹' + Math.round(uAmt).toLocaleString('en-IN') + ') · ' + ignored + ' ignored, over ' + days + ' day' + (days>1?'s':'') + '.',
    'weekly-digest', '/admin.html');
}
// ===== END VERIFICATION MONITORING =====

// ============================================================================
//  CASH LEAVING THE DRAWER
// ============================================================================
// The one place a staff PIN authorises something instead of describing it.
//
// pos.html used to push these entries straight from the browser. The rule on pos
// is "has a staff role", so anyone who could open the till could record a
// withdrawal against a colleague's name without knowing a PIN at all — and the
// PIN prompt in front of it was a speed bump on a screen the same person
// controls. docs/database-access.md has said so for as long as it has existed.
//
// So the check moves here, where a browser cannot skip it. The caller sends a
// Firebase ID token and the PIN; this verifies both, resolves the name from
// staff itself, and writes the entry as the robot. The matching rule refuses
// these three types from anybody else, which is what turns the prompt into a gate.
//
// Three types, not four. expense, withdrawal and tip_payout each take cash out of
// the drawer on demand. unpaid_writeoff does not move cash — it records a bill
// that was never paid — and it happens inside end-of-day, which has to be
// completable when this Worker is not reachable. Blocking a cash-up on a network
// call would be a worse failure than the one being fixed.
const CASHOUT_TYPES = ['expense', 'withdrawal', 'tip_payout'];

// Public by construction: a literal in pos.html, admin.html and inventory.html,
// all served from ila.cafe. Hiding it was never the point — a PIN checked in a
// browser is skippable whatever it is hashed with. What this buys is that the
// entry cannot be written without passing through here.
const PIN_SALT = 'ila-cafe-pin-v1::8D6E52';

async function pinToName(pin, token){
  const raw = String(pin == null ? '' : pin).trim();
  if (!raw) return null;
  let map;
  try {
    const res = await fetch(DB_URL + '/staff.json?auth=' + token);
    if (!res.ok) return null;
    map = await res.json();
  } catch (e) { return null; }
  if (!map || typeof map !== 'object') return null;
  const buf = await crypto.subtle.digest('SHA-256', _enc.encode(PIN_SALT + raw));
  const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  const name = map[hash];
  return (typeof name === 'string' && name.trim()) ? name : null;
}

// The ledger's `date` is a display string the till shows as-is, and the café is in
// India. A Worker runs in UTC, so writing its own local time would put every entry
// five and a half hours out on the one screen anybody reads it on.
function istClock(ms){
  const d = new Date(ms + 5.5 * 3600000);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return String(h12).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ' ' + ampm;
}

async function handleCashout(data, claims){
  const type = String((data && data.type) || '');
  if (CASHOUT_TYPES.indexOf(type) < 0) return { status: 400, body: { error: 'unknown cash-out type' } };

  const amount = Number(data && data.amount);
  if (!(amount > 0) || !isFinite(amount) || amount > 1000000) {
    return { status: 400, body: { error: 'amount must be a positive number' } };
  }
  // Free text, and it ends up in a push notification and on the ledger screen.
  const reason = String((data && data.reason) || '')
    .replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200);
  if (!reason) return { status: 400, body: { error: 'a reason is required' } };

  let token;
  try { token = await getRobotToken(); } catch (e) { return { status: 502, body: { error: 'could not sign in' } }; }

  const name = await pinToName(data && data.pin, token);
  if (!name) return { status: 403, body: { error: 'invalid pin' } };

  // One write, not two. The ledger line and the drawer move together or not at
  // all — a line with no drawer movement, or the reverse, is a till that cannot be
  // reconciled against the cash actually in it.
  const now = Date.now();
  const key = 'co-' + now + '-' + Math.random().toString(36).slice(2, 8);
  const updates = {};
  updates['pos/ledgerEntries/' + key] = {
    date: istClock(now),
    type: type,
    amount: amount,
    reason: reason + ' (' + name + ')',
    ts: { '.sv': 'timestamp' },
    by: name,                 // what the PIN said
    byUid: claims.sub         // and who was actually signed in, which a PIN cannot forge
  };
  updates['pos/cashDrawer'] = { '.sv': { increment: -amount } };

  try {
    const res = await fetch(DB_URL + '/.json?auth=' + token, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates)
    });
    if (!res.ok) return { status: 502, body: { error: 'could not record the entry' } };
  } catch (e) { return { status: 502, body: { error: 'could not record the entry' } }; }

  return { status: 200, body: { ok: true, key: key, by: name, type: type, amount: amount } };
}

// ============================================================================
//  STOCK MOVING ON AND OFF THE SHELF
// ============================================================================
// Same argument as the cash-out above, and the same fix, but this one closes the
// hole completely where that one could not.
//
// inventory.html checked a PIN in the page and then wrote inventory/stock itself.
// The rule on inventory was "has a staff role", so the PIN was advice twice over:
// the prompt ran in a browser the same person controls, AND the write did not need
// the prompt at all. Someone covering shrinkage could adjust stock directly and
// leave no log line, which is worse than a log line with the wrong name on it.
//
// inventory/stock and inventory/logs are written by exactly one page, so unlike the
// till there is nothing that has to keep working when this Worker is unreachable —
// a delivery can be logged ten minutes later. That is what makes it possible to say
// the robot is the only writer, and mean it.
//
// The recipe is read here rather than sent. A client that computes its own
// deductions can under-report what a batch consumed, which is the whole point of
// having a recipe.
const INV_KINDS = ['receive', 'prep'];

// Item names become database paths. A name carrying a slash would write somewhere
// else entirely; Firebase forbids the rest of these outright, and a client is not
// the place to find that out.
function invSafeKey(name){
  const k = String(name == null ? '' : name).trim();
  if (!k || k.length > 120) return null;
  if (/[.$#\[\]\/]/.test(k)) return null;
  for (let i = 0; i < k.length; i++) if (k.charCodeAt(i) < 32 || k.charCodeAt(i) === 127) return null;
  return k;
}

async function handleInventoryLog(data, claims){
  const kind = String((data && data.kind) || '');
  if (INV_KINDS.indexOf(kind) < 0) return { status: 400, body: { error: 'unknown kind' } };

  const item = invSafeKey(data && data.item);
  if (!item) return { status: 400, body: { error: 'bad item name' } };

  const qty = Number(data && data.qty);
  if (!(qty > 0) || !isFinite(qty) || qty > 100000) {
    return { status: 400, body: { error: 'quantity must be a positive number' } };
  }

  let token;
  try { token = await getRobotToken(); } catch (e) { return { status: 502, body: { error: 'could not sign in' } }; }

  const staff = await pinToName(data && data.pin, token);
  if (!staff) return { status: 403, body: { error: 'invalid pin' } };

  const now = Date.now();
  const updates = {};
  let entry;

  if (kind === 'receive') {
    updates['inventory/stock/' + item] = { '.sv': { increment: qty } };
    entry = { action: 'Delivery Received', item: item, amount: qty, staff: staff };
  } else {
    let recipe = null;
    try {
      const res = await fetch(DB_URL + '/inventory/recipes/' + encodeURIComponent(item) + '.json?auth=' + token);
      if (res.ok) recipe = await res.json();
    } catch (e) { return { status: 502, body: { error: 'could not read the recipe' } }; }
    if (!recipe || typeof recipe !== 'object' || !Object.keys(recipe).length) {
      return { status: 400, body: { error: 'no recipe for ' + item } };
    }
    updates['inventory/stock/' + item] = { '.sv': { increment: qty } };
    const used = [];
    for (const raw in recipe) {
      const rawKey = invSafeKey(raw);
      const per = Number(recipe[raw]);
      if (!rawKey || !isFinite(per) || per < 0) return { status: 400, body: { error: 'the recipe for ' + item + ' is not usable' } };
      if (rawKey === item) return { status: 400, body: { error: 'the recipe for ' + item + ' consumes itself' } };
      const off = per * qty;
      updates['inventory/stock/' + rawKey] = { '.sv': { increment: -off } };
      used.push(off + ' of ' + rawKey);
    }
    entry = { action: 'Prepped Batch', item: item, yieldAmount: qty, staff: staff,
              deductions: used.join(' | ') };
  }

  entry.at = now;
  entry.time = istClock(now);
  entry.byUid = claims.sub;          // the account, which a borrowed PIN cannot forge
  const key = 'inv-' + now + '-' + Math.random().toString(36).slice(2, 8);
  updates['inventory/logs/' + key] = entry;

  // The stock movement and the line explaining it go in one write. Stock that moved
  // with no log is exactly the state this is here to make impossible.
  try {
    const res = await fetch(DB_URL + '/.json?auth=' + token, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates)
    });
    if (!res.ok) return { status: 502, body: { error: 'could not record it' } };
  } catch (e) { return { status: 502, body: { error: 'could not record it' } }; }

  return { status: 200, body: { ok: true, key: key, staff: staff, item: item, qty: qty, kind: kind } };
}

export default {
  async fetch(request, env){
    loadConfig(env);
    if (request.method === 'OPTIONS') return new Response(null, { status:204, headers: CORS });
    if (request.method !== 'POST') return json({ error:'POST only' }, 405);

    let data;
    try { data = JSON.parse(await request.text()); } catch (e) { return json({ error:'bad json' }, 400); }

    // Recalibration is gated by RECAL_SECRET, NOT the old push secret.
    //
    // That secret was a literal in pos.html, admin.html, barista.html and
    // chef.html — served from ila.cafe, so it was public by construction and
    // anyone could read it with view-source. It used to authorise these two
    // routes as well, which meant a stranger could force a refit. The refit
    // itself is fenced by rcCheckGates, but each run does
    // modelPrevious = current before writing: call it twice and the snapshot
    // is the model you just wrote, so the rollback to the last good model is
    // gone. It also pushes to every admin device and the dry run returns the
    // café's prep times and margins.
    //
    // This is the same rule INGEST_SECRET already follows, for the same
    // reason. RECAL_SECRET must never appear in a page.
    if (data && data.action === 'recalibrate-dryrun' && authOk(data.secret, RECAL_SECRET)) {
      const r = await runRecalibration(true);  return json(r);
    }
    if (data && data.action === 'recalibrate-now' && authOk(data.secret, RECAL_SECRET)) {
      const r = await runRecalibration(false); return json(r);
    }
    // Named but not authorised: say so, rather than falling through to the push
    // relay and returning a confusing 'unauthorized' from a different route.
    if (data && (data.action === 'recalibrate-dryrun' || data.action === 'recalibrate-now')) {
      return json({ error:'unauthorized' }, 401);
    }

    // Cash out of the drawer. A staff token says who is asking, the PIN says who is
    // accountable, and the rules say nobody else may write these at all.
    if (data && data.action === 'cashout') {
      const who = await verifyIdToken(data.token);
      if (!who) return json({ error:'unauthorized' }, 401);
      if (who.firebase && who.firebase.sign_in_provider === 'anonymous') {
        return json({ error:'forbidden' }, 403);
      }
      if (!(await staffRoleOf(who.sub))) return json({ error:'forbidden' }, 403);
      const r = await handleCashout(data, who);
      return json(r.body, r.status);
    }

    // Stock on and off the shelf. Same shape as the cash-out: a staff token says who
    // is asking, the PIN says who is accountable, and the rules leave the robot as the
    // only writer of inventory/stock and inventory/logs.
    if (data && data.action === 'inventory-log') {
      const who = await verifyIdToken(data.token);
      if (!who) return json({ error:'unauthorized' }, 401);
      if (who.firebase && who.firebase.sign_in_provider === 'anonymous') {
        return json({ error:'forbidden' }, 403);
      }
      if (!(await staffRoleOf(who.sub))) return json({ error:'forbidden' }, 403);
      const r = await handleInventoryLog(data, who);
      return json(r.body, r.status);
    }

    // Payment ingest route — separate secret, separate handler.
    if (new URL(request.url).pathname.replace(/\/+$/,'').endsWith('/ingest')) {
      const r = await handleIngest(data);
      return json(r.body, r.status);
    }

    // Default route: push relay.
    //
    // data.secret is deliberately ignored here. It is still sent by pages built
    // before this change (see the transitional block in each page), and honouring
    // it would leave the hole open, because that secret is public.
    const claims = await verifyIdToken(data && data.token);
    if (!claims) return json({ error:'unauthorized' }, 401);
    // The ordering page signs in anonymously; a customer must not be able to push.
    if (claims.firebase && claims.firebase.sign_in_provider === 'anonymous') {
      return json({ error:'forbidden' }, 403);
    }
    const role = await staffRoleOf(claims.sub);
    if (!role) return json({ error:'forbidden' }, 403);

    // Recipients come from the database, never from the caller — otherwise the
    // Worker is an open relay that signs anyone's push with the café's VAPID key.
    let subs = [], relayToken = null;
    try {
      relayToken = await getRobotToken();
      const res = await fetch(DB_URL + '/pushSubscriptions.json?auth=' + relayToken);
      subs = unwrapSubs(res.ok ? (await res.json()) : null);
    } catch (e) { return json({ error:'could not read subscriptions' }, 502); }
    if (!subs.length) return json({ ok:true, sent:0, failed:0, results:[] });

    const payload = _enc.encode(JSON.stringify(safeNotification(data.notification)));

    let sent = 0, failed = 0, expired = 0; const results = [];
    for (const { key, sub } of subs) {
      try {
        const status = await sendOne(sub, payload);
        if (status >= 200 && status < 300) { sent++; results.push({ status }); continue; }
        failed++;
        const gone = status === 404 || status === 410;
        results.push({ status, expired: gone });
        // This route used to report `expired` and leave the record in place, so the
        // same dead device was retried on every push from every till, forever.
        if (gone) {
          expired++;
          await fetch(DB_URL + '/pushSubscriptions/' + encodeURIComponent(key) + '.json?auth=' + relayToken,
                      { method:'DELETE' }).catch(()=>{});
        }
      } catch (e) { failed++; results.push({ error: String((e && e.message) || e) }); }
    }
    await recordPushHealth(relayToken, { devices: subs.length, delivered: sent, expired, failed, title: 'relay' });
    return json({ ok:true, sent, failed, expired, results, by: role });
  },

  async scheduled(event, env, ctx){
    loadConfig(env);
    // Branch by which cron fired. The monthly cron (0 20 1 * *) runs recalibration.
    // The hourly cron (0 * * * *) runs the verification monitor; on Mondays it also
    // emits the weekly digest. event.cron is the matched schedule string.
    const cron = event && event.cron ? event.cron : '';
    const now = Date.now();
    if (cron === '0 20 1 * *'){
      ctx.waitUntil(reportIfItThrows('recalibration', runRecalibration(false)));
    } else {
      const isMonday = new Date(now).getUTCDay() === 1;   // digest once a week on Monday ticks
      const isWeeklySlot = isMonday && new Date(now).getUTCHours() === 4;   // ~one tick/week (04:00 UTC Mon)
      ctx.waitUntil(reportIfItThrows('monitor', runVerificationMonitor(now, isWeeklySlot)));
    }
  },

  // Email Routing entry point: bank credit alert -> parse -> payments/incoming.
  // Raw is read FIRST (reading after forward() can fail if the runtime consumes
  // the stream while forwarding). Every stage logs, so a live log tail names the
  // exact failing stage of any email.
  async email(message, env, ctx){
    loadConfig(env);
    let stage = 'start';
    try {
      stage = 'raw';
      let raw = '';
      try { raw = await new Response(message.raw).text(); }
      catch(e){ console.log('upi-email: raw read failed:', e && e.message); }
      stage = 'forward';
      try { if (EMAIL_FORWARD_TO) await message.forward(EMAIL_FORWARD_TO); } catch(e){ console.log('upi-email: forward failed:', e && e.message); }
      stage = 'sender';
      let fromHdr = ''; try { fromHdr = String(message.headers.get('from') || ''); } catch(e){}
      const from = (String(message.from || '') + ' ' + fromHdr).toLowerCase();
      const hit = EMAIL_SENDER_BANKS.find(b => b.match.some(s => from.includes(s)));
      if (!hit){ console.log('upi-email: sender not a known bank |', from); return; }
      console.log('upi-email: bank=' + hit.bank + ' rawLen=' + raw.length);
      stage = 'parse';
      const text = emailExtractText(raw);
      const p = parseBankEmail(hit.bank, text);
      if (!p || !p.amount || !p.ref){ console.log('upi-email: not a parseable credit (' + hit.bank + ') textLen=' + text.length + ' head=' + text.slice(0, 140)); return; }
      stage = 'token';
      const token = await getRobotToken();
      stage = 'write';
      const payment = { amount: p.amount, payer: p.payer || null, ref: String(p.ref), source: hit.bank + '-email', bank: hit.bank, acct: p.acct || null, bankTime: null, at: Date.now() };
      const res = await fetch(DB_URL + '/payments/incoming/' + encodeURIComponent(String(p.ref)) + '.json?auth=' + token, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payment) });
      console.log('upi-email: OK ' + hit.bank + ' ' + p.amount + ' ref ' + p.ref + ' acct ' + (p.acct || '-') + ' -> ' + res.status);
    } catch(e){ console.log('upi-email error at stage=' + stage + ':', e && (e.stack || e.message)); }
  }
};
