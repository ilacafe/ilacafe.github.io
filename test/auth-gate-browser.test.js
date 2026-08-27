// Whether a device that is already signed in is treated like one.
//
// The complaint was that the apps "sign you in every time you open them", and they
// did — visibly, if not literally. Firebase restores the session off the device with
// no network at all, but every page then refused to show anything until it had read
// users/<uid> back from the database, and the login form sits in the markup with
// nothing hiding it. So the whole of that round trip, on café wifi, a member of staff
// is looking at a password field on a device that is already authenticated. They type
// into it, because what else is a password field for.
//
// Six pages had their own copy of that. This drives all six, in a real browser, with
// a stubbed SDK so the profile read can be made slow, empty, or broken on purpose.
//
// What has to hold, on every one of them:
//   - no session          -> the form, promptly
//   - session + a role remembered here -> straight in, with NO profile read waited on
//   - session, nothing remembered      -> no password field while it finds out
//   - the account really has no role   -> signed out, told why, and the role forgotten
//   - the read simply failed           -> a remembered device stays open; nothing is
//                                         signed out, because a failed read says
//                                         nothing about an account
//   - a cashier's remembered role must not open admin or analytics

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Staying signed in — the login screen on all six pages');

const STAFF = ['pos.html', 'chef.html', 'barista.html', 'inventory.html'];
const OWNER = ['admin.html', 'analytics.html'];
const PAGES = STAFF.concat(OWNER);

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

