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
let HEARTBEAT_URL;

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
  // Where a finished cron says so. Optional: unset means nothing is watching,
  // which is the state this Worker ran in until it was added.
  HEARTBEAT_URL    = env.HEARTBEAT_URL;
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
// ---- When the BANK says the money moved ------------------------------------
// `at` is when this Worker ingested the alert. That is the arrival clock, it is
// what payments/incoming is indexed and ordered by, and it stays exactly as it
// is. What it is NOT is when the customer paid: a bank alert can sit in a queue
// for hours, and does. The POS ties a credit to a settlement by how close the
// two are in time, so on a delayed alert it was measuring the delay rather than
// the payment, and a genuine credit could arrive too late to be tied to the sale
// it belonged to. Worse in the other direction: with only an ingest clock, a
// payment made BEFORE a customer had even ordered still looked like it could be
// theirs, because its email happened to land afterwards.
//
// So the bank's own stated time is parsed out and written alongside, as epoch
// millis. Two rules make it safe to trust:
//   - null unless BOTH a date and a time were found, and found together. A date
//     alone means midnight, which is up to 24 hours wrong — worse than nothing.
//   - null unless the result is sane against the clock: not in the future, not a
//     fortnight old. A month/day swap or a two-digit-year slip then yields
//     nothing rather than a confident wrong answer.
// Every reader falls back to `at` when it is null, so a format this does not
// recognise leaves the behaviour exactly as it was.
//
// IST, done by hand and not by Date.parse. Indian bank alerts print a local wall
// clock and either say "IST" or say nothing; none of them carry an offset a date
// parser would honour, so parsing one as UTC is a 5.5-hour error sitting inside a
// 3-hour matching window — which would attach credits to the wrong sales rather
// than fail visibly.
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const MONTH3 = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
function parseBankTime(text, nowMs){
  const t = String(text || '');
  const now = (typeof nowMs === 'number' && isFinite(nowMs)) ? nowMs : Date.now();
  // A date and a time have to belong to each other. Scanning for each separately
  // would happily pair a date in the header with a clock time from a footer, so a
  // time is only accepted from the text immediately around the date it sits with.
  const TIME = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?|(\d{1,2}):(\d{2})(?::(\d{2}))?/;
  const forms = [
    // 12-Aug-2025, 01 Sep 26 — a named month cannot be confused with a day
    { re: /(\d{1,2})[-\/\s]([A-Za-z]{3,9})[-\/\s](\d{2,4})/g, named: true },
    // 12-08-2025, 01/09/26 — Indian alerts are day first
    { re: /(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})/g, named: false }
  ];
  for (const form of forms){
    form.re.lastIndex = 0;
    let m;
    while ((m = form.re.exec(t)) !== null){
      let d = parseInt(m[1], 10);
      let mo = form.named ? (MONTH3[String(m[2]).slice(0, 3).toLowerCase()] || 0) : parseInt(m[2], 10);
      let y = parseInt(m[3], 10);
      if (!d || !mo || !y) continue;
      if (y < 100) y += 2000;
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      // the clock that goes with THIS date: just before it, or just after it
      const from = Math.max(0, m.index - 25);
      const to = Math.min(t.length, m.index + m[0].length + 40);
      const near = t.slice(from, to);
      const tm = near.match(TIME);
      if (!tm) continue;
      const ampm = tm[4] ? String(tm[4]).toLowerCase() : '';
      let h  = parseInt(ampm ? tm[1] : tm[5], 10);
      const mi = parseInt(ampm ? tm[2] : tm[6], 10);
      const se = parseInt((ampm ? tm[3] : tm[7]) || '0', 10);
      if (!isFinite(h) || !isFinite(mi) || !isFinite(se)) continue;
      if (ampm === 'p' && h < 12) h += 12;
      if (ampm === 'a' && h === 12) h = 0;
      if (h > 23 || mi > 59 || se > 59) continue;
      const ms = Date.UTC(y, mo - 1, d, h, mi, se) - IST_OFFSET_MS;
      if (!isFinite(ms)) continue;
      if (ms > now + 6 * 60000) continue;              // an alert is about the past
      if (ms < now - 14 * 24 * 3600000) continue;      // and about the recent past
      return ms;
    }
  }
  return null;
}

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
// Drop the cached token. An isolate stays warm for a long time, and a token that has
// stopped being accepted — the account's password rotated, the session revoked, this
// isolate's clock out far enough that a valid token reads as expired — is otherwise
// reused until it would have expired anyway, with every write in between refused. The
// one thing that knows a token is bad is the response that rejected it, so that is
// where this is called from.
function forgetRobotToken(){ _robotTok=null; _robotExp=0; }
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

