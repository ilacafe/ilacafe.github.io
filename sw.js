// Café Ila — service worker
// 1) PUSH NOTIFICATIONS (unchanged — subscriptions depend on this file staying at /sw.js)
// 2) APP-SHELL CACHING (new): instant opens + offline shell, self-updating.
//    Strategy: serve cached instantly, revalidate in background, apply on NEXT open.
//    Never caches Firebase data (RTDB / auth / push worker) — those stay live.

const CACHE = 'ila-shell-v1';

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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                      // never touch writes
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && CACHEABLE_HOSTS.indexOf(url.hostname) === -1) return;  // Firebase etc: untouched
  event.respondWith(swr(event, req, sameOrigin));
});

async function swr(event, req, sameOrigin) {
  try {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
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
