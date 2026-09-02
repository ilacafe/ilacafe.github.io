// The app's own list and calendar, instead of the platform's wheel.
//
// A <select> raises the operating system's picker — on iOS a grey drum at the bottom
// of the screen with none of the café's colours in it — and a date field raises its
// calendar. They are the correct CONTROLS, and they were the last places these pages
// handed off to something that does not look like the app: eight selects on admin,
// three and two date fields on analytics.
//
// WHAT MAKES THIS SAFE IS THAT NOTHING WAS REPLACED. The native element stays in the
// document, hidden, holding the value. Every `.value` read and every `onchange=` on
// those pages still talks to it — thirteen controls, and not one call site changed.
// A branded button sits in front, opens a branded list or calendar, writes the value
// back and dispatches a real `change`.
//
// So the checks are in two halves: the face is what a thumb touches, and the native
// control is still what the page reads. Losing either one is the bug.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Selects and dates — the app\'s own, not the platform\'s');

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

const STUB = `
(() => {
  const snap = (o) => ({ val: () => (o === undefined ? null : o), exists: () => o != null,
                         numChildren: () => 0, forEach: () => {}, key: null });
  const mk = (p) => { const s = {
    key: 'k', child: () => mk(p), orderByChild: () => s, orderByKey: () => s,
    limitToLast: () => s, limitToFirst: () => s, startAt: () => s, endAt: () => s, equalTo: () => s,
    on: (_e, cb) => { try { if (cb) cb(snap(null)); } catch (e) {} return cb; }, off: () => {},
    once: (_e, cb) => { const x = snap(null); if (cb) cb(x); return Promise.resolve(x); },
    push: () => mk(p), set: () => Promise.resolve(), update: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    transaction: (_f, cb) => { const x = snap(null); if (cb) cb(null, false, x); return Promise.resolve({ committed: false, snapshot: x }); }
  }; return s; };
  const database = () => ({ ref: (p) => mk(p || ''), goOnline: () => {}, goOffline: () => {} });
  database.ServerValue = { TIMESTAMP: 1756200000000, increment: (n) => ({ '.sv': { increment: n } }) };
  window.firebase = {
    initializeApp: () => ({}), apps: [], database: database,
    auth: () => ({ currentUser: { uid: 'u1' },
                   onAuthStateChanged: (cb) => { setTimeout(() => { try { cb({ uid: 'u1' }); } catch (e) {} }, 0); return () => {}; },
                   signOut: () => Promise.resolve(),
                   signInWithEmailAndPassword: () => Promise.resolve({ user: { uid: 'u1' } }),
                   signInAnonymously: () => Promise.resolve({ user: { uid: 'a' } }) })
  };
  window.Chart = function () { return { destroy(){}, update(){}, data:{datasets:[]}, options:{} }; };
})();
`;

