// Café Ila — service worker
// 1) PUSH NOTIFICATIONS (unchanged — subscriptions depend on this file staying at /sw.js)
// 2) APP-SHELL CACHING (new): instant opens + offline shell, self-updating.
//    Strategy: serve cached instantly, revalidate in background, apply on NEXT open.
//    Never caches Firebase data (RTDB / auth / push worker) — those stay live.

// Bumped to v2 so the activate handler below drops the old cache outright. Skipping
// the manifest from here on does nothing for a device that already has one stored;
// the stale entry has to go, and renaming the cache is what takes it.
const CACHE = 'ila-shell-v2';

// THE THIRD OPEN WAS THE FIRST FAST ONE
//
// The cache used to be filled only by the fetch handler, which sounds self-evidently
// fine and is not, because of WHEN the worker starts seeing requests.
//
//   open 1  Nothing is controlling the page. Every file comes off the network, and
//           the worker — registered at the foot of the page — installs and claims
//           AFTER all of them have already been and gone. It never saw one of them,
//           so it cached nothing.
//   open 2  Now it is controlling, so it sees them. Every one is a MISS. Each falls
//           through to `await network`, i.e. the full download again, with the page
//           blank until it lands. Only on the way back does it fill the cache.
//   open 3  Hits. Instant, and instant from here on.
//
// So every app took three opens to become fast, and the second one — the one that
// looks like it ought to be quick, on a device that has plainly been here before —
// was a cold download start to finish. Measured on café wifi at 1.6Mbps: pos.html
// pulled its whole 357KB on open 1 AND on open 2, and 0 bytes on open 3.
//
// That is the "why is it sometimes slow?" nobody could pin down, because it is not
// intermittent at all — it is the second open, every time, on every page, and it
// comes back whenever the cache is lost. Which for the customer page is EVERY NEW
// CUSTOMER, and on iOS is any device that has not opened the app for a week.
//
// Two things fix it, and both are about filling the cache before the fetch handler
// would have.

// The files every page loads, which is most of what an open costs after the HTML.
// Fetched during install — while open 1 is still being read — so open 2 has them.
//
// Deliberately NOT the seven HTML pages. That is about a megabyte, most of it for
// roles this device will never open, downloaded in competition with the page the
// person is actually looking at. The page they ARE looking at is handled below,
// which gets the same result for the one page that matters without the other six.
const PRECACHE = ['/auth-gate.js', '/pin-mask.js', '/build-check.js',
                  '/dialogs.js', '/connection.js', '/qr.js', '/logo.png'];

// AND THE SDK, WHICH IS THE BIGGEST THING ANY OF THESE PAGES DOWNLOADS
//
// Three bundles, the better part of 400KB, on every page. They were left out of the
// list above when it was written because that list is about OUR files, and off-origin
// felt like somebody else's problem. It is not: on café wifi at 1.6Mbps this is about
// two seconds, and every page's own script is BELOW these tags and cannot run until
// all three have arrived and been compiled. So for those two seconds the app is not
// slow, it is absent — an empty shell with nothing on it.
//
// Left out, they took the same three opens the HTML used to: not seen on open 1
// (nothing is controlling the page), a full miss and a full download on open 2, and
// only cached in time for open 3. Fixing that for our own files and not for the four
// hundred kilobytes next to them fixed the smaller half of the problem.
//
// Pinned to a version and already treated as immutable below, so there is nothing to
// go stale here — the URL changes when the file does. Kept in step with the pages by
// a test, because a version bumped in seven HTML files and not here is a precache
// that quietly warms nothing.
// WARMED WHEN THE PAGE SAYS IT HAS FINISHED, NOT DURING INSTALL
//
// Fetching these alongside the small files above is the obvious thing and it is wrong.
// Install runs WHILE open 1 is still downloading the very same three bundles, so the
// worker would be racing the download it is trying to save — and a device that lost
// that race pulls 800KB instead of 400KB, making the first open, already the worst
// one, worse.
//
// Reasoned rather than measured, and worth being honest about which: the probe that
// would settle it answers gstatic through Playwright's route.fulfill(), and a fulfilled
// response is never stored in the browser's HTTP cache, so every fetch counts and reuse
// cannot be seen at all. What IS measured is the thing this exists for — the second
// open of every page goes from three requests to none.
//
// So the worker waits to be told. build-check.js sends PRECACHE_SDK on load — it is on
// all seven pages and is already the file that reasons about the shell cache. By then
// the page's own copies are in the browser's HTTP cache, which gstatic marks immutable
// for a year, so this should cost nothing; and if it ever does cost something, it is
// after the page is up rather than in front of it.
const SDK_BASE = 'https://www.gstatic.com/firebasejs/12.17.1/';
const PRECACHE_SDK = [SDK_BASE + 'firebase-app-compat.js',
                      SDK_BASE + 'firebase-database-compat.js',
                      SDK_BASE + 'firebase-auth-compat.js'];

