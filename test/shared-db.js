// One database, more than one till.
//
// Every other browser suite gives the page a database of its own: a stub inside the
// page, holding its own data, answering its own transactions. That is the right tool
// for asking what ONE till does, and it cannot ask the question this file exists for
// — what two tills do to the same money — because a second page gets a second
// database and the two never meet.
//
// So the data lives here, in Node, and each page gets a client that behaves the way
// the Firebase SDK does at the points the money paths lean on:
//
//   - a write is applied to the page's own copy FIRST, and its listeners fire before
//     the server has heard about it. The till relies on this everywhere (a paid table
//     leaves the screen at once), and so do its bugs.
//   - a transaction runs against the page's own copy, is sent with the value it was
//     computed from, and is REFUSED AND RE-RUN if the server's value is no longer
//     that — with the server's value, as many times as it takes. Returning undefined
//     aborts it. Two tills racing for one claim is exactly this loop.
//   - a multi-path update is all or nothing, and a refused one is rolled back out of
//     the page's copy.
//   - server values (TIMESTAMP, increment) are resolved by the server.
//   - a transaction that has been SENT when the connection is cut is cancelled with
//     Error('disconnect') — and that error is the same whether the server applied the
//     write or never saw it. window.__cutTxn = { prefix, list: ['landed' | 'lost', …] }
//     cuts the next transactions under `prefix` that way, one entry per attempt.
//
// `rules` is the one piece of database.rules.json these suites need: a function the
// server asks before committing. It is handed the tree as it WOULD be and returns a
// reason to refuse, or nothing.

const clone = (v) => (v === undefined || v === null) ? null : JSON.parse(JSON.stringify(v));
const parts = (p) => String(p == null ? '' : p).split('/').filter(Boolean);

function getAt(tree, p) {
  let n = tree;
  for (const k of parts(p)) { if (n == null || typeof n !== 'object') return null; n = n[k]; }
  return n === undefined ? null : n;
}
// Firebase has no empty objects: a node with no children does not exist.
function prune(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return v;
  const out = {};
  for (const k of Object.keys(v)) { const c = prune(v[k]); if (c !== null) out[k] = c; }
  return Object.keys(out).length ? out : null;
}
function setAt(tree, p, v) {
  const ks = parts(p);
  v = prune(v);
  if (!ks.length) { for (const k of Object.keys(tree)) delete tree[k]; if (v) Object.assign(tree, v); return; }
  const trail = [];
  let n = tree;
  for (let i = 0; i < ks.length - 1; i++) {
    if (n[ks[i]] == null || typeof n[ks[i]] !== 'object') { if (v === null) return; n[ks[i]] = {}; }
    trail.push([n, ks[i]]);
    n = n[ks[i]];
  }
  if (v === null) delete n[ks[ks.length - 1]]; else n[ks[ks.length - 1]] = v;
  for (let i = trail.length - 1; i >= 0; i--) {
    const [par, key] = trail[i];
    if (par[key] && typeof par[key] === 'object' && !Object.keys(par[key]).length) delete par[key]; else break;
  }
}
function resolveSV(cur, v, now) {
  if (v && typeof v === 'object') {
    if (Object.prototype.hasOwnProperty.call(v, '.sv')) {
      const sv = v['.sv'];
      if (sv === 'timestamp') return now;
      if (sv && typeof sv === 'object' && typeof sv.increment === 'number') return (typeof cur === 'number' ? cur : 0) + sv.increment;
      return null;
    }
    const out = {};
    for (const k of Object.keys(v)) out[k] = resolveSV(cur && typeof cur === 'object' ? cur[k] : null, v[k], now);
    return out;
  }
  return v;
}

