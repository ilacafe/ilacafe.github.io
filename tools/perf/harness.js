// The pages, served locally, against a database that isn't there.
//
// Two pieces every probe needs: a static server for the repo, and a Firebase stub that
// answers a page's queries out of the fixture beside this file.
//
// THE STUB HONOURS THE QUERY, AND THAT IS THE WHOLE POINT
//
// limitToLast, orderByKey and startAt are emulated rather than ignored, because what a
// page ASKS FOR is the thing being measured. A stub that hands back the whole node
// whatever was requested would report every page as pulling the entire database, and
// the one real finding — analytics reading 120 complete cash-ups to render five numbers
// a day — would have been indistinguishable from admin's correctly-capped reads.
//
// Off-origin requests are aborted by every probe. The Firebase SDK never loads; this
// stub is what the page gets. A browser suite once passed for the wrong reason when the
// real SDK loaded over the top of its stub, so probes assert window.__stub as well.

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
                '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.css': 'text/css' };

function serve() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const f = path.join(ROOT, u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404); return res.end('no');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () =>
    r({ server, base: 'http://127.0.0.1:' + server.address().port })));
}

// opts.role      — what users/<uid> answers with (default 'admin', so every page opens)
// opts.rtt       — ms before a listener fires, i.e. the database round trip
// opts.connectAt — ms before .info/connected goes true; null never connects (offline)
// opts.count     — record bytes delivered per path into window.__reads
const stub = (db, opts = {}) => {
  const o = Object.assign({ role: 'admin', rtt: 40, connectAt: 30, count: false }, opts);
  return `
(() => {
  const noop = () => {};
  const D = ${JSON.stringify(db)};
  const O = ${JSON.stringify(o)};
  window.__db = D; window.__stub = true; window.__reads = {}; window.__writes = {}; window.__cbs = {};

  // A path may name a node, or a child inside one. Walk back until something is known.
  const byPath = p => {
    if (D[p] !== undefined) return D[p];
    const parts = String(p).split('/');
    for (let i = parts.length - 1; i > 0; i--) {
      const head = parts.slice(0, i).join('/');
      if (D[head] !== undefined) {
        let v = D[head];
        for (const k of parts.slice(i)) v = (v == null ? undefined : v[k]);
        return v;
      }
    }
    return null;
  };
  const setPath = (p, v) => {
    const parts = String(p).split('/');
    for (let i = parts.length - 1; i > 0; i--) {
      const head = parts.slice(0, i).join('/');
      if (D[head] !== undefined) {
        let obj = D[head]; const rest = parts.slice(i);
        for (let j = 0; j < rest.length - 1; j++) { obj[rest[j]] = obj[rest[j]] || {}; obj = obj[rest[j]]; }
        obj[rest[rest.length - 1]] = v; return;
      }
    }
    D[p] = v;
  };
  const size = v => { try { return new TextEncoder().encode(JSON.stringify(v === undefined ? null : v)).length; }
                      catch (e) { return 0; } };
  const tally = (bag, p, v) => { const e = bag[p] || (bag[p] = { calls: 0, bytes: 0 });
                                 e.calls++; e.bytes += size(v); };
  const snap = v => ({
    val: () => v, exists: () => v != null,
    forEach: cb => { if (v && typeof v === 'object') Object.keys(v).forEach(k => cb({ key: k, val: () => v[k] })); },
    numChildren: () => (v && typeof v === 'object' ? Object.keys(v).length : 0), key: null,
    child: () => ({ val: () => undefined, exists: () => false })
  });
  const applyQ = (val, q) => {
    if (!val || typeof val !== 'object' || Array.isArray(val)) return val;
    let keys = Object.keys(val);
    if (q.orderByKey || q.orderByChild) keys.sort();
    if (q.startAt != null) keys = keys.filter(k => String(k) >= String(q.startAt));
    if (q.limitToLast != null) keys = keys.slice(-q.limitToLast);
    const out = {}; keys.forEach(k => out[k] = val[k]); return out;
  };
  const mk = (p, q) => ({
    on: (e, cb) => {
      if (e !== 'value') return cb;
      (window.__cbs[p] = window.__cbs[p] || []).push(cb);
      if (p === '.info/connected') {
        setTimeout(() => { try { cb(snap(false)); } catch (x) {} }, 0);
        if (O.connectAt != null) setTimeout(() => { try { cb(snap(true)); } catch (x) {} }, O.connectAt);
        return cb;
      }
      if (p === '.info/serverTimeOffset') { setTimeout(() => { try { cb(snap(0)); } catch (x) {} }, 0); return cb; }
      const v = applyQ(byPath(p), q);
      if (O.count) tally(window.__reads, p, v);
      setTimeout(() => { try { cb(snap(v)); } catch (x) {} }, O.rtt);
      return cb;
    },
    once: () => {
      if (p.indexOf('users/') === 0) return Promise.resolve(snap({ role: O.role, name: 'A' }));
      const v = applyQ(byPath(p), q);
      if (O.count) tally(window.__reads, p, v);
      return new Promise(r => setTimeout(() => r(snap(v)), O.rtt));
    },
    off: noop, child: k => mk(p + '/' + k, q),
    orderByChild: () => mk(p, Object.assign({}, q, { orderByChild: true })),
    orderByKey:   () => mk(p, Object.assign({}, q, { orderByKey: true })),
    startAt: v => mk(p, Object.assign({}, q, { startAt: v })),
    limitToLast: n => mk(p, Object.assign({}, q, { limitToLast: n })),
    push: () => ({ key: 'k' + Math.random().toString(36).slice(2) }),
    set: v => { tally(window.__writes, p, v); setPath(p, v); return Promise.resolve(); },
    update: v => { if (p === '') Object.keys(v).forEach(k => { tally(window.__writes, k, v[k]); setPath(k, v[k]); });
                   else tally(window.__writes, p, v);
                   return Promise.resolve(); },
    remove: () => Promise.resolve(),
    transaction: (f, cb) => { if (cb) cb(null, false, snap(null)); return Promise.resolve({ committed: false }); }
  });
  const db = { ref: p => mk(String(p == null ? '' : p), {}), goOnline: noop, goOffline: noop };

  // Re-fire a listener, so a probe can play a service through a page that is already up.
  window.__fire = (p, v) => (window.__cbs[p] || []).forEach(cb => { try { cb(snap(v)); } catch (x) {} });

  // Charts are somebody else's library and the CDN is blocked here.
  window.Chart = function (c, cfg) { this.cfg = cfg; this.destroy = noop; this.update = noop; this.resize = noop; };
  window.Chart.defaults = { font: {}, plugins: {} }; window.Chart.register = noop;

  window.firebase = {
    initializeApp: noop, apps: [{}],
    database: Object.assign(() => db, { ServerValue: { TIMESTAMP: Date.now(), increment: n => n } }),
    auth: () => ({ onAuthStateChanged: cb => setTimeout(() => { try { cb({ uid: 'u1' }); } catch (x) {} }, 0),
                   signInWithEmailAndPassword: () => Promise.resolve({}), signOut: () => Promise.resolve(),
                   currentUser: { uid: 'u1' } }),
    messaging: () => ({ getToken: () => Promise.resolve(null), onMessage: noop })
  };
  try { localStorage.setItem('ila.role.v1', JSON.stringify({ uid: 'u1', role: O.role, name: 'A' })); } catch (e) {}
})();`;
};

const PAGES = ['index.html', 'pos.html', 'chef.html', 'barista.html',
               'admin.html', 'analytics.html', 'inventory.html'];

// Chromium is pre-installed in CI images; fall back to whatever Playwright found.
const CHROMIUM = '/opt/pw-browsers/chromium';
const launchOpts = () => (fs.existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {});

module.exports = { serve, stub, PAGES, ROOT, launchOpts };