let sdkWarmed = false;
self.addEventListener('message', (event) => {
  const d = event.data;
  if (!d || d.type !== 'PRECACHE_SDK') return;
  if (sdkWarmed) return;                                  // once per worker
  sdkWarmed = true;
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      await Promise.all(PRECACHE_SDK.map(async (u) => {
        try {
          if (await cache.match(u)) return;               // already held
          // CORS with credentials omitted, which is what crossorigin="anonymous" on the
          // page's own tags asks on. This has to match, and not for tidiness: a no-cors
          // fetch yields an OPAQUE response, and serving one of those back to a tag
          // carrying an integrity hash fails the check — SRI cannot verify a body it is
          // not allowed to read — so the page would end up with no SDK at all.
          //
          // Default cache mode, so the copy the page has just downloaded is reused
          // rather than fetched again. These are pinned to a version; there is no
          // freshness to chase.
          const res = await fetch(new Request(u, { mode: 'cors', credentials: 'omit' }));
          if (res && res.ok) await cache.put(u, res);
        } catch (e) {}
      }));
    } catch (e) {}
  })());
});

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      // One at a time, each swallowing its own failure. cache.addAll() is atomic:
      // a single 404 rejects the whole thing and the worker never installs, which
      // would trade a slow second open for no caching at all.
      await Promise.all(PRECACHE.map(async (u) => {
        try {
          const res = await fetch(u, { cache: 'no-cache', credentials: 'same-origin' });
          if (res && res.ok) await cache.put(u, res);
        } catch (e) {}
      }));
    } catch (e) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    // And the page that installed us. It is the one page this device demonstrably
    // opens, it went out to the network before we were controlling, and so it is the
    // one thing the precache above cannot know the name of. Reading it off the
    // claimed clients is how the worker finds out which of the seven this device
    // actually uses — the till caches the till, the kitchen caches the kitchen, and
    // neither pays for the other.
    try {
      const cache = await caches.open(CACHE);
      const windows = await self.clients.matchAll({ type: 'window' });
      await Promise.all(windows.map(async (c) => {
        try {
          const url = new URL(c.url);
          if (url.origin !== self.location.origin) return;
          const key = docKey(url);
          if (await cache.match(key)) return;                  // already held
          const res = await fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' });
          if (res && res.ok) await cache.put(key, res);
        } catch (e) {}
      }));
    } catch (e) {}
  })());
});

// ONE ENTRY PER PAGE, NOT ONE PER TABLE
//
// The cache keys on the whole URL, query string included, and the customer page is
// only ever opened WITH one: the table QR codes are ila.cafe/?table=3, ?table=7, and
// so on round the room. So every table was a separate entry that had to be filled by
// its own slow open, and a customer moving from one table to another got a cold page
// on a phone that had the identical bytes cached under the next table's number.
//
// The document is the same file whichever table asked for it — the number is read by
// the page at runtime, not served differently — so navigations are stored and looked
// up under the path alone. Only navigations: a query string on anything else may
// well pick the file, and this must not be the reason two of them collide.
function docKey(url) { return url.origin + url.pathname; }