function createServer(seed, opts) {
  opts = opts || {};
  const srv = {
    root: clone(seed) || {},
    clients: [],
    log: [],                       // every committed write: { by, writes: [{ path, value }] }
    refused: [],                   // every write the rules turned away
    rules: opts.rules || null,
    now: opts.now || (() => Date.now()),
    // A test can make the server slow for one kind of request. Awaited before the
    // request is looked at, so whatever it holds back has not happened yet.
    gate: null,
    get: (p) => clone(getAt(srv.root, p)),
  };

  function commit(writes, by) {
    const now = srv.now();
    const next = clone(srv.root) || {};
    const resolved = writes.map(w => {
      const v = resolveSV(getAt(next, w.path), w.value, now);
      setAt(next, w.path, v);
      return { path: parts(w.path).join('/'), value: v };
    });
    if (srv.rules) {
      const why = srv.rules(next, srv.root, resolved);
      if (why) { srv.refused.push({ by, why, writes: resolved }); return { ok: false, error: why }; }
    }
    srv.root = next;
    srv.log.push({ by, writes: resolved });
    const changes = resolved.map(w => ({ path: w.path, value: clone(getAt(srv.root, w.path)) }));
    for (const c of srv.clients) c.push(changes);
    return { ok: true, changes };
  }

  async function handle(client, req) {
    if (srv.gate) await srv.gate(req, client);
    if (req.op === 'hello') { client.live = true; return { root: clone(srv.root), now: srv.now() }; }
    if (req.op === 'write') return commit(req.writes, client.name);
    if (req.op === 'txn') {
      const cur = clone(getAt(srv.root, req.path));
      if (JSON.stringify(cur) !== req.base) return { ok: false, retry: true, current: cur };
      const r = commit([{ path: req.path, value: req.value }], client.name);
      return r.ok ? { ok: true, value: clone(getAt(srv.root, req.path)) } : r;
    }
    return { ok: false, error: 'unknown op' };
  }

  // Server-side writes: a bank credit arriving, a customer placing an order, the
  // Worker's multi-path PATCH.
  srv.write = (p, v) => commit([{ path: p, value: v }], 'server');
  srv.commit = commit;

  srv.attach = async (page, name) => {
    const client = { name, page, live: false, queue: Promise.resolve() };
    // In order, and never in parallel: a page must see the server's writes in the
    // order the server made them.
    client.push = (changes) => {
      if (!client.live) return;
      client.queue = client.queue.then(() =>
        page.evaluate((ch) => { if (window.__srvPush) window.__srvPush(ch); }, changes).catch(() => {}));
    };
    srv.clients.push(client);
    await page.exposeBinding('__rpc', (_src, req) => handle(client, req));
    await page.addInitScript(CLIENT);
    return client;
  };
  srv.detach = (page) => { srv.clients = srv.clients.filter(c => c.page !== page); };
  // Everything every page has been sent has been delivered.
  srv.settle = async () => { await Promise.all(srv.clients.map(c => c.queue)); };

  return srv;
}

