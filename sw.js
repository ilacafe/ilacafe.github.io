// Café Ila — service worker
// 1) PUSH NOTIFICATIONS (unchanged — subscriptions depend on this file staying at /sw.js)
// 2) APP-SHELL CACHING (new): instant opens + offline shell, self-updating.
//    Strategy: serve cached instantly, revalidate in background, apply on NEXT open.
//    Never caches Firebase data (RTDB / auth / push worker) — those stay live.

// Bumped to v2 so the activate handler below drops the old cache outright. Skipping
// the manifest from here on does nothing for a device that already has one stored;
// the stale entry has to go, and renaming the cache is what takes it.
const CACHE = 'ila-shell-v2';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

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
// Cache ONLY: our own files (HTML, logo, icons) + fonts + the Firebase SDK scripts.
// Exact-hostname allowlist. Everything else (RTDB, auth, ila-push worker) passes straight through.
const CACHEABLE_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com'];

// Of those, the ones whose URL can only ever answer with one file.
//
// A font file at fonts.gstatic.com is named after its own contents, and a Firebase
// SDK under /firebasejs/12.17.1/ is pinned to a version the pages also carry an SRI
// hash for — nothing at either URL can change without the URL changing too. Serving
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
// SRI covers the SDKs in the meantime: a short body is rejected by the browser
// rather than run.
function isImmutable(url) {
  return url.hostname === 'fonts.gstatic.com' ||
         (url.hostname === 'www.gstatic.com' && url.pathname.indexOf('/firebasejs/') === 0);
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
  event.respondWith(swr(event, req, sameOrigin, isImmutable(url)));
});

async function swr(event, req, sameOrigin, immutable) {
  try {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    if (cached && immutable) return cached;             // nothing at this URL can have changed
    // background revalidate; 'no-cache' on our own files so a deploy is picked up
    // immediately (bypasses GitHub Pages' 10-min HTTP cache) — served on next open.
    const network = (sameOrigin
      ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      : fetch(req)
    ).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
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