// One authenticated write, and one retry on the only failure a retry can fix.
//
// A 401 or 403 from the database means the token was not accepted, and the token is
// cached for the life of the isolate — so without this the first rejection poisons
// every write that isolate makes afterwards. Anything else (a validation failure, a
// network error) is not a credentials problem and is handed back as it is.
async function dbPut(pathWithoutJson, body){
  let token = await getRobotToken();
  const go = (t) => fetch(DB_URL + pathWithoutJson + '.json?auth=' + t, {
    method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  let res = await go(token);
  if(res.status === 401 || res.status === 403){
    forgetRobotToken();
    token = await getRobotToken();
    res = await go(token);
  }
  return res;
}

// ---- Ingest: parse one alert, write payments/incoming/{ref} -----------------
// Keyed by the bank reference so a re-sent alert overwrites itself (idempotent).
// Match-state is NOT stored here — the POS claims under payments/claims/{ref} —
// so a re-ingest can never wipe a match.
async function handleIngest(data){
  if(!data || !authOk(data.secret, INGEST_SECRET)) return { status:401, body:{ error:'unauthorized' } };
  const p = parsePayment(data.source, data.text||'');
  if(!p || !p.amount || !p.ref) return { status:422, body:{ error:'could not parse', parsed:p } };
  // bankTime is EPOCH MILLIS or null. parseAxis also lifts the raw "Date & Time:"
  // string, which is the human-readable half and not something a matcher can use,
  // so the number is taken from the whole alert rather than from that field.
  const _now = Date.now();
  const payment = { amount:p.amount, payer:p.payer||null, ref:String(p.ref), source:p.source,
    acct:p.acct||null, bankTime: parseBankTime(data.text||'', _now), at: _now };
  let res;
  try { res = await dbPut('/payments/incoming/' + encodeURIComponent(p.ref), payment); }
  catch(e){ return { status:502, body:{ error:String(e.message||e) } }; }
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
// Hard sanity bounds (minutes). Every one of these is now READ. drinkBase, bakedBase,
// ovenMax and satMax were declared here from the beginning and checked nowhere: a
// refit could hand back a saturation curve that added forty minutes at an empty
// counter, or an item base of an hour, and every gate passed it. The bounds read as
// protection and were decoration.
const RECAL_BOUNDS = {
  pizzaBase: [4, 20], drinkBase: [2, 15], bakedBase: [1, 12],
  ovenMax: [0, 35], satMax: [0, 40], cushion: [0, 15], margin: [0, 15]
};

// ---- how the curves are cut ----
// Bands used to be fixed edges guessed in advance ([0,2],[3,4],[5,7],[8,99]) and each
// band's point was emitted at its LOWER EDGE while carrying the median of the whole
// band. interp then read that as the value AT the edge, which tilts every curve left
// by half a band. Bands are cut at the pool's own distinct values now, sized to clear
// the sample gate, and each point sits at its band's median x — where the evidence
// actually is. It also means a curve no longer needs edges rewritten by hand when the
// thing it is measured against changes scale.
const RECAL_MAX_BANDS = 6;

// "Quiet" and "hot", in the units the derivation itself computes. Load is measured in
// ITEMS ahead (see rcAttachLoad), not tickets.
const RECAL_QUIET_AHEAD = 3;
const RECAL_HOT_IDLE    = 10;

// ---- what the refit is actually trying to be good at ----
// The café's accuracy report scores one number: the share of orders that finished
// inside the quote. The refit never computed it. It fitted medians and p85/p95 spreads
// on filtered pools, checked that nothing looked absurd, and shipped — so "the model
// got better" was an assumption, never a measurement, and a refit that made the café
// less accurate passed every gate it had.
//
// The newest slice of the window is now held back from the fit and used to score the
// candidate and the incumbent against each other on orders neither was fitted to. The
// cushions are then calibrated until the candidate actually hits the coverage target,
// instead of assuming p85 of a filtered pool lands there.
const RECAL_HOLDOUT_FRAC     = 0.20;   // newest share of the window kept out of the fit
const RECAL_TARGET_COVERAGE  = 0.85;   // the share of orders that should finish inside the quote
const RECAL_COVERAGE_SLACK   = 0.02;   // candidate may not be worse than the incumbent by more than this
const RECAL_ERR_SLACK        = 1.10;   // nor worse than 1.10x on median absolute error
// The cushion is adjusted as `cushion * scale + offset`, searched in two passes.
//
// Scaling first, because the derived cushions differ by category on purpose — a
// dessert's spread is genuinely small and a cooling pizza's is not — and scaling keeps
// that shape. But scaling alone cannot inflate a cushion derived at nearly nothing, and
// that is exactly the case where the estimate needs help: a pool whose spread looked
// tight in the fitting window against a service with a long right tail. So when no
// scale reaches the target, the second pass leaves the shape alone and adds minutes.
const RECAL_CUSHION_SCALES   = [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.4, 1.6, 1.8, 2.0, 2.5, 3.0];
const RECAL_CUSHION_OFFSETS  = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8];

// What counts as a pizza. The live answer is eta/model.pizzaKeys — the same list
// pos.html and index.html classify by — and this literal is now only what is used
// when that read gives nothing usable.
//
// It was a second, independent list, and the two had to agree with nothing checking
// that they did. The Worker's copy is the one that fails silently. Put a pizza on
// the menu whose name matches neither list — Diavola, Truffle & Honey — and the till
// quotes the wrong prep time, which somebody notices; here the order simply stops
// contributing to pizzaBase and stops counting toward RECAL_MIN_N.pizzaBaseAll, so a
// refit declines for want of volume that is sitting in the data. Nothing throws and
// the health panel says nothing: it looks like a quiet quarter.
//
// Keeping the literal as a fallback rather than deleting it is deliberate. A refit
// that cannot read the model must not silently classify nothing as a pizza — that is
// the same silent failure with the numbers moved.
const RC_PIZZA_FALLBACK = ["margherita","funghi","burrata","formaggi","marc","pizza","fav","quattro","vodka"];
// And the same for what counts as a dessert, for exactly the same reasons. This was a
// literal the refit classified by while every page classified by eta/model.bakedKeys —
// the pizza list's problem with the numbers moved, and quieter, because the categories
// it decides (cushionBaked, margin.baked) have the smallest samples in the model.
const RC_BAKED_FALLBACK = ["cake","bread","banana"];

// Set once per refit, by rcDerive, before it reads anything. Module state because
// rcIsPizza is reached from four functions inside one derivation and threading a
// parameter through each buys nothing: rcDerive is the only entry point. The same
// shape as the robot token and JWKS caches above, and safe for the same reason —
// a warm isolate carrying the previous run's value is overwritten before use.
let _rcPizzaKeys = RC_PIZZA_FALLBACK;
let _rcBakedKeys = RC_BAKED_FALLBACK;

// Returns which list it settled on, so the caller can report it rather than absorb
// it. A refit running on the fallback is not an error, but it is a fact about how
// the numbers below were derived, and it is invisible everywhere else.
function rcUsePizzaKeys(keys){
  const clean = rcCleanKeys(keys);
  _rcPizzaKeys = clean.length ? clean : RC_PIZZA_FALLBACK;
  return clean.length ? 'model' : 'fallback';
}
function rcUseBakedKeys(keys){
  const clean = rcCleanKeys(keys);
  _rcBakedKeys = clean.length ? clean : RC_BAKED_FALLBACK;
  return clean.length ? 'model' : 'fallback';
}
function rcCleanKeys(keys){
  return Array.isArray(keys)
    ? keys.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim().toLowerCase())
    : [];
}

function rcIsPizza(name){ const n=(name||'').toLowerCase(); return _rcPizzaKeys.some(k=>n.includes(k)); }
function rcIsBaked(name){ const n=(name||'').toLowerCase(); return _rcBakedKeys.some(k=>n.includes(k)); }
function rcQty(it){ const q=parseInt(it&&it.qty); return isNaN(q)?1:q; }

// "Every item on this ticket is a dessert" — and there is at least one item.
//
// This was a bare Object.keys(o.items).every(rcIsBaked) in four places, and every() on
// an empty array is true. rcLoadCompleted defaults a missing item map to {}, so any
// completed record that lost its items — a merged bill, a voided line — was filed as an
// all-dessert order and went into cushionBaked and margin.baked, which are the two
// numbers in the model with the smallest and most tightly clustered samples.
function rcAllBaked(items){
  const names = Object.keys(items || {});
  return names.length > 0 && names.every(rcIsBaked);
}
function rcAnyPizza(items){ return Object.keys(items || {}).some(rcIsPizza); }

// The work on a ticket, not the fact of it.
function rcWork(o){
  let q = 0;
  for(const nm in (o.items || {})) q += rcQty(o.items[nm]);
  return q || 1;        // a ticket whose items cannot be read still occupies the station
}

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
//
// A WINDOW, NOT THE WHOLE HISTORY.
//
// orders/completed/{station} is the largest node in this database and nothing ever
// removes from it: one record per ticket, with its items, for as long as the café has
// been open. This read had no limit on it — every ticket ever cooked, pulled into a
// Worker, so that the 75 days below could be picked out of it in the loop. It is a
// monthly job, so nothing about it looks slow until the day it simply cannot finish,
// and a refit that stops running does not break anything anyone can see: the model
// freezes and the estimates drift.
//
// Keys are push keys, so key order is creation order and the newest tickets are the
// last ones — limitToLast on $key gives the recent end and needs no index. The cap is
// set well above what the window can hold rather than near it (RECAL_LOOKBACK_DAYS at
// the café's own rate is a few thousand a station), and truncation is reported rather
// than absorbed: `truncated` says the oldest ticket returned is still INSIDE the
// window, which means the window was cut short and the refit is working from less
// evidence than it believes.
const RECAL_MAX_RECORDS = 20000;
async function rcLoadCompleted(token){
  const since = Date.now() - RECAL_LOOKBACK_DAYS*86400*1000;
  const out=[];
  out.truncated = false;
  for(const station of ['chef','barista']){
    const url = DB_URL + '/orders/completed/' + station + '.json?orderBy=%22%24key%22&limitToLast=' +
                RECAL_MAX_RECORDS + '&auth=' + token;
    const res = await fetch(url);
    if(!res.ok) continue;
    const data = await res.json();
    if(!data) continue;
    // The cap was reached AND the oldest thing it returned is still in the window, so
    // there were tickets inside the window that this read did not see.
    if(Object.keys(data).length >= RECAL_MAX_RECORDS){
      let oldest = Infinity;
      for(const id in data){ const c = data[id] && data[id].completedAt; if(c && c < oldest) oldest = c; }
      if(oldest > since) out.truncated = true;
    }
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

// ---- compute "work ahead" (load) per order: same-station intervals active at its start ----
//
// This counted TICKETS. A ticket of six pizzas and a single espresso were the same
// number to it, which is not how either station experiences a queue — and it is the
// variable the whole saturation curve is fitted against, so the curve was being asked
// to explain the wait using a number that does not describe the load causing it.
//
// It counts the items in those tickets now. That changes the x-scale of the saturation
// curves, so a model fitted this way declares loadUnit:'items' and the pages read the
// item-weighted queue the till publishes alongside the ticket counts. A model still on
// its seeds says 'tickets' and keeps reading the ticket counts. The two can't be mixed.
function rcAttachLoad(orders){
  for(const station of ['chef','barista']){
    const arr = orders.filter(o=>o.station===station);
    const work = arr.map(rcWork);
    for(let i=0;i<arr.length;i++){
      const o = arr[i];
      let ahead=0;
      for(let j=0;j<arr.length;j++){ const c=arr[j]; if(c.start<o.start && c.done>o.start) ahead += work[j]; }
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
  if(!rcAllBaked(o.items)) return false;                       // only desserts (and only if there ARE items)
  if(o.dur <= 6) return false;                                 // quick = served now, keep
  // any non-dessert order at same table overlapping this dessert's window?
  for(const c of orders){
    if(c===o) continue;
    if(c.table!==o.table) continue;
    if(rcAllBaked(c.items)) continue;                          // need a real meal item
    if(c.start <= o.done && c.done >= o.start) return true;    // overlapping meal => after-food
  }
  return false;
}

// ---- banding: cut the evidence where the evidence is ----
//
// Every curve in this model is "how much does X add", fitted by grouping orders on X
// and taking each group's median. The grouping used to be fixed edges written into
// this file — [0,2],[3,4],[5,7],[8,99] — and each group's point was emitted at the
// group's LOWER EDGE while carrying the median of the whole group. interp() on the
// pages then read that value as the value AT the edge, so every curve was tilted half
// a band to the left: the cost of being four items deep was charged from three.
//
// Bands are cut here from the pool's own distinct values, grown until each clears the
// sample gate, and each point is placed at its band's MEDIAN x. Nothing needs rewriting
// when the variable changes scale, and no band is ever emitted from fewer orders than
// the gate asks for. A distinct x is never split across two bands, which is what keeps
// the representative x values strictly increasing — interp divides by the gap between
// consecutive points, so a repeat would be a division by zero.
function rcBands(pool, xOf, minN){
  if(!pool || !pool.length) return null;
  const byX = new Map();
  let n = 0;
  for(const o of pool){
    const x = xOf(o);
    if(x == null || !isFinite(x)) continue;
    if(!byX.has(x)) byX.set(x, []);
    byX.get(x).push(o);
    n++;
  }
  if(n < minN*2) return null;            // fewer than two bands' worth: nothing to say about a slope
  const xs = [...byX.keys()].sort((a,b)=>a-b);
  const per = Math.max(minN, Math.ceil(n / RECAL_MAX_BANDS));
  const bands = [];
  let bucket = [];
  for(const x of xs){
    bucket = bucket.concat(byX.get(x));
    if(bucket.length >= per){ bands.push(bucket); bucket = []; }
  }
  // the tail is merged into the last band rather than emitted short
  if(bucket.length){ if(bands.length) bands[bands.length-1] = bands[bands.length-1].concat(bucket); else bands.push(bucket); }
  return bands.length >= 2 ? { bands, xOf } : null;
}

// A curve of ADDED minutes over x, differenced against its own quietest band.
//
// This is the fix for the saturation bug. satChef() used to pool pizzas at every oven
// idle and then subtract a baseline fitted on hot ones only, so the number it handed
// back at an empty counter was the cost of a cooling oven wearing a saturation label —
// and the estimate added ovenCurve on top of it. Differencing against the pool's OWN
// first band means whatever else is going on in the pool is in the baseline too, and
// cancels. The two terms are independent for the first time.
function rcCurve(pool, xOf, minN){
  const b = rcBands(pool, xOf, minN);
  if(!b) return null;
  const meds = b.bands.map(band => rcMedian(rcIQRClean(band.map(o=>o.dur))));
  const baseline = meds[0];
  if(baseline == null) return null;
  const pts = [];
  for(let i=0;i<b.bands.length;i++){
    if(meds[i] == null) continue;
    const mx = rcMedian(b.bands[i].map(xOf));
    if(mx == null) continue;
    const x = +mx.toFixed(1);
    if(pts.length && x <= pts[pts.length-1][0]) continue;
    pts.push([x, Math.max(0, +(meds[i]-baseline).toFixed(1))]);
  }
  return pts.length >= 2 ? { points: pts, baseline: +baseline.toFixed(1), n: pool.length } : null;
}

// A curve of CUSHION over x: how far past its own median a band's 85th percentile sits.
// Absolute, not a delta — a cushion is padding, not an addition to a base time.
function rcSpreadCurve(pool, xOf, minN){
  const b = rcBands(pool, xOf, minN);
  if(!b) return null;
  const pts = [];
  for(const band of b.bands){
    const cleaned = rcIQRClean(band.map(o=>o.dur));
    if(!cleaned.length) continue;
    const mx = rcMedian(band.map(xOf));
    if(mx == null) continue;
    const x = +mx.toFixed(1);
    if(pts.length && x <= pts[pts.length-1][0]) continue;
    pts.push([x, Math.max(0, +(rcPctl(cleaned,0.85) - rcMedian(cleaned)).toFixed(1))]);
  }
  return pts.length >= 2 ? pts : null;
}

// Nothing stopped a noisy refit producing a curve that went DOWN — a quote that got
// shorter as the kitchen got busier, or as the oven got colder. Lifting the dips is
// better than rejecting the whole refit for one thin band, but it is not free
// information: it says the evidence in that band disagreed with the shape we are
// imposing, so it goes in the notes and reaches recalMeta.
function rcMonotone(points, notes, label){
  if(!points) return points;
  let lifted = 0, run = -Infinity;
  const out = points.map(p => {
    let y = p[1];
    if(y < run){ y = run; lifted++; } else { run = y; }
    return [p[0], y];
  });
  if(lifted) notes.push(label + ': ' + lifted + ' band(s) lifted to keep the curve non-decreasing');
  return out;
}

// ---- the shipped estimate, replayed ----
//
// A copy of the formula in pos.html and index.html, narrowed to one station, so the
// refit can ask the only question that actually matters: would this candidate model
// have quoted these orders better than the one it is replacing?
//
// It is a third copy of logic that already exists twice, which this codebase has been
// bitten by before — the pizza list and the kitchen tempo both diverged that way. So it
// is pinned: test/eta-agreement.test.js drives this, pos.html's estimateETA and
// index.html's custEstimateETA over the same carts and requires all three to agree.
//
// Two deliberate simplifications, both stated rather than hidden. Tickets in
// orders/completed/{station} are already per-station splits, so "the slower of two
// stations" collapses to the one station this ticket was on. And tempo is 1.0: nothing
// records what the kitchen's live tempo was at the time, and inventing one would score
// the model against a condition it never saw.
function rcInterp(curve, x){
  if(!curve || !curve.length) return 0;
  if(x <= curve[0][0]) return curve[0][1];
  if(x >= curve[curve.length-1][0]) return curve[curve.length-1][1];
  for(let i=1;i<curve.length;i++){
    if(x <= curve[i][0]){
      const [x0,y0]=curve[i-1], [x1,y1]=curve[i];
      return y0 + (y1-y0)*(x-x0)/(x1-x0);
    }
  }
  return curve[curve.length-1][1];
}
function rcModelBase(model, name, station){
  const n = (name||'').toLowerCase();
  let best = null, bestLen = -1;
  for(const k in (model.itemBase||{})){ if(n.includes(k) && k.length>bestLen){ best = model.itemBase[k]; bestLen = k.length; } }
  if(best != null) return best;
  const fb = model.fallback || {};
  if(rcIsPizza(name)) return fb.pizza != null ? fb.pizza : 7.5;
  if(rcIsBaked(name)) return fb.baked != null ? fb.baked : 3.1;
  if(station === 'chef' && fb.hotfood != null) return fb.hotfood;
  return fb.drink != null ? fb.drink : 5.5;
}
function rcQuote(model, o){
  const items = o.items || {};
  let base = 0, qty = 0, pizza = false, bakedOnly = true, has = false;
  for(const nm in items){
    const b = rcModelBase(model, nm, o.station);
    if(b > base) base = b;
    qty += rcQty(items[nm]);
    if(rcIsPizza(nm)) pizza = true;
    if(!rcIsBaked(nm)) bakedOnly = false;
    has = true;
  }
  if(!has) return null;
  const load = o.ahead || 0;
  const idle = (o.idle != null) ? o.idle : 999;
  let add = rcInterp(model.qtyCurve, qty);
  if(pizza) add += rcInterp(model.ovenCurve, idle);
  add += rcInterp(o.station === 'chef' ? model.satCurveChef : model.satCurveBarista, load);
  const point = base + add;
  const cat = (o.station === 'chef') ? (pizza ? 'pizza' : 'hotfood') : (bakedOnly ? 'baked' : 'drink');
  let cush;
  if(cat === 'pizza')        cush = Math.max(rcInterp(model.cushionPizzaByOven || [[0,5]], idle),
                                             rcInterp(model.cushionPizzaByLoad || [[0,0]], load));
  else if(cat === 'hotfood') cush = model.cushionHotfood != null ? model.cushionHotfood : 5;
  else if(cat === 'baked')   cush = model.cushionBaked   != null ? model.cushionBaked   : 2;
  else                       cush = rcInterp(model.cushionDrinkByLoad || [[0,4]], load);
  const quote = point + cush;
  const w = (model.rangeWidth || 5)/2;
  return { low: Math.max(3, Math.round(quote - w)), high: Math.round(quote + w),
           capped: quote > (model.maxQuote || 32) };
}

// Coverage is the number the café's accuracy report shows. medErr is how far the
// middle of the quote sat from the truth, which coverage alone cannot see: a model
// that quotes an hour for everything scores 100% coverage.
function rcScore(model, orders){
  let n = 0, covered = 0, capped = 0;
  const errs = [];
  for(const o of orders){
    const q = rcQuote(model, o);
    if(!q) continue;
    n++;
    if(o.dur <= q.high) covered++;
    if(q.capped) capped++;
    errs.push(Math.abs(o.dur - (q.low + q.high)/2));
  }
  if(!n) return null;
  return { n: n, coverage: +(covered/n).toFixed(4), medErr: +rcMedian(errs).toFixed(2),
           capRate: +(capped/n).toFixed(4) };
}

// Cushions were derived as "p85 minus median of a filtered pool" and assumed to land
// on the coverage target. Nothing checked that they did. This scales them until the
// replayed quote actually hits the target on the fitting window — the smallest scale
// that gets there, so the estimate is never padded further than it has to be.
function rcScaleCushions(model, k, add){
  const m = JSON.parse(JSON.stringify(model));
  const plus = add || 0;
  const sc = v => Math.max(0, +(v*k + plus).toFixed(1));
  const curve = c => Array.isArray(c) ? c.map(p => [p[0], sc(p[1])]) : c;
  m.cushionDrinkByLoad = curve(m.cushionDrinkByLoad);
  m.cushionPizzaByOven = curve(m.cushionPizzaByOven);
  m.cushionPizzaByLoad = curve(m.cushionPizzaByLoad);
  if(m.cushionBaked   != null) m.cushionBaked   = sc(m.cushionBaked);
  if(m.cushionHotfood != null) m.cushionHotfood = sc(m.cushionHotfood);
  return m;
}
function rcCalibrateCushions(model, fitOrders, notes){
  let chosen = null, last = null;
  function tryIt(k, add){
    const cand = rcScaleCushions(model, k, add);
    const sc = rcScore(cand, fitOrders);
    if(!sc) return false;
    last = { k: k, add: add, model: cand, score: sc };
    if(sc.coverage >= RECAL_TARGET_COVERAGE){ chosen = last; return true; }
    return false;
  }
  // pass one: keep the shape, find the smallest scale that covers the café
  for(const k of RECAL_CUSHION_SCALES){ if(tryIt(k, 0)) break; }
  // pass two: the shape cannot be stretched far enough, so add minutes to it instead
  if(!chosen){ for(const add of RECAL_CUSHION_OFFSETS){ if(tryIt(1, add)) break; } }
  if(!chosen) chosen = last;
  if(!chosen) return { model: model, scale: 1, offset: 0, score: null };

  const how = (chosen.k !== 1 ? 'scaled x' + chosen.k : '') +
              (chosen.k !== 1 && chosen.add ? ' and ' : '') +
              (chosen.add ? 'widened by ' + chosen.add + ' min' : '');
  if(how) notes.push('cushions ' + how + ' to reach ' +
                     Math.round(RECAL_TARGET_COVERAGE*100) + '% coverage on the fitting window');
  if(chosen.score.coverage < RECAL_TARGET_COVERAGE)
    notes.push('cushions could not reach the coverage target at all (best ' +
               Math.round(chosen.score.coverage*100) + '% at x' + chosen.k + ' +' + (chosen.add||0) + ')');
  return { model: chosen.model, scale: chosen.k, offset: chosen.add || 0, score: chosen.score };
}

// ---- attaching the derived conditions, once ----
// The holdout is scored with the load and oven-idle each order actually had, which can
// only be computed against the whole window — an order's neighbours do not stop
// existing because they landed on the other side of the split. So this runs on the full
// set before anything is split, and marks the array so rcDerive does not redo it on a
// slice and quietly recompute every load from a fifth of the evidence.
function rcAttach(orders){
  if(orders.attached) return orders;
  rcAttachLoad(orders);
  rcAttachOvenIdle(orders);
  orders.attached = true;
  return orders;
}

// Holds the newest slice of the window out of the fit so the candidate and the
// incumbent can be compared on orders the candidate was not fitted to. Split by
// completion time rather than at random: the question is whether the new model would
// have quoted the most recent trade better, and a random split lets the fit see the
// same service it is later judged on.
function rcSplitWindow(orders, frac){
  const byDone = orders.slice().sort((a,b) => a.done - b.done);
  const cut = Math.max(1, Math.floor(byDone.length * (1-frac)));
  const fit = byDone.slice(0, cut), hold = byDone.slice(cut);
  fit.attached = hold.attached = true;
  return { fit: fit, hold: hold };
}

// ---- the full derivation: returns a proposed model (same shape as eta/model) ----
function rcDerive(orders, pizzaKeys, bakedKeys){
  // Before anything is classified: the whole derivation below asks "is this a pizza"
  // through rcIsPizza, so the list has to be settled first.
  const pizzaKeySource = rcUsePizzaKeys(pizzaKeys);
  rcUseBakedKeys(bakedKeys);
  rcAttach(orders);

  // filter out dessert-after-food contamination up front
  const clean = orders.filter(o=>!rcIsDessertAfterFood(o, orders));

  const notes = [];
  const idleOf = o => (o.idle != null ? o.idle : 9999);
  const soleItem = o => { const names = Object.keys(o.items||{}); return names.length === 1 ? names[0] : null; };
  // "The oven is not cold" — which INCLUDES a negative idle, and that is the whole
  // point of writing it this way. A negative idle means the previous pizza was still
  // cooking when this one went in: the oven is not merely hot, it is occupied. Those
  // are also, necessarily, the busiest moments in the window — so excluding them (as
  // every pool here used to, with `i >= 0`) threw away precisely the evidence the
  // saturation curve exists to measure, and left it fitting a busy kitchen from the
  // quiet end of the data.
  //
  // The oven curve is the one place negatives are still dropped, because there the
  // idle IS the x-axis and a pizza that never stopped cooking has no cooling time to
  // plot against.
  const isHot    = o => idleOf(o) < RECAL_HOT_IDLE;
  const isQuiet  = o => (o.ahead || 0) <= RECAL_QUIET_AHEAD;
  const totQty   = o => { let q=0; for(const nm in (o.items||{})) q += rcQty(o.items[nm]); return q; };

  // ---------- per-item base: one item, one of it, a quiet station, a hot oven ----------
  const itemDurs = {};
  for(const o of clean){
    const nm = soleItem(o);
    if(!nm) continue;
    if(rcQty(o.items[nm]) !== 1) continue;
    if(!isQuiet(o)) continue;
    if(o.dur > 45) continue;
    if(o.station === 'chef' && rcIsPizza(nm) && !isHot(o)) continue;
    (itemDurs[nm] = itemDurs[nm] || []).push(o.dur);
  }
  const itemBase = {};
  for(const nm in itemDurs){
    const cleaned = rcIQRClean(itemDurs[nm]);
    if(cleaned.length >= RECAL_MIN_N.itemBase){ itemBase[nm.toLowerCase()] = +rcMedian(cleaned).toFixed(1); }
  }

  // pizza hot base (all pizzas pooled) — the shared baseline
  const pizzaHot = clean.filter(o => {
    const nm = soleItem(o);
    return nm && rcQty(o.items[nm]) === 1 && o.station === 'chef' && rcIsPizza(nm)
        && isQuiet(o) && isHot(o) && o.dur <= 45;
  }).map(o => o.dur);
  const pizzaHotClean = rcIQRClean(pizzaHot);
  const pizzaBase = pizzaHotClean.length>=RECAL_MIN_N.pizzaBaseAll ? +rcMedian(pizzaHotClean).toFixed(1) : null;

  // ---------- oven curve: single low-load pizzas, over idle ----------
  // Low load only, so the saturation effect is held still while the oven varies —
  // the mirror of what satChef now does with the oven.
  const ovenPool = clean.filter(o => {
    const nm = soleItem(o);
    return nm && rcQty(o.items[nm]) === 1 && o.station === 'chef' && rcIsPizza(nm)
        && isQuiet(o) && idleOf(o) >= 0 && o.dur <= 90;
  });
  let ovenCurve = null;
  {
    const c = rcCurve(ovenPool, idleOf, RECAL_MIN_N.oven);
    if(c){
      // A hot oven adds nothing by definition — that cost is already inside pizzaBase.
      // Anchoring at zero keeps the two from overlapping at the hot end.
      const pts = (c.points[0][0] > 0) ? [[0,0]].concat(c.points) : c.points;
      ovenCurve = rcMonotone(pts, notes, 'ovenCurve');
    }
  }

  // ---------- saturation, station by station, each over its own quiet baseline ----------
  // chef: single pizzas on a HOT oven only. The restriction is the whole point: with the
  // oven free to vary, this curve absorbed the oven's cost and the estimate charged for
  // it twice.
  const satChefPool = clean.filter(o => {
    const nm = soleItem(o);
    return nm && rcQty(o.items[nm]) === 1 && o.station === 'chef' && rcIsPizza(nm) && isHot(o);
  });
  const satBarPool = clean.filter(o => {
    const nm = soleItem(o);
    return nm && o.station === 'barista' && !rcIsBaked(nm);
  });
  const satChefC = rcCurve(satChefPool, o => o.ahead || 0, RECAL_MIN_N.sat);
  const satBarC  = rcCurve(satBarPool,  o => o.ahead || 0, RECAL_MIN_N.sat);
  const satCurveChef    = satChefC ? rcMonotone(satChefC.points, notes, 'satCurveChef')    : null;
  const satCurveBarista = satBarC  ? rcMonotone(satBarC.points,  notes, 'satCurveBarista') : null;

  // ---------- quantity curve (chef, hot, quiet) ----------
  const qtyPool = clean.filter(o => {
    if(o.station !== 'chef') return false;
    if(rcAnyPizza(o.items) && !(idleOf(o) >= 0 && idleOf(o) < 15)) return false;
    return isQuiet(o) && o.dur <= 60;
  });
  const qtyC = rcCurve(qtyPool, totQty, RECAL_MIN_N.qty);
  const qtyCurve = qtyC ? rcMonotone(qtyC.points, notes, 'qtyCurve') : null;

  // ---------- cushions: the spread, over whatever is driving it ----------
  const drinkPool = clean.filter(o => o.station==='barista' && soleItem(o) && !rcAllBaked(o.items));
  // two pizza pools, each holding the other condition still
  const pizzaQuiet = clean.filter(o => { const nm=soleItem(o); return nm && o.station==='chef' && rcIsPizza(nm) && rcQty(o.items[nm])===1 && isQuiet(o); });
  const pizzaHotP  = clean.filter(o => { const nm=soleItem(o); return nm && o.station==='chef' && rcIsPizza(nm) && rcQty(o.items[nm])===1 && isHot(o); });
  const cushionDrinkByLoad = rcSpreadCurve(drinkPool,  o => o.ahead || 0, RECAL_MIN_N.cushion);
  const cushionPizzaByOven = rcSpreadCurve(pizzaQuiet, idleOf,            RECAL_MIN_N.cushion);
  const cushionPizzaByLoad = rcSpreadCurve(pizzaHotP,  o => o.ahead || 0, RECAL_MIN_N.cushion);

  function flatSpread(pool){
    const cleaned = rcIQRClean(pool.map(o=>o.dur));
    if(cleaned.length < RECAL_MIN_N.cushion) return null;
    return Math.max(0, +(rcPctl(cleaned,0.85) - rcMedian(cleaned)).toFixed(1));
  }
  const cushionBaked = flatSpread(clean.filter(o => rcAllBaked(o.items) && o.dur <= 6));
  // Hot food never had a derived cushion at all — the model shipped a hand-picked 5 and
  // the refit left it alone forever, which is the same silence the cap had.
  const cushionHotfood = flatSpread(clean.filter(o => o.station==='chef' && !rcAnyPizza(o.items) && !rcAllBaked(o.items)));

  // ---------- per-category margin (p95-median at fixed conditions) ----------
  function marginFor(pool){
    const cleaned = rcIQRClean(pool.map(o=>o.dur));
    if(cleaned.length < RECAL_MIN_N.margin) return null;
    return Math.max(0, +(rcPctl(cleaned,0.95) - rcMedian(cleaned)).toFixed(1));
  }
  const margin = {
    pizza: marginFor(pizzaHotP.filter(isQuiet)),
    drink: marginFor(drinkPool.filter(o => (o.ahead||0) <= 1)),
    baked: marginFor(clean.filter(o => rcAllBaked(o.items) && o.dur <= 6))
  };

  return {
    derived: {
      itemBase, pizzaBase,
      ovenCurve,
      satCurveChef, satCurveBarista,
      qtyCurve,
      cushionDrinkByLoad, cushionPizzaByOven, cushionPizzaByLoad,
      cushionBaked, cushionHotfood,
      margin
    },
    counts: {
      totalClean: clean.length,
      pizzaHot: pizzaHotClean.length,
      items: Object.keys(itemBase).length
    },
    pizzaKeySource,
    notes
  };
}

// ---- per-item guard: bounds and swing, item by item ----
//
// rcMergeModel merged these straight in. Only the POOLED pizzaBase was ever gated, so a
// single item's base could go from 5.9 to 19 minutes on a thin, unlucky sample and every
// check passed it. Dropping the entry keeps the rest of a good refit, which is the
// proportionate answer to one bad item — but if most of them are being dropped the
// problem is not the items, and the caller rejects the run.
function rcGuardItemBase(current, derived, notes){
  const curBase = (current && current.itemBase) || {};
  const kept = {}, dropped = [];
  for(const k in derived.itemBase){
    const v = derived.itemBase[k];
    const b = rcIsPizza(k) ? RECAL_BOUNDS.pizzaBase : (rcIsBaked(k) ? RECAL_BOUNDS.bakedBase : RECAL_BOUNDS.drinkBase);
    if(!(v >= b[0] && v <= b[1])){ dropped.push(k + ' ' + v + ' outside [' + b[0] + ',' + b[1] + ']'); continue; }
    const was = curBase[k];
    if(was > 0 && Math.abs(v - was)/was > RECAL_SWING_REJECT_PCT){
      dropped.push(k + ' ' + was + '→' + v + ' (' + Math.round(100*Math.abs(v-was)/was) + '%)');
      continue;
    }
    kept[k] = v;
  }
  if(dropped.length) notes.push(dropped.length + ' item base(s) held back: ' + dropped.slice(0,5).join('; '));
  return { kept: kept, dropped: dropped, considered: Object.keys(derived.itemBase).length };
}

// ---- merge derived values into the current model, honoring per-coef volume gates ----
// (a derived value that passed its sample gate replaces; otherwise current value is kept)
function rcMergeModel(current, derived, notes){
  const m = JSON.parse(JSON.stringify(current));   // start from current (keeps anything not re-derived)
  // item bases: merge per item
  if(derived.itemBase){ m.itemBase = Object.assign({}, m.itemBase, derived.itemBase); }
  if(derived.ovenCurve)        m.ovenCurve        = derived.ovenCurve;
  // The two saturation curves move together or not at all. They are fitted on work
  // ahead in ITEMS while the model's existing pair are on tickets, and adopting one of
  // each would leave the model reading two different scales through one loadUnit.
  if(derived.satCurveChef && derived.satCurveBarista){
    m.satCurveChef    = derived.satCurveChef;
    m.satCurveBarista = derived.satCurveBarista;
    m.loadUnit        = 'items';
  } else if(derived.satCurveChef || derived.satCurveBarista){
    if(notes) notes.push('only one saturation curve had the volume to refit; kept both on the previous scale');
  }
  if(derived.qtyCurve)         m.qtyCurve         = derived.qtyCurve;
  if(derived.cushionDrinkByLoad)  m.cushionDrinkByLoad = derived.cushionDrinkByLoad;
  if(derived.cushionPizzaByOven)  m.cushionPizzaByOven = derived.cushionPizzaByOven;
  if(derived.cushionPizzaByLoad)  m.cushionPizzaByLoad = derived.cushionPizzaByLoad;
  if(derived.cushionBaked!=null)  m.cushionBaked = derived.cushionBaked;
  if(derived.cushionHotfood!=null) m.cushionHotfood = derived.cushionHotfood;
  if(derived.margin){ m.margin = m.margin||{}; for(const k in derived.margin){ if(derived.margin[k]!=null) m.margin[k]=derived.margin[k]; } }
  if(derived.pizzaBase!=null){ m.fallback = m.fallback||{}; m.fallback.pizza = derived.pizzaBase; }
  m.version = (current.version||1) + 1;
  m.updatedAt = Date.now();
  m.source = 'recalibration';
  return m;
}

// ---- guardrails: returns {ok, reasons[]} ----
//
// `candidate` is the merged, cushion-calibrated model that would actually ship, so the
// bounds below judge what the café would run rather than what came out of the fit.
function rcCheckGates(current, candidate, derived, counts, guard, scoreOld, scoreNew){
  const reasons=[];
  function inb(v, b){ return v==null || (v>=b[0] && v<=b[1]); }
  function curveMax(c){ return (Array.isArray(c) && c.length) ? Math.max.apply(null, c.map(p=>p[1])) : null; }

  // headline bases
  if(!inb(derived.pizzaBase, RECAL_BOUNDS.pizzaBase)) reasons.push('pizzaBase '+derived.pizzaBase+' out of bounds');

  // the curves the estimate adds minutes from — these bounds existed and were never read
  if(!inb(curveMax(candidate.ovenCurve), RECAL_BOUNDS.ovenMax)) reasons.push('ovenCurve peaks at '+curveMax(candidate.ovenCurve)+' min');
  if(!inb(curveMax(candidate.satCurveChef), RECAL_BOUNDS.satMax)) reasons.push('satCurveChef peaks at '+curveMax(candidate.satCurveChef)+' min');
  if(!inb(curveMax(candidate.satCurveBarista), RECAL_BOUNDS.satMax)) reasons.push('satCurveBarista peaks at '+curveMax(candidate.satCurveBarista)+' min');
  if(!inb(curveMax(candidate.qtyCurve), RECAL_BOUNDS.satMax)) reasons.push('qtyCurve peaks at '+curveMax(candidate.qtyCurve)+' min');

  // cushions, after calibration — a runaway scale is caught here
  for(const k of ['cushionDrinkByLoad','cushionPizzaByOven','cushionPizzaByLoad']){
    if(!inb(curveMax(candidate[k]), RECAL_BOUNDS.cushion)) reasons.push(k+' peaks at '+curveMax(candidate[k])+' min');
  }
  if(!inb(candidate.cushionBaked,   RECAL_BOUNDS.cushion)) reasons.push('cushionBaked out of bounds');
  if(!inb(candidate.cushionHotfood, RECAL_BOUNDS.cushion)) reasons.push('cushionHotfood out of bounds');
  if(derived.margin){ for(const k in derived.margin){ if(!inb(derived.margin[k], RECAL_BOUNDS.margin)) reasons.push('margin.'+k+' out of bounds'); } }

  // swing check vs current (only for values we actually re-derived)
  function swing(now, was){ if(now==null||was==null||was===0) return 0; return Math.abs(now-was)/was; }
  if(derived.pizzaBase!=null && current.fallback && current.fallback.pizza){
    const s = swing(derived.pizzaBase, current.fallback.pizza);
    if(s > RECAL_SWING_REJECT_PCT) reasons.push('pizzaBase swing '+(s*100).toFixed(0)+'%');
  }

  // per-item guard: one bad item is dropped, a majority of them is systemic
  if(guard && guard.considered >= 4 && guard.dropped.length > guard.considered/2){
    reasons.push(guard.dropped.length+' of '+guard.considered+' item bases failed their bounds or swing check');
  }

  // volume floor
  if(counts.totalClean < 200) reasons.push('too few clean orders ('+counts.totalClean+')');

  // ---- the gate this never had: is it actually better? ----
  // Both models replayed over the held-out slice neither was fitted to. A refit that
  // makes the café less accurate now fails, which used to be something nobody measured
  // and therefore something nothing could stop.
  if(!scoreNew || !scoreOld){
    reasons.push('could not score the candidate against the held-out window');
  } else {
    // Coverage is a CONSTRAINT, not a quantity to maximise, and the difference matters
    // here. A model that quotes an hour for everything covers 100% of orders, so a gate
    // that simply required coverage not to fall would prefer the sloppiest model
    // available — and would reject a refit for the crime of being more accurate, which
    // is exactly what a model carrying a phantom saturation floor looks like: it
    // over-quotes, so it covers 97%, and it is wrong by three and a half minutes.
    //
    // So: a candidate that clears the target has satisfied the constraint and is judged
    // on error alone. Only one falling SHORT of the target, and worse than the model it
    // would replace, is refused on coverage.
    if(scoreNew.coverage < RECAL_TARGET_COVERAGE &&
       scoreNew.coverage < scoreOld.coverage - RECAL_COVERAGE_SLACK){
      reasons.push('holdout coverage would fall ' + Math.round(scoreOld.coverage*100) + '% → ' +
                   Math.round(scoreNew.coverage*100) + '%, short of the ' +
                   Math.round(RECAL_TARGET_COVERAGE*100) + '% target');
    }
    if(scoreOld.medErr > 0 && scoreNew.medErr > scoreOld.medErr * RECAL_ERR_SLACK){
      reasons.push('holdout median error would rise ' + scoreOld.medErr + ' → ' + scoreNew.medErr + ' min');
    }
  }
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

// ---- the dead man's switch -------------------------------------------------
// reportIfItThrows catches a cron that THROWS. Nothing caught a cron that stops
// FIRING, and there are several ways for that to happen. `wrangler deploy` makes
// the cron list in wrangler.toml authoritative, so a schedule missing from that
// file is silently removed — the file says so itself. A Worker that is suspended,
// over quota or replaced by a bad deploy runs nothing at all.
//
// In every one of those cases ops/cronFailure stays empty, no push goes out, the
// Worker-health panel on analytics.html reports nothing wrong, and the hourly
// monitor — the thing that notices unpaid web orders and raises the per-bank
// alarm — has simply stopped. It is indistinguishable from a quiet week, which is
// the most expensive kind of silence in this project.
//
// Nothing here can detect its own absence. Only something that is not here can:
// each finished run pings a URL, and the service on the other end alerts when a
// ping does not arrive on time. The job name is appended, so the two crons —
// hourly and monthly, with very different periods — are two separate checks.
const HEARTBEAT_TIMEOUT_MS = 5000;

// The heartbeat that needs nothing set up: the robot already holds a credential
// and already writes ops/cronFailure, so a finished run can record itself in the
// same place. That record is what .github/workflows/cron-heartbeat.yml reads on a
// schedule, and what the Worker-health panel on analytics.html shows.
//
// A row here is not proof the Worker is alive — it is a timestamp, and the whole
// point is that it STOPS being written. Nothing in this Worker can raise an alarm
// about its own silence; the reader has to be somewhere else, which is why there
// is a workflow as well as a panel.
async function heartbeatRecord(job){
  try {
    const token = await getRobotToken();
    await fetch(DB_URL + '/ops/cronHeartbeat/' + encodeURIComponent(job) + '.json?auth=' + token,
                { method:'PUT', body: JSON.stringify({ at: Date.now() }) });
  } catch(e){
    // A run that finished but could not say so is not a failed run. It will look
    // stale to the workflow, which is the safe direction to be wrong in.
    console.log('heartbeat ' + job + ': could not record the run: ' + ((e && e.message) || e));
  }
}

async function heartbeat(job){
  // An unset binding means no external monitor is attached, and that must run
  // exactly as this Worker ran before. Deliberately NOT the authOk treatment: a
  // missing secret there would open a route, where a missing URL here only
  // declines to send a ping nobody is listening for. The database record above
  // happens either way, so the switch works with nothing configured at all.
  if (typeof HEARTBEAT_URL !== 'string' || !HEARTBEAT_URL) return;

  let url;
  try {
    url = new URL(HEARTBEAT_URL.replace(/\/+$/, '') + '/' + encodeURIComponent(job));
  } catch(e){
    console.log('heartbeat: HEARTBEAT_URL is not a URL, no ping sent');
    return;
  }
  // The binding is set by hand and this Worker will POST to whatever it says, so
  // it does not get to be http, and it does not get to be a path on the database.
  if (url.protocol !== 'https:'){
    console.log('heartbeat: refusing a non-https HEARTBEAT_URL');
    return;
  }

  try {
    // Bounded on purpose. A connection that is made and then goes nowhere is the
    // failure this codebase knows best, and this call sits inside waitUntil — an
    // unbounded fetch would hold open the very invocation it exists to report on.
    await fetch(url.toString(), { method: 'POST', signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
  } catch(e){
    // There is nothing to escalate. A ping that did not arrive is precisely what
    // the monitor on the other end is for, and this must never turn a job that
    // succeeded into one that reports a failure.
    console.log('heartbeat ' + job + ' did not send: ' + ((e && e.message) || e));
  }
}

// `isScheduled` says whether this job is one of the crons. It is the caller's to
// declare rather than something guessed from the name, because a name is not a
// schedule and the next non-cron caller would inherit the wrong answer silently.
async function reportIfItThrows(job, promise, isScheduled){
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

  // Only on the way out of a run that finished. A record written before the work,
  // or from the catch above, would say the Worker is alive while saying nothing
  // about whether the job did anything — which is the failure this is supposed to
  // catch, wearing a green tick.
  //
  // ONLY FOR A SCHEDULED JOB, THOUGH. A heartbeat answers "did the thing that runs
  // on a timer run?", and that question is meaningless for work that happens when
  // something arrives. The bank-credit ingest reports failures through here too, and
  // it is triggered by an email: it was writing a heartbeat row and pinging the
  // external monitor with a job name that is not on any schedule, on every credit.
  // Nothing broke — check-cron-heartbeat.js reads a fixed list of jobs, so it could
  // not false-alarm — but it put two more sequential round trips on the path a
  // payment arrives down, and sent an unasked-for check name to whatever service is
  // on the other end of HEARTBEAT_URL.
  if (isScheduled){
    await heartbeatRecord(job);
    await heartbeat(job);
  }
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

  // Classify by the list the pages classify by. `current` is the live eta/model,
  // fetched above, and pizzaKeys is the field pos.html and index.html read. Both
  // models are scored through this same list, so the comparison below is between the
  // coefficients and nothing else.
  //
  // Conditions are attached across the WHOLE window before it is split — an order's
  // queue depth is a fact about the service it was cooked in, not about which side of
  // a holdout boundary it landed on.
  rcAttach(orders);
  const { fit, hold } = rcSplitWindow(orders, RECAL_HOLDOUT_FRAC);
  const { derived, counts, pizzaKeySource, notes } = rcDerive(fit, current.pizzaKeys, current.bakedKeys);

  const guard = rcGuardItemBase(current, derived, notes);
  derived.itemBase = guard.kept;

  // Merge, then calibrate the cushions on the fitting window, then score both models
  // over the held-out slice neither of them was fitted to.
  const cal = rcCalibrateCushions(rcMergeModel(current, derived, notes), fit, notes);
  const candidate = cal.model;
  const holdClean = hold.filter(o => !rcIsDessertAfterFood(o, orders));
  const scoreNew = rcScore(candidate, holdClean);
  const scoreOld = rcScore(current,   holdClean);
  const gate = rcCheckGates(current, candidate, derived, counts, guard, scoreOld, scoreNew);

  const summary = {
    ran: !dryRun && gate.ok,
    dryRun: !!dryRun,
    ordersConsidered: orders.length,
    freshOrders: fresh,
    lastRunAt: meta.lastRunAt || null,
    cleanOrders: counts.totalClean,
    // true = the lookback window was cut short by RECAL_MAX_RECORDS, so this refit saw
    // less of it than it asked for. Surfaced rather than absorbed: the gates below judge
    // sample sizes, and a sample silently smaller than the window is the one thing they
    // cannot tell from a quiet quarter.
    windowTruncated: !!orders.truncated,
    // 'model' = classified by eta/model.pizzaKeys, the same list the till uses.
    // 'fallback' = that field was missing or unusable and this ran on the literal in
    // this file, which is a thing to know before trusting pizzaBase below.
    pizzaKeySource,
    pizzaBase: derived.pizzaBase,
    cushionDrink: candidate.cushionDrinkByLoad,
    cushionPizza: candidate.cushionPizzaByOven,
    cushionScale: cal.scale,
    cushionOffset: cal.offset,
    margin: derived.margin,
    itemsUpdated: Object.keys(guard.kept).length,
    itemsHeldBack: guard.dropped,
    // Which queue signal the candidate's saturation curves are fitted against. A model
    // that says 'items' is read against the item-weighted queue eta/live publishes.
    loadUnit: candidate.loadUnit || 'tickets',
    // The whole point of the holdout: what each model would have quoted on trade
    // neither of them was fitted to. `coverage` is the share finishing inside the quote
    // — the number admin's accuracy card shows — and `capRate` the share quoted
    // open-ended, which is how often the estimate ran past what the model will vouch for.
    holdout: { n: (scoreNew && scoreNew.n) || 0, current: scoreOld, candidate: scoreNew },
    notes: notes,
    gatePassed: gate.ok,
    gateReasons: gate.reasons
  };

  if(dryRun){ return summary; }

  if(!gate.ok){
    // rejected: keep current model, record the attempt + notify
    await fetch(DB_URL + '/eta/recalMeta.json?auth=' + token, {
      method:'PUT', body: JSON.stringify({ lastRunAt: Date.now(), lastResult:'rejected', reasons: gate.reasons,
                                           orders: orders.length, notes: notes, holdout: summary.holdout })
    });
    await rcNotifyOwner(token, '⚠️ ETA recalibration REJECTED', 'Kept current model. ' + gate.reasons.join('; '));
    return summary;
  }

  // passed: snapshot current -> previous, write merged new model
  await fetch(DB_URL + '/eta/modelPrevious.json?auth=' + token, { method:'PUT', body: JSON.stringify(current) });
  const merged = candidate;
  await fetch(DB_URL + '/eta/model.json?auth=' + token, { method:'PUT', body: JSON.stringify(merged) });
  await fetch(DB_URL + '/eta/recalMeta.json?auth=' + token, {
    method:'PUT', body: JSON.stringify({ lastRunAt: Date.now(), lastResult:'updated', version: merged.version,
                                         orders: orders.length, notes: notes, holdout: summary.holdout,
                                         cushionScale: cal.scale, cushionOffset: cal.offset,
                                         loadUnit: merged.loadUnit || 'tickets' })
  });
  await rcNotifyOwner(token, '✅ ETA model updated (v'+merged.version+')',
    'pizza '+(current.fallback&&current.fallback.pizza)+'→'+derived.pizzaBase+
    ' · '+counts.totalClean+' orders · '+Object.keys(guard.kept).length+' items refit' +
    (scoreOld && scoreNew ? ' · on-time on held-out trade ' + Math.round(scoreOld.coverage*100) +
                            '% → ' + Math.round(scoreNew.coverage*100) + '%' : '') +
    (orders.truncated ? ' · read capped at ' + RECAL_MAX_RECORDS + ' a station — raise it' : ''));
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

// ---------------------------------------------------------------------------
// A payment that was still unverified at closing, and paid afterwards.
//
// EOD writes the archive FIRST and parks the stragglers second, so the archived
// ledger records them as unverified — correctly, that is what was true when the
// day closed. When a bank credit finally matches, the reconciler marks the parked
// row verified. That row is then the ONLY record the money ever arrived: the
// archive still says unverified, and nothing reconciles the two.
//
// So the correction is written where the day already lives, as a CHILD of the
// archive rather than an edit to it. Nothing archived is ever rewritten — the
// ledger line still says what was true at closing, and lateVerified says what
// happened after. An audit reads both and gets the whole story in one place.
//
// Only then is the parked row dropped, and never in the same run that wrote it:
// the next run re-reads the archive, and deletes the row only if that read comes
// back with the correction in it. A write this hour and a delete next hour costs
// nothing and means no row is ever removed on the strength of a write this code
// merely believes succeeded.
async function settleLateVerifications(token){
  const carried = await monLoad(token, '/pos/unverified') || {};
  const ids = Object.keys(carried).filter(function(id){
    const r = carried[id];
    return r && r.state === 'verified' && r.day && r.ref;
  });
  if (!ids.length) return { recorded: 0, cleared: 0 };

  // Keys only. The archive holds every bill of every day the café has been open,
  // and this runs hourly — reading it whole to find one key would grow into the
  // most expensive thing the Worker does.
  // monLoad appends `.json` to the path, so it cannot carry a query of its own —
  // '/pos/eodArchive?shallow=true' would come out as '...?shallow=true.json?auth='.
  let keys = [];
  try {
    const r = await fetch(DB_URL + '/pos/eodArchive.json?shallow=true&auth=' + token);
    if (r.ok) keys = Object.keys((await r.json()) || {});
  } catch (e) { return { recorded: 0, cleared: 0 }; }
  if (!keys.length) return { recorded: 0, cleared: 0 };

  let recorded = 0, cleared = 0;
  for (const payId of ids){
    const row = carried[payId];
    // Archive keys are `${day}-${Date.now()}`. If a day was closed twice the later
    // archive is the one that carries the payment, so take the highest key.
    const forDay = keys.filter(function(k){ return k.indexOf(row.day + '-') === 0; }).sort();
    const archiveKey = forDay[forDay.length - 1];
    if (!archiveKey) continue;                      // no archive for that day: leave it alone

    const at = '/pos/eodArchive/' + encodeURIComponent(archiveKey) + '/lateVerified/' + encodeURIComponent(payId);
    const already = await monLoad(token, at);

    if (already && already.ref){
      // The archive demonstrably has it. Now, and only now, the parked row goes.
      const del = await fetch(DB_URL + '/pos/unverified/' + encodeURIComponent(payId) + '.json?auth=' + token,
                              { method: 'DELETE' });
      if (del.ok) cleared++;
      continue;
    }

    const put = await fetch(DB_URL + at + '.json?auth=' + token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: String(row.ref),
        at: Number(row.verifiedAt || row.ts || Date.now()),
        amount: Number(row.amount) || 0,
        bankTag: row.bankTag ? String(row.bankTag) : ''
      })
    });
    if (put.ok) recorded++;
  }
  return { recorded: recorded, cleared: cleared };
}

async function runVerificationMonitor(nowMs, isWeekly){
  const token = await getRobotToken();
  // Housekeeping first, and on its own: the public table index is only useful for a
  // couple of hours, and one that accumulates hands out every trackId in the café
  // eventually. Its own try/catch, because nothing below should fail for it.
  try { await pruneTableIndex(token); } catch (e) { console.error('prune tableIndex', e); }
  // Same argument, different node: the tills' fault reports are diagnostics, not
  // records, and a fault nobody has seen for a fortnight is not what anybody opens
  // that panel to read.
  try { await pruneClientErrors(token); } catch (e) { console.error('prune clientErrors', e); }
  // Also housekeeping, also on its own: this one moves an audit record, so a failure
  // here must never take the payment alerts below down with it.
  try { await settleLateVerifications(token); } catch (e) { console.error('late verifications', e); }
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
//
// THE LAST SEVEN DAYS, NOT EVERY DAY THE CAFE HAS EVER BEEN OPEN.
//
// This read had no limit on it, and pos/eodArchive is the one node here that only ever
// grows: one entry per closing, each carrying that day's whole bills array and whole
// ledger. Seven days were then picked out of it in a loop. Every browser that touches
// this node already limits (limitToLast(120), in admin and analytics), and
// settleLateVerifications thirty lines up goes out of its way to read it shallow for
// exactly this reason — the Worker was the one reader still pulling it whole, weekly,
// forever. Nothing announces that failure either: it gets slower every week, and the
// day it finally exceeds what a Worker can hold or how long it may run, the digest
// simply stops arriving.
//
// Archive keys are `YYYY-MM-DD-<epoch ms>`, so key order IS date order and the newest
// entries are the last ones. limitToLast on $key needs no index. 30 covers a week with
// room for days closed more than once and for the café closing on a Monday.
const DIGEST_ARCHIVE_KEYS = 30;
async function runWeeklyDigest(token, nowMs){
  let arch = {};
  try {
    const r = await fetch(DB_URL + '/pos/eodArchive.json?orderBy=%22%24key%22&limitToLast=' +
                          DIGEST_ARCHIVE_KEYS + '&auth=' + token);
    if (r.ok) arch = (await r.json()) || {};
  } catch (e) { return; }
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

// ============================================================================
//  THE TABLE INDEX, KEPT SHORT
// ============================================================================
// orders/tableIndex is the public lookup a table QR uses: the trackIds seen at a
// table, and when. It exists so that orders/track itself need not be enumerable —
// a query needs read on the node it queries, and that read used to hand anyone the
// café's entire order history in one request.
//
// It only moves the problem unless it is kept short. A trackId is what reads the
// record behind it, so an index that accumulates is an index that eventually hands
// out every id anyway, one table at a time. The customer page discards anything
// older than two hours; six is generous and still bounded.
//
// Safe to prune because nothing is stored here that is not derived: losing an old
// entry costs a lookup nobody makes. The records themselves are untouched.
const TABLE_INDEX_KEEP_MS = 6 * 60 * 60000;

async function pruneTableIndex(token){
  let all;
  try {
    const res = await fetch(DB_URL + '/orders/tableIndex.json?auth=' + token);
    if (!res.ok) return { pruned: 0 };
    all = await res.json();
  } catch (e) { return { pruned: 0 }; }
  if (!all || typeof all !== 'object') return { pruned: 0 };

  const cutoff = Date.now() - TABLE_INDEX_KEEP_MS;
  const updates = {};
  let pruned = 0;
  for (const label in all) {
    const ids = all[label];
    if (!ids || typeof ids !== 'object') continue;
    for (const id in ids) {
      const at = Number(ids[id]);
      // A missing or unreadable timestamp is left alone rather than guessed at.
      if (!isFinite(at) || at <= 0 || at >= cutoff) continue;
      updates['orders/tableIndex/' + label + '/' + id] = null;
      pruned++;
    }
  }
  if (!pruned) return { pruned: 0 };
  try {
    await fetch(DB_URL + '/.json?auth=' + token, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates)
    });
  } catch (e) { return { pruned: 0 }; }
  return { pruned: pruned };
}

// ============================================================================
//  THE TILLS' FAULT REPORTS, KEPT SHORT
// ============================================================================
// connection.js writes ops/clientErrors when a page throws something nobody caught.
// The key is a signature — page, message, where it came from — so a fault that
// happens a thousand times is one row with a count on it, and the node is as long as
// the number of DISTINCT things going wrong.
//
// That is nearly bounded and not quite: a message can carry variable text in it (a
// database refusal names its own path, and a path can hold an id), and every variant
// is its own signature. Left alone that accumulates, slowly, forever — which is the
// shape this project has been caught by twice.
//
// So it is pruned rather than argued about. These are diagnostics, not records:
// nothing downstream reads them, an old one has already been fixed or is no longer
// happening, and losing it costs a line on a panel nobody was looking at. A fault
// still occurring rewrites its own row on the next occurrence and comes straight
// back, which is the property that makes this safe to delete from at all.
const CLIENT_ERR_KEEP_MS = 14 * 24 * 60 * 60000;

async function pruneClientErrors(token){
  let all;
  try {
    const res = await fetch(DB_URL + '/ops/clientErrors.json?auth=' + token);
    if (!res.ok) return { pruned: 0 };
    all = await res.json();
  } catch (e) { return { pruned: 0 }; }
  if (!all || typeof all !== 'object') return { pruned: 0 };

  const cutoff = Date.now() - CLIENT_ERR_KEEP_MS;
  const updates = {};
  let pruned = 0;
  for (const sig in all) {
    const row = all[sig];
    const at = Number(row && row.lastAt);
    // A row with no readable timestamp is left alone rather than guessed at — the
    // same rule the table index prune follows, for the same reason.
    if (!isFinite(at) || at <= 0 || at >= cutoff) continue;
    updates['ops/clientErrors/' + sig] = null;
    pruned++;
  }
  if (!pruned) return { pruned: 0 };
  try {
    await fetch(DB_URL + '/.json?auth=' + token, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates)
    });
  } catch (e) { return { pruned: 0 }; }
  return { pruned: pruned };
}

// ---- The one page that could not report its own faults ---------------------
//
// connection.js writes ops/clientErrors from every staff page and skipped an
// anonymous session, because the rules refuse one. That gap was in the worst place it
// could be: the ordering page is the only screen a CUSTOMER touches, it is where the
// fault that cost real money happened — an order refused for one field too long, its
// rejection attached to nothing — and it is the one screen with nobody standing over
// the device to notice that something went wrong.
//
// It cannot be closed by opening the node. Writing it from the ordering page means
// ops/clientErrors is writable by anyone holding an anonymous token, which is anyone
// at all, on the database that holds the café's takings. So the customer's browser
// asks the Worker instead and the Worker writes as the robot — the same shape as the
// cash-out and the stock log, for the same reason.
//
// NOTHING THE CALLER SENDS IS TRUSTED WITH ANYTHING:
//
//   The KEY is computed here, from the text, after the text is bounded. If the caller
//   chose it, every row in the node would be a stranger's to overwrite — including the
//   till's own reports, which is the half of this node that matters.
//
//   The PAGE is not read from the request at all for an anonymous session. An
//   anonymous token only ever comes from the ordering page, and a report claiming to
//   come from pos.html would send somebody to look at the wrong screen.
//
//   Every field is bounded by safeText at the lengths the rules validate, so a
//   refusal from the database here is a bug in this file rather than normal traffic.
//
// WHAT ENDS UP IN IT. `message` is whatever the browser said, which on the ordering
// page can carry text a customer typed — a validation failure quoting a field, a
// refusal naming a path with an order id in it. That is the same exposure the tills
// already have and it is why the node is readable by an admin and the robot and by
// nobody else, why nothing here asks for more than the error, and why the robot drops
// a row a fortnight after it was last seen.
//
// AND THE NODE IS CAPPED. The browser's own limits — eight faults a load, one a minute
// per signature — bind an honest page and bind nothing else: anyone can post this
// route a million distinct messages, and every distinct message is its own row. What
// bounds the node is that a report which would CREATE a row is refused once the node
// is already long, while a row that exists is always updatable. So a fault already
// known goes on counting, and the worst a flood costs the café is a node of a size it
// chose. Staff reporting is untouched either way: it does not come through here, and
// the rules let a till write whether the node is long or not.
const CLIENT_ERR_MAX_ROWS = 200;

// The same signature connection.js computes, deliberately: one definition of what
// counts as "the same fault", so a report through this route and a report written
// directly by a till land on the same row rather than on two.
function clientErrKey(page, sig){
  let h = 0;
  for (let i = 0; i < sig.length; i++) { h = ((h << 5) - h + sig.charCodeAt(i)) | 0; }
  return page + '-' + (h >>> 0).toString(36);
}

async function handleClientError(data, claims){
  const anon = !!(claims.firebase && claims.firebase.sign_in_provider === 'anonymous');

  // Firebase keys cannot hold . # $ [ ] / — and the page is only the caller's word for
  // it, which is why an anonymous session does not get to say.
  const page = anon ? 'index_html'
                    : (safeText(data && data.page, 40).replace(/[.#$\[\]\/]/g, '_') || 'unknown');
  const kind    = safeText(data && data.kind, 20) || 'error';
  const message = safeText(data && data.message, 300);
  const source  = safeText(data && data.source, 200);
  const build   = safeText(data && data.build, 40) || 'unknown';
  if (!message) return { status: 400, body: { error: 'nothing to report' } };

  const key = clientErrKey(page, page + '|' + kind + '|' + message + '|' + source);
  const at  = '/ops/clientErrors/' + encodeURIComponent(key);

  let token; try { token = await getRobotToken(); }
  catch (e) { return { status: 502, body: { error: 'no credential' } }; }

  // Read the row first. It answers three questions in one round trip: whether this is
  // a new fault (so whether the cap applies), what the count was, and when it was
  // first seen. A read that FAILS is not treated as "new" — that would reset a count
  // and lose the age of a fault every time the database hiccuped.
  let row;
  try {
    const res = await fetch(DB_URL + at + '.json?auth=' + token);
    if (!res.ok) return { status: 502, body: { error: 'could not read' } };
    row = await res.json();
  } catch (e) { return { status: 502, body: { error: 'could not read' } }; }

  // Only a report that would LENGTHEN the node pays for the count, and only a report
  // that would lengthen it can be refused for length.
  if (row == null) {
    let n = 0;
    try {
      const res = await fetch(DB_URL + '/ops/clientErrors.json?shallow=true&auth=' + token);
      if (!res.ok) return { status: 502, body: { error: 'could not read' } };
      const keys = await res.json();
      n = (keys && typeof keys === 'object') ? Object.keys(keys).length : 0;
    } catch (e) { return { status: 502, body: { error: 'could not read' } }; }
    // Not an error to the caller. The page has nowhere else to put this and nothing to
    // do about it, and a 4xx would only teach it to retry.
    if (n >= CLIENT_ERR_MAX_ROWS) return { status: 200, body: { ok: true, stored: false, reason: 'full' } };
  }

  const now  = Date.now();
  const prev = (row && typeof row === 'object') ? row : {};
  // Read-then-write rather than a server-side increment. Two phones hitting the same
  // fault in the same instant can lose one of the two, which moves a number nobody
  // acts on by one; the alternative is a wire-format server value this file cannot
  // test against the real database, on the path that exists to record failures.
  const count   = (Number(prev.count)   > 0 ? Number(prev.count)   : 0) + 1;
  // Kept from the row it was on, so the age of a fault survives every later
  // occurrence overwriting the rest of the record.
  const firstAt = (Number(prev.firstAt) > 0 ? Number(prev.firstAt) : now);

  let res;
  try { res = await dbPut(at, { page, kind, message, source, build, count, firstAt, lastAt: now }); }
  catch (e) { return { status: 502, body: { error: 'could not write' } }; }
  if (!res.ok) return { status: 502, body: { error: 'refused' } };
  return { status: 200, body: { ok: true, stored: true } };
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

    // A fault on the ordering page, which is the one screen that cannot record its
    // own. This is deliberately the ONLY route here an anonymous token may use, and
    // the reason it can is that the caller is trusted with nothing: the row it writes
    // to, the page it claims to be, and the length of every string are all decided in
    // handleClientError rather than sent. It takes no PIN and asks for no role, so it
    // must also never be able to do anything but add a bounded line to a diagnostic
    // node — check that again before ever widening it.
    if (data && data.action === 'client-error') {
      const who = await verifyIdToken(data.token);
      if (!who) return json({ error:'unauthorized' }, 401);
      const r = await handleClientError(data, who);
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
      ctx.waitUntil(reportIfItThrows('recalibration', runRecalibration(false), true));
    } else {
      const isMonday = new Date(now).getUTCDay() === 1;   // digest once a week on Monday ticks
      const isWeeklySlot = isMonday && new Date(now).getUTCHours() === 4;   // ~one tick/week (04:00 UTC Mon)
      ctx.waitUntil(reportIfItThrows('monitor', runVerificationMonitor(now, isWeeklySlot), true));
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
      stage = 'write';
      // One clock reading for both: `at` is when this alert was ingested, bankTime is
      // when the bank says the money moved (null when the alert does not say, or
      // does not say it in a shape this is sure of — see parseBankTime).
      const nowMs = Date.now();
      const payment = { amount: p.amount, payer: p.payer || null, ref: String(p.ref), source: hit.bank + '-email', bank: hit.bank, acct: p.acct || null, bankTime: parseBankTime(text, nowMs), at: nowMs };
      // A CREDIT THIS CANNOT RECORD IS A PAYMENT NOBODY WILL EVER MATCH.
      //
      // This was a bare fetch whose status was printed into a log line and otherwise
      // dropped. Nothing here has a caller: an email arrives, this runs, and if the
      // write is refused the alert is gone — the customer has paid, the till never
      // sees a credit for it, the order never auto-verifies, and the only trace is a
      // console line in a runtime nobody is watching. It reads exactly like a bank
      // that has stopped mailing.
      //
      // reportIfItThrows is the machinery the scheduled jobs already use for this,
      // and it fits without changing: it records the failure under ops/cronFailure
      // (which the Worker-health panel on analytics.html renders by name), pushes to
      // the owner at most once in the throttle window, and — the half that matters as
      // much — CLEARS the record when a write succeeds, so a bank that recovers stops
      // looking broken and the next failure after it pushes immediately.
      await reportIfItThrows('bank-credit-ingest', (async () => {
        const res = await dbPut('/payments/incoming/' + encodeURIComponent(String(p.ref)), payment);
        if (!res.ok) throw new Error(hit.bank + ' credit ' + p.amount + ' ref ' + p.ref +
                                     ' was not recorded (' + res.status + ' ' +
                                     (await res.text()).slice(0, 120) + ')');
        console.log('upi-email: OK ' + hit.bank + ' ' + p.amount + ' ref ' + p.ref + ' acct ' + (p.acct || '-')
                    + ' bankTime ' + (payment.bankTime ? new Date(payment.bankTime).toISOString() : 'none')
                    + ' -> ' + res.status);
        return true;
      })());
    } catch(e){ console.log('upi-email error at stage=' + stage + ':', e && (e.stack || e.message)); }
  }
};
