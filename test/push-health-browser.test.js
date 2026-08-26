// Whether the café's alerts are reaching a phone, as admin.html reports it.
//
// This cannot be a notification, for the obvious reason, so it is a line on the
// page — and the line has to be worth reading. "4 of 9" on its own does not say
// whether the other five are being dealt with: a subscription the push service
// calls gone is deleted as it is found and stops mattering, while one failing for
// any other reason is retried on every alert forever.
//
// The numbers here are the ones the café actually reported the first time this
// ran: nine registered devices, four reached.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { ROOT, suite } = require('./helpers');

const { check, note, done } = suite('Push health — is anyone getting the alerts');

const FIVE_HOURS_AGO = Date.now() - 5 * 3600e3;

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

function stub(health) {
  return `
    window.__h = ${JSON.stringify(health)};
    const noop = () => {};
    const ref = (p) => ({
      once: () => Promise.resolve({ val: () => (p === 'ops/pushHealth' ? window.__h : null) }),
      on: noop, set: () => Promise.resolve(), update: () => Promise.resolve(),
      remove: () => Promise.resolve(), push: () => ref(p), child: () => ref(p),
      orderByChild: () => ref(p), orderByKey: () => ref(p), limitToLast: () => ref(p),
      startAt: () => ref(p), endAt: () => ref(p), equalTo: () => ref(p),
      transaction: () => Promise.resolve({}),
    });
    const db = { ref, goOnline: noop, goOffline: noop };
    window.firebase = { initializeApp: noop, apps: [{}],
      database: Object.assign(() => db, { ServerValue: { TIMESTAMP: 0 } }),
      auth: () => ({ onAuthStateChanged: (cb) => { try { cb(null); } catch (e) {} },
                     signOut: () => Promise.resolve(), currentUser: null }),
      messaging: () => ({ getToken: () => Promise.resolve(null), onMessage: noop }) };
  `;
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch(
    fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});

  const look = async (health) => {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message || e).split('\n')[0]));
    await page.addInitScript(stub(health));
    await page.route('**/*', (route) =>
      route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base + '/admin.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    const out = await page.evaluate(() => {
      const el = document.getElementById('notif-health');
      return { text: el.textContent.trim(), amber: !!el.style.color };
    });
    await ctx.close();
    return { ...out, errors };
  };

  try {
    const none = await look(null);
    check('before anything has been sent it says so',
          /nothing to report/.test(none.text), none.text);

    // Nine registered, four reached — the café's first real reading.
    const pruned = await look({ lastAttemptAt: FIVE_HOURS_AGO, lastDeliveredAt: FIVE_HOURS_AGO,
                                devices: 9, delivered: 4, expired: 5, failed: 0,
                                consecutiveUndelivered: 0 });
    check('it says how many were reached, of how many, and when',
          /4 of 9/.test(pruned.text) && /5 hours ago/.test(pruned.text), pruned.text);
    check('and that the ones the push service called gone were removed',
          /removed/.test(pruned.text) && /5 had been/.test(pruned.text), pruned.text);
    check('which is not a warning, because it fixes itself',
          !pruned.amber, 'it went amber for a state that resolves on its own');
    note('those five are deleted as they are found, so the count falls by itself');

    const stuck = await look({ lastAttemptAt: FIVE_HOURS_AGO, lastDeliveredAt: FIVE_HOURS_AGO,
                               devices: 9, delivered: 4, expired: 0, failed: 5,
                               consecutiveUndelivered: 0 });
    check('the same four-of-nine for another reason reads differently',
          /still being retried/.test(stuck.text), stuck.text);
    check('and that one is a warning', stuck.amber,
          'a device failing for a reason that is not "gone" is retried on every alert, forever');
    note('same numbers, opposite meaning — which is why the breakdown is shown');

    const dead = await look({ lastAttemptAt: Date.now(), lastDeliveredAt: FIVE_HOURS_AGO,
                              devices: 2, delivered: 0, expired: 2, failed: 0,
                              consecutiveUndelivered: 9 });
    check('nothing landing at all is a warning that names the next step',
          dead.amber && /No alert has reached a device/.test(dead.text) &&
          /Enable alerts on this device/.test(dead.text), dead.text);

    const allErrors = [none, pruned, stuck, dead].flatMap(r => r.errors);
    check('none of these threw', allErrors.length === 0, allErrors.join(' | '));
  } finally {
    await browser.close();
    server.close();
  }

  done();
})().catch((e) => { server.close(); console.error(e); process.exit(1); });
