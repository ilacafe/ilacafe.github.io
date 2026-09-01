// The end-to-end check: load the real pages in Chromium with every outbound
// request blocked, draw payment codes through the pages' own code, read the
// pixels back off the canvas and decode them.
//
// This is the one that would catch a page failing to parse, the canvas scaling
// going wrong, or a code silently needing the network — none of which the pure-JS
// suite can see.
//
// BOTH pages are checked, because both now draw money. The till draws the code at
// the counter; the ordering page draws one on the customer's own phone for them to
// scan from a second device. They share one encoder (/qr.js) and each has its own
// drawing path around it, and it is the drawing path that this suite is for.
//
// Served over a local HTTP server rather than opened from file://, because /qr.js
// is an absolute same-origin URL: under file:// it resolves to the root of the
// disk and the pages would be tested without the encoder they actually ship with.
// Everything not served from here is refused, so nothing leaves the machine.
//
// Run separately from `npm test` because it needs a browser: `npm run test:browser`.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const jsQR = require('jsqr').default || require('jsqr');
const { ROOT, suite } = require('./helpers');

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

// Firebase is stubbed so the pages run with no network and no credentials.
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
    signInAnonymously: () => Promise.resolve({ user: { uid: 'a' } }),
    signOut: () => Promise.resolve(),
    currentUser: null
  };
  const database = () => db;
  database.ServerValue = { TIMESTAMP: 0, increment: (n) => n };
  window.firebase = { initializeApp: () => ({}), apps: [], database, auth: () => auth };
})();
`;

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  // Some environments ship a prebuilt Chromium at a known path; CI installs its
  // own via `npx playwright install chromium`. Prefer the prebuilt one when it is
  // actually there rather than discovering its absence through a rejected launch.
  const PREBUILT = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(PREBUILT) ? { executablePath: PREBUILT } : {});
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await ctx.addInitScript(FIREBASE_STUB);
  const page = await ctx.newPage();

  // Everything outbound is blocked, so the pages run with no network beyond this
  // server. What the fix here claims is narrower than "the page makes no requests"
  // (it still wants fonts and the Firebase SDK): it is that DRAWING A CODE makes
  // none. So requests are only recorded while a render is in flight.
  let recording = false;
  const hitsDuringRender = [];
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    if (recording) hitsDuringRender.push(url);
    return route.abort();
  });

  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  const { check, note, done } = suite('QR in the browser — the real pages, network blocked');

  // ============================================================ the till
  await page.goto(base + '/pos.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  check('pos.html parses and has the encoder',
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
    check('till, ₹' + amount + ' — the canvas decodes to the exact payment string',
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

  // ====================================================== the customer's phone
  // The same properties, asked of the page a customer actually pays from. The code
  // there is drawn by showPayStep, which takes the VPA and the amount as arguments
  // — so what is checked is that the code carries exactly the payment the screen
  // beside it claims, which is the only thing that makes it safe to scan.
  await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  check('index.html parses and has the same encoder',
        await page.evaluate(() => typeof window.ilaQR === 'object' && typeof window.ilaQR.drawToCanvas === 'function'),
        pageErrors.length ? 'page errors: ' + pageErrors.slice(0, 2).join(' | ') : '');

  recording = true;
  for (const [vpa, amount] of [['ilacafe@okhdfcbank', 250], ['ila.cafe.blr@okaxis', 1250.5], ['q629471833@ybl', 40]]) {
    const shot = await page.evaluate(([v, a]) => {
      window.showPayStep(v, a);
      const c = document.getElementById('cust-qr');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      return { w: c.width, h: c.height, data: Array.from(d.data),
               shown: document.getElementById('pay-step-pay').style.display,
               // textContent, not innerText: the dialog is closed, and innerText on an
               // element that is not being rendered reads back empty.
               id: document.getElementById('cust-upi-id').textContent,
               amt: document.getElementById('cust-upi-amount').textContent };
    }, [vpa, amount]);
    const out = jsQR(new Uint8ClampedArray(shot.data), shot.w, shot.h);
    const want = `upi://pay?pa=${vpa}&pn=ILA&am=${amount}&cu=INR`;
    check('customer, ₹' + amount + ' — the canvas decodes to the exact payment string',
          !!out && out.data === want,
          out ? 'got ' + JSON.stringify(out.data) : 'no code found in ' + shot.w + '×' + shot.h);
    // The manual route beside the code has to be the same payment, or a customer
    // reading it off the screen pays a different café a different amount.
    check('and the UPI ID and amount printed beside it are the same payment',
          shot.shown === 'block' && shot.id === vpa && shot.amt === String(amount),
          JSON.stringify({ shown: shot.shown, id: shot.id, amt: shot.amt }));
  }
  await page.waitForTimeout(150);
  recording = false;
  check('the customer page drew its codes with no network request either',
        hitsDuringRender.length === 0, hitsDuringRender.slice(0, 3).join(', '));

  // An order with nothing to pay must not put a code on screen at all: a ₹0 or
  // VPA-less code is one that either scans to nothing or scans to the wrong payee.
  const refused = await page.evaluate(() => {
    window.showPayStep('ilacafe@okhdfcbank', 250);
    const before = document.getElementById('pay-step-pay').style.display;
    window.showPayStep(null, 250);
    const noVpa = document.getElementById('pay-step-pay').style.display;
    window.showPayStep('ilacafe@okhdfcbank', 0);
    const noAmt = document.getElementById('pay-step-pay').style.display;
    return { before, noVpa, noAmt };
  });
  check('no VPA and no amount both refuse to draw anything',
        refused.before === 'block' && refused.noVpa === 'none' && refused.noAmt === 'none',
        JSON.stringify(refused));

  // Same reason as the till's clearQR: a paid order's code must not survive as a
  // bitmap on a hidden canvas.
  const custCleared = await page.evaluate(() => {
    window.showPayStep('ilacafe@okhdfcbank', 250);
    const c = document.getElementById('cust-qr');
    window.hidePayStep();
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let anyInk = false;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] !== 0) { anyInk = true; break; }
    return { hidden: document.getElementById('pay-step-pay').style.display === 'none', anyInk };
  });
  check('hidePayStep hides the step', custCleared.hidden);
  check('hidePayStep wipes the bitmap', custCleared.anyInk === false);

  // Nothing on the customer's screen may try to open a UPI app on the phone it is
  // running on: from a web page that is an NPCI Intent, which dies after the PIN.
  // The code is for another device's camera, and the ID is for typing.
  const noIntent = await page.evaluate(() => {
    window.showPayStep('ilacafe@okhdfcbank', 250);
    const step = document.getElementById('pay-step-pay');
    return [...step.querySelectorAll('a[href], [onclick]')]
              .map(el => (el.getAttribute('href') || '') + ' ' + (el.getAttribute('onclick') || ''))
              .filter(s => /upi:\/\//.test(s));
  });
  check('the pay step offers no upi:// for this phone to open',
        noIntent.length === 0, noIntent.join(', '));

  if (pageErrors.length) note('page errors seen: ' + pageErrors.slice(0, 3).join(' | '));

  done();
  await browser.close();
  server.close();
})().catch((e) => { server.close(); console.error(e); process.exit(1); });