const DLG = '.ila-dialog';

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PRE = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PRE) ? { executablePath: PRE } : {});
  const threw = [];

  // ---------------------------------------- nothing native is left facing a thumb
  for (const page of ['admin.html', 'analytics.html']) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true });
    await ctx.addInitScript(STUB);
    const pg = await ctx.newPage();
    pg.on('pageerror', e => threw.push(page + ': ' + String(e.message || e).split('\n')[0]));
    await pg.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    await pg.goto(base + '/' + page, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(900);
    await pg.evaluate(() => { const o = document.getElementById('login-overlay'); if (o) o.style.display = 'none'; });
    await pg.waitForTimeout(300);

    const state = await pg.evaluate(() => {
      const natives = [...document.querySelectorAll('select, input[type="date"]')];
      // "Facing a thumb" is about pixels, not about being in the document: the native
      // control is deliberately still there, and must be down to a pixel and untouchable.
      const exposed = natives.filter(n => {
        const r = n.getBoundingClientRect();
        return (r.width > 4 || r.height > 4) && getComputedStyle(n).pointerEvents !== 'none';
      });
      return { natives: natives.length, exposed: exposed.length,
               faces: document.querySelectorAll('.ila-face').length,
               unfaced: natives.filter(n => !n.__ilaFaced).length };
    });

    check(page + ' has a branded face for every native control',
          state.natives > 0 && state.unfaced === 0,
          state.natives + ' native, ' + state.unfaced + ' still bare');
    check('and none of them is left facing a thumb', state.exposed === 0,
          state.exposed + ' still take a tap');
    check('and the native controls are all still in the document', state.natives === state.faces,
          state.natives + ' native vs ' + state.faces + ' faces');
    note('they hold the value — every .value read and onchange= on this page is on them');
    await ctx.close();
  }

  // ------------------------------------ and the face actually drives the control
  {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true });
    const pg = await ctx.newPage();
    pg.on('pageerror', e => threw.push('bare: ' + String(e.message || e).split('\n')[0]));
    await pg.setContent(
      '<!doctype html><html><head><style>:root{--brand-bg:#8D6E52;--brand-text:#fff}</style></head><body>' +
      '<label for="role">Role</label>' +
      '<select id="role" onchange="window.__fired=(window.__fired||0)+1">' +
      '<option value="a">Admin</option><option value="b" selected>Barista</option><option value="c">Chef</option></select>' +
      '<label for="d1">From</label>' +
      '<input type="date" id="d1" value="2026-08-14" onchange="window.__dfired=(window.__dfired||0)+1">' +
      '<div id="later"></div></body></html>');
    await pg.addScriptTag({ url: base + '/dialogs.js' });
    await pg.waitForTimeout(250);

    const faces = () => pg.evaluate(() => [...document.querySelectorAll('.ila-face')].map(b => b.innerText.replace(/\s+/g, ' ').trim()));
    check('the face shows what the control is currently set to',
          (await faces())[0] === 'Barista ▾', JSON.stringify(await faces()));
    check('and a date reads as a date, not as 2026-08-14',
          (await faces())[1] === '14 Aug 2026 ▾', JSON.stringify(await faces()));

    await pg.click('.ila-face');
    await pg.waitForSelector(DLG, { state: 'visible' });
    const dlg = await pg.evaluate((s) => {
      const c = document.querySelector(s + ' [role="dialog"]');
      return { title: document.getElementById(c.getAttribute('aria-labelledby')).textContent,
               marked: (document.querySelector(s + ' [aria-current="true"]') || {}).textContent,
               smallest: Math.min(...[...document.querySelectorAll(s + ' button')]
                 .map(b => b.getBoundingClientRect().height)) };
    }, DLG);
    check('the list is titled with whatever the control is called on screen', dlg.title === 'Role', dlg.title);
    check('and the option already chosen is the one marked', dlg.marked === 'Barista', String(dlg.marked));
    check('and every option is at least 44px tall', dlg.smallest >= 44, dlg.smallest + 'px');

    await pg.click(`${DLG} button:nth-of-type(3)`);
    await pg.waitForTimeout(200);
    const after = await pg.evaluate(() => ({ v: document.getElementById('role').value, fired: window.__fired || 0 }));
    check('choosing writes the value onto the native control', after.v === 'c', 'value is ' + after.v);
    // The whole point: onchange= attributes on these pages are listening for this.
    check('and fires exactly one real change event', after.fired === 1, after.fired + ' events');
    check('and the face catches up', (await faces())[0] === 'Chef ▾', JSON.stringify(await faces()));

    // Backing out must not touch anything.
    await pg.click('.ila-face');
    await pg.waitForSelector(DLG, { state: 'visible' });
    await pg.keyboard.press('Escape');
    await pg.waitForTimeout(150);
    const same = await pg.evaluate(() => ({ v: document.getElementById('role').value, fired: window.__fired || 0 }));
    check('and backing out changes nothing and fires nothing',
          same.v === 'c' && same.fired === 1, JSON.stringify(same));

    // ---- the calendar ----
    await pg.click('.ila-face:last-of-type');
    await pg.waitForSelector(DLG + ' button', { state: 'visible' });
    const cal = await pg.evaluate((s) => {
      const c = document.querySelector(s + ' [role="dialog"]');
      return { title: document.getElementById(c.getAttribute('aria-labelledby')).textContent,
               month: (c.innerText.match(/august 2026/i) || [])[0],
               today: !!c.querySelector('[aria-current="date"]') };
    }, DLG);
    check('the calendar opens on the month the field is already set to',
          /^august 2026$/i.test(cal.month || ''), String(cal.month));
    check('and marks the day it is set to', cal.today, 'nothing marked');
    await pg.click(`${DLG} button[aria-label="20 August 2026"]`);
    await pg.waitForTimeout(200);
    const d = await pg.evaluate(() => ({ v: document.getElementById('d1').value, fired: window.__dfired || 0 }));
    check('picking a day writes an ISO date onto the native field', d.v === '2026-08-20', d.v);
    check('and fires one change event', d.fired === 1, d.fired + ' events');

    // ---- a control that did not exist when the page loaded ----
    //
    // Two on admin are built at runtime — the role picker on each staff row, and the
    // ingredient rows on a recipe — so watching for them is not optional.
    await pg.evaluate(() => {
      document.getElementById('later').innerHTML =
        '<select id="fresh"><option value="x">Ex</option><option value="y">Why</option></select>';
    });
    await pg.waitForTimeout(250);
    check('a control built after the page loaded gets a face too',
          await pg.evaluate(() => !!document.getElementById('fresh').__ilaFaced), 'it stayed bare');

    await ctx.close();
  }

  // --------------------------------------------- and if this never runs at all
  //
  // A script error or an old cache must leave a working native control behind, not a
  // dead page. The value lives on the native element precisely so that is true.
  {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    const pg = await ctx.newPage();
    await pg.setContent('<!doctype html><body><select id="s"><option value="a">A</option></select></body>');
    const usable = await pg.evaluate(() => {
      const s = document.getElementById('s');
      const r = s.getBoundingClientRect();
      return r.width > 4 && !s.hasAttribute('aria-hidden');
    });
    check('without dialogs.js the native control is untouched and usable', usable, 'it was hidden anyway');
    note('less consistent and nothing broken is the right way round');
    await ctx.close();
  }

  check('no page threw while any of that ran', threw.length === 0, threw.join(' | '));

  await browser.close();
  server.close();
  done();
})();
