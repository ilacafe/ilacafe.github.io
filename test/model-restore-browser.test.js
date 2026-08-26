// Putting the previous wait-time model back, from the page rather than from the
// Firebase console.
//
// The refit snapshots the outgoing model to eta/modelPrevious before writing a
// new one. Restoring it was a documented trip to the console — the one manual
// step left in a project that has spent this long removing them.
//
// It writes eta/model wholesale and every till reads that node live, so this is
// the most consequential button on any of these pages. What is checked here is
// less "does it work" than "does it refuse in every case where it should, and
// does it say what it is about to do".

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Restoring the previous model — in a browser');

const V2 = { version: 2, fallback: { pizza: 9.4, drink: 5.5, baked: 3.1 },
             itemBase: { margherita: 9.1, espresso: 3.6 } };
const V1 = { version: 1, fallback: { pizza: 7.5, drink: 5.5, baked: 3.1 },
             itemBase: { margherita: 5.9, espresso: 3.6, latte: 5.8 } };
// A snapshot the engine could not read a base time out of. Restoring it would not
// break the café — the pages fall back to their built-in defaults — which is worse,
// because nothing would say the model had stopped mattering.
const HALF_WRITTEN = { version: 1, fallback: {} };

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
                '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/build.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(fs.readFileSync(path.join(ROOT, 'build.json')));
  }
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not here');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

function stub(model, prev) {
  return `
    window.__writes = [];
    window.confirm = (t) => { window.__confirmText = t; return true; };
    window.Chart = class { constructor(){ this.data = { datasets: [] }; this.options = {}; }
                           destroy(){} update(){} resize(){} };
    const DATA = { 'eta/model': ${JSON.stringify(model)}, 'eta/modelPrevious': ${JSON.stringify(prev)},
      'eta/recalMeta': { lastRunAt: Date.now() - 3 * 86400e3, lastResult: 'updated', version: 2 },
      'ops/cronFailure': null, 'security/voids': {}, 'security/unpaid': {},
      'users/u1': { role: 'admin' }, 'menu': {}, 'settings': {} };
    const noop = () => {};
    const snapOf = (o) => ({ val: () => (o === undefined ? null : o),
      forEach: (cb) => { Object.keys(o || {}).forEach(k => cb({ key: k, val: () => o[k] })); } });
    const ref = (p) => { const n = {
      limitToLast: () => n, orderByChild: () => n, orderByKey: () => n, startAt: () => n,
      endAt: () => n, equalTo: () => n, child: (c) => ref(p + '/' + c), push: () => ({ key: '-G' }),
      set: (v) => { window.__writes.push({ op: 'set', path: p, value: v }); return Promise.resolve(); },
      update: (v) => { window.__writes.push({ op: 'update', path: p, value: v }); return Promise.resolve(); },
      remove: () => Promise.resolve(), transaction: () => Promise.resolve({}),
      once: () => Promise.resolve(snapOf(DATA[p])),
      on: (e, cb) => { setTimeout(() => cb(snapOf(DATA[p])), 10); } }; return n; };
    const db = { ref, goOnline: noop, goOffline: noop };
    window.firebase = { initializeApp: noop, apps: [{}],
      database: Object.assign(() => db, { ServerValue: { TIMESTAMP: 0 } }),
      auth: () => ({ onAuthStateChanged: (cb) => { setTimeout(() => { try { cb({ uid: 'u1' }); } catch (e) {} }, 0); },
                     signOut: () => Promise.resolve(), currentUser: { uid: 'u1' } }),
      messaging: () => ({ getToken: () => Promise.resolve(null), onMessage: noop }) };
  `;
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(
    fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});

  const open = async (model, prev) => {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message || e).split('\n')[0]));
    await page.addInitScript(stub(model, prev));
    await page.route('**/*', (route) =>
      route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base + '/analytics.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    await page.click('#view-demand').catch(() => {});
    await page.waitForTimeout(250);
    return { ctx, page, errors };
  };

  const state = async (page) => page.evaluate(() => ({
    text: document.getElementById('model-restore').innerText.replace(/\s+/g, ' ').trim(),
    button: !!document.getElementById('restore-btn'),
  }));

  try {
    // ---------------------------------------------------------- when it refuses
    let s = await open(V2, null);
    let st = await state(s.page);
    check('with no snapshot kept there is no button',
          !st.button && /No previous model has been kept/.test(st.text), st.text);
    await s.ctx.close();

    s = await open(V2, HALF_WRITTEN);
    st = await state(s.page);
    check('a half-written snapshot is not offered', !st.button, st.text);
    check('and it says why, rather than just going quiet',
          /incomplete/.test(st.text) && /defaults/.test(st.text), st.text);
    note('restoring one would leave every page silently on its built-in defaults');
    await s.ctx.close();

    s = await open(V1, V1);
    st = await state(s.page);
    check('a snapshot identical to the model in use is not offered',
          !st.button && /identical/.test(st.text), st.text);
    await s.ctx.close();

    // ---------------------------------------------------------- when it offers
    s = await open(V2, V1);
    st = await state(s.page);
    check('a genuinely different snapshot is offered', st.button, st.text);
    check('and both models are described before anything is clicked',
          /v2/.test(st.text) && /9\.4/.test(st.text) && /v1/.test(st.text) && /7\.5/.test(st.text),
          st.text);
    note('version and pizza base — the two numbers a person can actually judge');

    await s.page.click('#restore-btn');
    await s.page.waitForTimeout(300);
    const after = await s.page.evaluate(() => ({
      writes: window.__writes,
      confirmText: window.__confirmText || '',
      note: document.getElementById('restore-note').innerText.trim(),
      disabled: (document.getElementById('restore-btn') || {}).disabled,
    }));

    check('it asks first, naming what is in use and what replaces it',
          /v2/.test(after.confirmText) && /v1/.test(after.confirmText) &&
          /9\.4/.test(after.confirmText) && /7\.5/.test(after.confirmText),
          JSON.stringify(after.confirmText));
    check('and warns that the tills pick it up straight away',
          /straight away/.test(after.confirmText), JSON.stringify(after.confirmText));

    const setModel = after.writes.find(w => w.op === 'set' && w.path === 'eta/model');
    check('it writes the saved snapshot to eta/model, exactly',
          !!setModel && JSON.stringify(setModel.value) === JSON.stringify(V1),
          setModel ? JSON.stringify(setModel.value) : 'nothing was written');

    const stamp = after.writes.find(w => w.op === 'update' && w.path === 'eta/recalMeta');
    check('and records that a restore happened',
          !!stamp && !!stamp.value.lastRestoredAt && String(stamp.value.lastRestoredTo) === '1',
          stamp ? JSON.stringify(stamp.value) : 'the restore was not recorded');
    note('without this the panel above would go on saying "Refitted, version 2"');
    note('while version 1 is what the tills are using — confidently wrong');

    check('nothing else was written', after.writes.length === 2,
          after.writes.map(w => w.op + ' ' + w.path).join(', '));
    check('it says what happened', /v1/.test(after.note), after.note);
    check('and does not offer a second click while it is working', after.disabled === true);
    check('the page did not throw', s.errors.length === 0, s.errors.join(' | '));
    await s.ctx.close();
  } finally {
    await browser.close();
    server.close();
  }

  done();
})().catch((e) => { server.close(); console.error(e); process.exit(1); });
