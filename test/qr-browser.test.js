// The end-to-end check: load the real pos.html in Chromium with every outbound
// request blocked, draw payment codes through the page's own showQR(), read the
// pixels back off the canvas and decode them.
//
// This is the one that would catch the page failing to parse, the canvas
// scaling going wrong, or a code silently needing the network — none of which
// the pure-JS suite can see.
//
// Run separately from `npm test` because it needs a browser: `npm run test:browser`.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const jsQR = require('jsqr').default || require('jsqr');
const { ROOT, suite } = require('./helpers');

// Firebase is stubbed so the page runs with no network and no credentials.
// Every ref() method is a chaining no-op, which is all the load-time wiring needs.
const FIREBASE_STUB = `
(() => {
  const noop = () => {};
  const refProxy = () => new Proxy(function(){}, {
    get: (t, k) => {
      if (k === 'then') return undefined;
      if (k === 'q') return { off: noop };
      return refProxy();
    },
    apply: () => refProxy()
  });
  const db = { ref: () => refProxy(), goOnline: noop, goOffline: noop };
  const auth = {
    onAuthStateChanged: (cb) => setTimeout(() => cb(null), 0),
    signInWithEmailAndPassword: () => Promise.resolve({}),
    signOut: () => Promise.resolve(),
    currentUser: null
  };
  const database = () => db;
  database.ServerValue = { TIMESTAMP: 0, increment: (n) => n };
  window.firebase = { initializeApp: () => ({}), apps: [], database, auth: () => auth };
})();
`;

(async () => {
  // Some environments ship a prebuilt Chromium at a known path; CI installs its
  // own via `npx playwright install chromium`. Prefer the prebuilt one when it is
  // actually there rather than discovering its absence through a rejected launch.
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const page = await browser.newPage();
  await page.addInitScript(FIREBASE_STUB);

  // Everything outbound is blocked, so the page runs with no network at all.
  // What this fix actually claims is narrower than "the page makes no requests"
  // (it still wants fonts and the Firebase SDK): it is that DRAWING A CODE makes
  // none. So requests are only recorded while a render is in flight.
  let recording = false;
  const hitsDuringRender = [];
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (recording) hitsDuringRender.push(url);
    return route.abort();
  });

  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  await page.goto('file://' + path.join(ROOT, 'pos.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  const { check, note, done } = suite('QR in the browser — real pos.html, network blocked');

  check('the page parses and defines the encoder',
        await page.evaluate(() => typeof window.ilaQR === 'object' && typeof window.ilaQR.drawToCanvas === 'function'),
        pageErrors.length ? 'page errors: ' + pageErrors.slice(0, 2).join(' | ') : '');

  recording = true;
  for (const amount of ['250', '1250.5', '99999.99', '40']) {
    const payload = `upi://pay?pa=ilacafe@okhdfcbank&pn=ILA&am=${amount}&cu=INR`;
    const shot = await page.evaluate((p) => {
      const c = document.getElementById('qr-image');
      c.style.display = 'block';
      window.showQR(p);                                     // the page's own function
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      return { w: c.width, h: c.height, data: Array.from(d.data) };
    }, payload);
    const out = jsQR(new Uint8ClampedArray(shot.data), shot.w, shot.h);
    check('₹' + amount + ' — the canvas decodes to the exact payment string',
          !!out && out.data === payload,
          out ? 'got ' + JSON.stringify(out.data) : 'no code found in ' + shot.w + '×' + shot.h);
  }
  await page.waitForTimeout(150);
  recording = false;
  check('drawing the codes required no network request', hitsDuringRender.length === 0,
        hitsDuringRender.slice(0, 3).join(', '));

  // A hidden canvas keeps its bitmap. The previous table's code must not be one
  // style change away from being on screen again.
  const cleared = await page.evaluate(() => {
    window.showQR('upi://pay?pa=x@y&pn=ILA&am=250&cu=INR');
    const c = document.getElementById('qr-image');
    window.clearQR();
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let anyInk = false;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] !== 0) { anyInk = true; break; }
    return { hidden: c.style.display === 'none', anyInk };
  });
  check('clearQR hides the canvas', cleared.hidden);
  check('clearQR wipes the bitmap', cleared.anyInk === false);

  const changed = await page.evaluate(() => {
    const c = document.getElementById('qr-image');
    const px = () => Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data);
    window.showQR('upi://pay?pa=x@y&pn=ILA&am=250&cu=INR'); const a = px();
    window.showQR('upi://pay?pa=x@y&pn=ILA&am=260&cu=INR'); const b = px();
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i]) diff++;
    return diff;
  });
  check('a new amount replaces the code on screen', changed > 100, changed + ' pixels changed');

  if (pageErrors.length) note('page errors seen: ' + pageErrors.slice(0, 3).join(' | '));

  done();
  await browser.close();
})();