// The page's side: window.firebase, backed by the server above.
const CLIENT = `
(() => {
  const clone = (v) => (v === undefined || v === null) ? null : JSON.parse(JSON.stringify(v));
  const parts = (p) => String(p == null ? '' : p).split('/').filter(Boolean);
  const norm = (p) => parts(p).join('/');
  ${getAt.toString()}
  ${prune.toString()}
  ${setAt.toString()}
  ${resolveSV.toString()}

  const local = {};                 // this till's copy of the database
  const listeners = [];
  let offset = 0;
  window.__local = local;
  window.__txnRuns = 0;

  const ordered = (v, q) => {
    if (!v || typeof v !== 'object') return [];
    let keys = Object.keys(v);
    if (q && q.orderBy) keys.sort((a, b) => {
      const x = (v[a] && v[a][q.orderBy]) || 0, y = (v[b] && v[b][q.orderBy]) || 0;
      return x !== y ? (x < y ? -1 : 1) : (a < b ? -1 : a > b ? 1 : 0);
    }); else keys.sort();
    if (q && q.limitToLast) keys = keys.slice(-q.limitToLast);
    if (q && q.limitToFirst) keys = keys.slice(0, q.limitToFirst);
    return keys;
  };
  const snapOf = (key, v, q) => {
    v = (v === undefined) ? null : v;
    const keys = ordered(v, q);
    const shaped = (v && typeof v === 'object' && q && (q.limitToLast || q.limitToFirst))
      ? keys.reduce((o, k) => { o[k] = v[k]; return o; }, {}) : v;
    return {
      key: key,
      val: () => clone(shaped),
      exists: () => shaped !== null,
      numChildren: () => keys.length,
      hasChild: (c) => !!(shaped && typeof shaped === 'object' && shaped[c] != null),
      child: (c) => snapOf(c, shaped && typeof shaped === 'object' ? shaped[c] : null),
      forEach: (cb) => { for (const k of keys) { if (cb(snapOf(k, v[k])) === true) return true; } return false; }
    };
  };
  const keyOf = (p) => { const ks = parts(p); return ks.length ? ks[ks.length - 1] : null; };
  const overlaps = (a, b) => a === b || a === '' || b === '' || a.indexOf(b + '/') === 0 || b.indexOf(a + '/') === 0;

  const fire = (changed) => {
    for (const l of listeners.slice()) {
      if (!changed.some(p => overlaps(l.path, p))) continue;
      const v = clone(getAt(local, l.path));
      const sig = JSON.stringify(v);
      if (l.sig === sig) continue;          // the SDK does not re-raise an unchanged value
      l.sig = sig;
      try { l.cb(snapOf(keyOf(l.path), v, l.q)); } catch (e) { setTimeout(() => { throw e; }, 0); }
    }
  };

  let ready = false;
  const waiting = [];
  const whenReady = (fn) => { if (ready) fn(); else waiting.push(fn); };
  window.__rpc({ op: 'hello' }).then(r => {
    for (const k of Object.keys(r.root || {})) local[k] = r.root[k];
    offset = (r.now || Date.now()) - Date.now();
    ready = true;
    waiting.splice(0).forEach(fn => fn());
  });
  const serverNow = () => Date.now() + offset;

  // What the server has just committed, from any till including this one.
  window.__srvPush = (changes) => {
    for (const c of changes) setAt(local, c.path, c.value);
    fire(changes.map(c => c.path));
  };

  const denied = (why) => { const e = new Error('PERMISSION_DENIED: ' + why); e.code = 'PERMISSION_DENIED'; return e; };

  // Applied here at once, then sent. A refusal puts back what was there.
  const write = (writes) => new Promise((resolve, reject) => {
    whenReady(() => {
      const before = writes.map(w => ({ path: w.path, value: clone(getAt(local, w.path)) }));
      for (const w of writes) setAt(local, w.path, resolveSV(getAt(local, w.path), w.value, serverNow()));
      fire(writes.map(w => w.path));
      window.__rpc({ op: 'write', writes: writes }).then(r => {
        if (r.ok) return resolve();
        for (const b of before.reverse()) setAt(local, b.path, b.value);
        fire(before.map(b => b.path));
        reject(denied(r.error));
      });
    });
  });

  const transact = (p, fn, cb, applyLocally) => new Promise((resolve) => {
    whenReady(() => {
      const finish = (err, committed, v) => {
        const s = snapOf(keyOf(p), v);
        if (cb) { try { cb(err, committed, s); } catch (e) { setTimeout(() => { throw e; }, 0); } }
        resolve({ committed: committed, snapshot: s });
      };
      const attempt = (base, tries) => {
        window.__txnRuns++;
        let next;
        try { next = fn(clone(base)); } catch (e) { return finish(e, false, base); }
        if (next === undefined) {
          // Aborted. Whatever this till had shown in the meantime goes back.
          setAt(local, p, base); fire([p]);
          return finish(null, false, base);
        }
        if (applyLocally !== false) { setAt(local, p, clone(next)); fire([p]); }
        const cutting = window.__cutTxn;
        if (cutting && cutting.list && cutting.list.length && p.indexOf(cutting.prefix) === 0) {
          const how = cutting.list.shift();
          const back = (v) => { setAt(local, p, v); fire([p]); finish(Object.assign(new Error('disconnect'), { code: 'disconnect' }), false, v); };
          // lost: it never reached the server, and the till's copy goes back to what it was
          if (how !== 'landed') return setTimeout(() => back(clone(base)), 30);
          // landed: the server has it, the till was never told — and sees the truth once it is back
          return window.__rpc({ op: 'txn', path: p, base: JSON.stringify(clone(base)), value: clone(next) })
            .then(r => back(r.ok ? r.value : (r.retry ? r.current : clone(base))));
        }
        window.__rpc({ op: 'txn', path: p, base: JSON.stringify(clone(base)), value: clone(next) }).then(r => {
          if (r.ok) { setAt(local, p, r.value); fire([p]); return finish(null, true, r.value); }
          if (r.retry && tries < 25) { setAt(local, p, r.current); fire([p]); return attempt(r.current, tries + 1); }
          setAt(local, p, clone(base)); fire([p]);
          finish(denied(r.error || 'maxretry'), false, base);
        });
      };
      attempt(clone(getAt(local, p)), 0);
    });
  });

  let pushN = 0;
  const pushKey = () => '-N' + serverNow().toString(36) + (pushN++).toString(36).padStart(3, '0') + Math.random().toString(36).slice(2, 8);

  const mkRef = (p, q) => {
    q = q || {};
    const self = {
      key: keyOf(p),
      toString: () => 'stub://' + p,
      child: (c) => mkRef(norm(p + '/' + c), {}),
      orderByChild: (f) => mkRef(p, Object.assign({}, q, { orderBy: f })),
      orderByKey: () => mkRef(p, q), orderByValue: () => mkRef(p, q),
      limitToLast: (n) => mkRef(p, Object.assign({}, q, { limitToLast: n })),
      limitToFirst: (n) => mkRef(p, Object.assign({}, q, { limitToFirst: n })),
      startAt: () => self, endAt: () => self, equalTo: () => self,
      on: (e, cb) => {
        if (e !== 'value') return cb;
        const l = { path: p, q: q, cb: cb, sig: undefined };
        listeners.push(l);
        whenReady(() => setTimeout(() => {
          if (listeners.indexOf(l) < 0 || l.sig !== undefined) return;
          const v = clone(p === '.info/connected' ? true : p === '.info/serverTimeOffset' ? offset : getAt(local, p));
          l.sig = JSON.stringify(v);
          cb(snapOf(keyOf(p), v, q));
        }, 0));
        return cb;
      },
      off: (_e, cb) => { for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].path === p && (!cb || listeners[i].cb === cb)) listeners.splice(i, 1); },
      once: (_e, cb) => new Promise((resolve) => whenReady(() => setTimeout(() => {
        const s = snapOf(keyOf(p), clone(getAt(local, p)), q);
        if (typeof cb === 'function') cb(s);
        resolve(s);
      }, 0))),
      push: (v) => {
        const child = mkRef(norm(p + '/' + pushKey()), {});
        if (v !== undefined) { const done = write([{ path: child.toString().slice(7), value: v }]); done.catch(() => {}); child.then = (a, b) => done.then(() => child).then(a, b); child.catch = (b) => done.catch(b); }
        return child;
      },
      set: (v) => write([{ path: p, value: v }]),
      remove: () => write([{ path: p, value: null }]),
      update: (obj) => write(Object.keys(obj || {}).map(k => ({ path: norm(p + '/' + k), value: obj[k] }))),
      transaction: (fn, cb, applyLocally) => transact(p, fn, cb, applyLocally)
    };
    return self;
  };

  const db = { ref: (p) => mkRef(norm(p), {}), goOnline: () => {}, goOffline: () => {} };
  const database = () => db;
  database.ServerValue = { TIMESTAMP: { '.sv': 'timestamp' }, increment: (n) => ({ '.sv': { increment: n } }) };
  const user = { uid: window.__TILL_UID || 'u1', email: 'till@cafeila.app', getIdToken: () => Promise.resolve('t') };
  window.firebase = {
    initializeApp: () => ({}), apps: [], database: database,
    auth: () => ({
      // Signed in, the way a till that has been open all day is.
      onAuthStateChanged: (cb) => { setTimeout(() => cb(user), 0); return () => {}; },
      signOut: () => Promise.resolve(), currentUser: user,
      signInWithEmailAndPassword: () => Promise.resolve({ user: user })
    })
  };

  // The Worker is not part of this. Nothing here should reach the network.
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('workers.dev') !== -1) {
      if (typeof window.__worker === 'function') return window.__worker(url, init);
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }
    return realFetch(input, init);
  };
})();
`;

module.exports = { createServer, getAt, setAt, clone };