// The SDK, stubbed so this suite owns the two things that matter: when the auth state
// resolves, and what (if anything) the profile read gives back.
const STUB = `
(() => {
  window.__signOuts = 0;
  window.__profileReads = 0;
  const snapOf = (o) => ({ key: null, val: () => (o === undefined ? null : o),
                           exists: () => o != null, numChildren: () => 0, forEach: () => {} });
  const mkRef = (p) => {
    const self = {
      key: 'stub', toString: () => 'stub://' + p, child: (c) => mkRef(p + '/' + c),
      orderByChild: () => self, orderByKey: () => self, limitToLast: () => self,
      limitToFirst: () => self, startAt: () => self, endAt: () => self, equalTo: () => self,
      on: (_e, cb) => { try { if (cb) cb(snapOf(null)); } catch (e) {} return cb; },
      off: () => {},
      once: (_e, cb) => {
        if (p.indexOf('users/') === 0) {
          window.__profileReads++;
          const mode = window.__profileMode;
          if (mode === 'hang')   return new Promise(() => {});
          if (mode === 'reject') return Promise.reject(new Error('permission_denied'));
          const s = snapOf(window.__profile === undefined ? null : window.__profile);
          if (cb) cb(s);
          return Promise.resolve(s);
        }
        const s = snapOf(null); if (cb) cb(s); return Promise.resolve(s);
      },
      push: () => mkRef(p + '/-Nstub'), set: () => Promise.resolve(),
      update: () => Promise.resolve(), remove: () => Promise.resolve(),
      transaction: (_f, cb) => { const s = snapOf(null); if (cb) cb(null, false, s); return Promise.resolve({ committed: false, snapshot: s }); }
    };
    return self;
  };
  const db = { ref: (p) => mkRef(String(p == null ? '' : p).replace(/^\\/+|\\/+$/g, '')),
               goOnline: () => {}, goOffline: () => {} };
  const database = () => db;
  database.ServerValue = { TIMESTAMP: 1756200000000, increment: (n) => ({ '.sv': { increment: n } }) };
  const auth = () => ({
    currentUser: null,
    onAuthStateChanged: (cb) => { window.__authCb = cb; return () => {}; },
    signOut: () => { window.__signOuts++; return Promise.resolve(); },
    signInWithEmailAndPassword: () => Promise.resolve({ user: { uid: 'u1' } }),
    signInAnonymously: () => Promise.resolve({ user: { uid: 'anon' } }),
    useEmulator: () => {}
  });
  window.firebase = { initializeApp: () => ({}), apps: [], database: database, auth: auth };

  // analytics.html draws with Chart.js from a CDN this suite deliberately cannot
  // reach. Nothing here is about charts; without the stub the page throws on open
  // and buries the thing that IS being tested.
  window.Chart = function () { return { destroy: () => {}, update: () => {}, resize: () => {},
                                        data: { datasets: [] }, options: {} }; };
  window.Chart.register = () => {};
})();
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const errors = [];

  // remembered: what to seed into localStorage before the page runs
  async function open(page, { remembered, profile, mode } = {}) {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const pg = await ctx.newPage();
    pg.on('pageerror', e => errors.push(page + ': ' + String(e.message || e).split('\n')[0]));
    await pg.addInitScript(STUB);
    await pg.addInitScript(([r, p, m]) => {
      if (r) { try { localStorage.setItem('ila.role.v1', JSON.stringify(r)); } catch (e) {} }
      else   { try { localStorage.removeItem('ila.role.v1'); } catch (e) {} }
      window.__profile = p;
      window.__profileMode = m;
    }, [remembered || null, profile === undefined ? null : profile, mode || null]);
    await pg.route('**/*', route =>
      route.request().url().startsWith(base) ? route.continue() : route.abort());
    await pg.goto(base + '/' + page, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction(() => typeof window.__authCb === 'function', null, { timeout: 5000 });
    return { ctx, pg };
  }

  const state = (pg) => pg.evaluate(() => {
    const ov = document.getElementById('login-overlay');
    const em = document.getElementById('login-email');
    return {
      overlayHidden: !!ov && ov.classList.contains('hidden'),
      fieldsVisible: !!em && em.style.display !== 'none',
      error: (document.getElementById('login-error') || {}).innerText || '',
      signOuts: window.__signOuts,
      profileReads: window.__profileReads,
      remembered: (() => { try { return localStorage.getItem('ila.role.v1'); } catch (e) { return null; } })()
    };
  });

  // ------------------------------------------------ before auth has said anything
  {
    const bad = [];
    for (const page of PAGES) {
      const { ctx, pg } = await open(page);
      const s = await state(pg);
      if (s.fieldsVisible) bad.push(page);
      await ctx.close();
    }
    check('no page shows a password field before it knows one is needed',
          bad.length === 0, bad.join(', '));
    note('this is the whole complaint: the form was in the markup with nothing hiding it,');
    note('so every open began by asking for a password the device did not need');
  }

  // ------------------------------------------------------------- no session at all
  {
    const bad = [];
    for (const page of PAGES) {
      const { ctx, pg } = await open(page);
      await pg.evaluate(() => { window.__authCb(null); });
      await sleep(60);
      const s = await state(pg);
      if (!s.fieldsVisible || s.overlayHidden) bad.push(page + ' ' + JSON.stringify(s));
      await ctx.close();
    }
    check('a device with no session is asked to sign in', bad.length === 0, bad.join('; '));
  }

  // -------------------------------------- a session, and a role remembered here
  {
    const bad = [], readsWaited = [];
    for (const page of PAGES) {
      const role = OWNER.includes(page) ? 'admin' : 'cashier';
      const { ctx, pg } = await open(page, {
        remembered: { uid: 'u1', role: role, name: 'Priya' },
        mode: 'hang'                      // the profile read never comes back
      });
      await pg.evaluate(() => { window.__authCb({ uid: 'u1', email: 'p@ila.test' }); });
      await sleep(120);
      const s = await state(pg);
      if (!s.overlayHidden) bad.push(page + ' ' + JSON.stringify(s));
      await ctx.close();
    }
    check('a remembered device opens without waiting for the network at all',
          bad.length === 0, bad.join('; '));
    note('the profile read is made to hang here, so passing means nothing waited on it —');
    note('that wait, with a password field on screen, was the delay staff were seeing');
  }

  // ------------------------------- a session, but this device has not been here
  {
    const bad = [];
    for (const page of PAGES) {
      const { ctx, pg } = await open(page, { mode: 'hang' });
      await pg.evaluate(() => { window.__authCb({ uid: 'u1', email: 'p@ila.test' }); });
      await sleep(120);
      const s = await state(pg);
      if (s.fieldsVisible) bad.push(page + ' ' + JSON.stringify(s));
      await ctx.close();
    }
    check('and one that has not still is not asked for a password while it finds out',
          bad.length === 0, bad.join('; '));
    note('it says what it is doing instead, and reveals the form only if it must');
  }

  // ------------------------------------------- the account really has no access
  {
    const bad = [];
    for (const page of PAGES) {
      const { ctx, pg } = await open(page, {
        remembered: { uid: 'u1', role: 'cashier', name: 'Priya' },
        profile: { name: 'Priya' }            // exists, but carries no role
      });
      await pg.evaluate(() => { window.__authCb({ uid: 'u1', email: 'p@ila.test' }); });
      await sleep(150);
      const s = await state(pg);
      if (s.signOuts !== 1 || !s.fieldsVisible || s.remembered) bad.push(page + ' ' + JSON.stringify(s));
      await ctx.close();
    }
    check('an account with no role is signed out, told why, and forgotten',
          bad.length === 0, bad.join('; '));
    note('forgotten matters: a remembered role that outlived its account would let the');
    note('next open sail past the gate, on every page, until the cache happened to clear');
  }

  // -------------------------------------------------- the read merely failed
  {
    const stillOpen = [], wronglyOut = [];
    for (const page of PAGES) {
      const role = OWNER.includes(page) ? 'admin' : 'cashier';
      const { ctx, pg } = await open(page, {
        remembered: { uid: 'u1', role: role, name: 'Priya' }, mode: 'reject'
      });
      await pg.evaluate(() => { window.__authCb({ uid: 'u1', email: 'p@ila.test' }); });
      await sleep(150);
      const s = await state(pg);
      if (!s.overlayHidden) stillOpen.push(page);
      if (s.signOuts !== 0) wronglyOut.push(page);
      await ctx.close();
    }
    check('a failed read does not put a remembered device out', stillOpen.length === 0, stillOpen.join(', '));
    check('and does not sign anybody out', wronglyOut.length === 0, wronglyOut.join(', '));
    note('a read that failed says nothing about an account — the rules still govern');
    note('every read behind the screen, so staying open costs nothing');
  }

  // ------------------------------------------------ a cashier is not an owner
  {
    const leaked = [];
    for (const page of OWNER) {
      const { ctx, pg } = await open(page, {
        remembered: { uid: 'u1', role: 'cashier', name: 'Priya' }, mode: 'hang'
      });
      await pg.evaluate(() => { window.__authCb({ uid: 'u1', email: 'p@ila.test' }); });
      await sleep(120);
      const s = await state(pg);
      if (s.overlayHidden) leaked.push(page);
      await ctx.close();
    }
    check('a remembered cashier does not walk into admin or analytics',
          leaked.length === 0, leaked.join(', '));
    note('the rules deny the data either way; this is about not drawing the screen');
  }

  check('no page threw while any of that ran', errors.length === 0, errors.slice(0, 4).join('; '));

  await browser.close();
  server.close();
  done();
})();