// ---------------- push (unchanged) ----------------
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { title: 'Café Ila', body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'Café Ila';
  const options = {
    body: data.body || '',
    icon: '/icon.png',
    badge: '/icon.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    requireInteraction: !!data.requireInteraction,
    data: { url: data.url || '/admin.html' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/admin.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if (c.url.indexOf(url) !== -1 && 'focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

// ---------------- caching (new) ----------------
// Cache ONLY: our own files (HTML, logo, icons) + fonts + the Firebase SDK scripts +
// Chart.js, which analytics draws with.
// Exact-hostname allowlist. Everything else (RTDB, auth, ila-push worker) passes straight through.
//
// jsdelivr was the last host on any page that was NOT here, so the charting library
// was the one part of the app shell that came off the network however many times the
// page had been opened. Adding a host does not disturb what is already held: the
// cache keeps its name, nothing is re-fetched, and the new host simply starts being
// stored the first time it is asked for.
const CACHEABLE_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com',
                         'cdn.jsdelivr.net'];

// Of those, the ones whose URL can only ever answer with one file.
//
// A font file at fonts.gstatic.com is named after its own contents; a Firebase SDK
// under /firebasejs/12.17.1/ and Chart.js at /npm/chart.js@4.5.1 are pinned to a
// version the pages also carry an SRI hash for — nothing at any of those URLs can
// change without the URL changing too. Serving
// them from the cache and ALSO fetching them to see whether they moved is six
// requests per page open, every open, that can only ever return what is already
// held. On a kitchen tablet on café wifi that is the slowest part of the open, and
// it is spent confirming that immutable files are still immutable.
//
// So these are served from cache and left alone. Everything else keeps
// stale-while-revalidate: our own HTML changes on every deploy, and the Google Fonts
// stylesheet varies by browser and is rewritten by Google from time to time.
//
// If one of these ever does need re-fetching — a cache entry truncated by a disk
// eviction — changing CACHE above re-fetches every one of them on the next open.
// SRI covers the SDKs and Chart.js in the meantime: a short body is rejected by the
// browser rather than run.
function isImmutable(url) {
  return url.hostname === 'fonts.gstatic.com' ||
         (url.hostname === 'www.gstatic.com' && url.pathname.indexOf('/firebasejs/') === 0) ||
         // Chart.js, on the same terms as the SDK above: analytics loads it from a URL
         // that names its version, and carries an SRI hash for that exact build. It was
         // the one off-origin file the shell cache did not hold, so the charts were the
         // only part of that page that needed the network a second time.
         //
         // The version pin is the whole condition, and it is checked rather than
         // assumed. jsdelivr will serve /npm/chart.js unpinned, and that URL means
         // "whatever is newest" — cache-first on it would freeze a device on one build
         // forever, which is the opposite of what this is for.
         (url.hostname === 'cdn.jsdelivr.net' && /@\d/.test(url.pathname));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                      // never touch writes
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  const sameOrigin = url.origin === self.location.origin;
  // build.json is how an open page notices a newer build exists. Serving it from
  // this cache would answer with the build the page already has, forever, and the
  // update banner would never appear — a mechanism that looks wired up and cannot
  // possibly fire. Always go to the network for it.
  if (sameOrigin && url.pathname === '/build.json') return;
  // AND THE MANIFEST, for the same reason and a worse consequence.
  //
  // The manifest is what an install reads to decide how the app opens — display,
  // theme_color, background_color. Served from this cache it answers with the
  // manifest the device saw the FIRST time, so a change to any of them never
  // reaches an already-installed device. Reinstalling does not help, which is what
  // makes it so hard to spot: the fix looks applied, the app looks unchanged, and
  // there is nothing on screen connecting the two. Reported from the floor exactly
  // that way — home bar still white after a reinstall.
  if (sameOrigin && url.pathname === '/manifest.webmanifest') return;
  if (!sameOrigin && CACHEABLE_HOSTS.indexOf(url.hostname) === -1) return;  // Firebase etc: untouched
  // Navigations to our own pages are held under the path alone — see docKey above.
  const key = (sameOrigin && req.mode === 'navigate') ? docKey(url) : req;
  event.respondWith(swr(event, req, key, sameOrigin, isImmutable(url)));
});

async function swr(event, req, key, sameOrigin, immutable) {
  try {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key);
    if (cached && immutable) return cached;             // nothing at this URL can have changed
    // background revalidate; 'no-cache' on our own files so a deploy is picked up
    // immediately (bypasses GitHub Pages' 10-min HTTP cache) — served on next open.
    const network = (sameOrigin
      ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      : fetch(req)
    ).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(key, res.clone());
      return res;
    }).catch(() => null);

    if (cached) {
      event.waitUntil(network.catch(() => {}));          // refresh quietly for next open
      return cached;                                      // instant
    }
    const res = await network;
    if (res) return res;
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  } catch (e) {
    try { return await fetch(req); } catch (_) {
      return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  }
}

/* ---------------- KILL-SWITCH (keep for reference) ----------------
If caching ever misbehaves, replace this whole file with ONLY the lines below,
deploy, and every device returns to plain no-cache behavior on its next two opens:

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.registration.unregister();
    const cs = await self.clients.matchAll({ type: 'window' });
    cs.forEach(c => c.navigate(c.url));
  })());
});
-------------------------------------------------------------------- */
