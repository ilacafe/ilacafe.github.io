// Café Ila — the "there is a newer build" watcher.
//
// A SCREEN THAT STAYS OPEN NEVER GETS THE FIX
//
// sw.js serves the cached shell and revalidates in the background, so a new build
// lands in the cache but is only applied on the NEXT open. A tablet propped up on
// the counter and a kitchen display that runs from open to close never have a next
// open, and a single reload serves the previous fetch — which is why fixing
// anything here used to mean walking round reloading every screen twice.
//
// This watches for a newer build and offers the reload. It never takes it: a till
// reloading itself mid-transaction, or a kitchen screen blanking while someone is
// reading a ticket, is a worse bug than the one this is fixing. The banner waits
// to be tapped.
//
// Loaded by every long-lived page:
//
//     <script src="/build-check.js" data-build="2026-08-26.1"></script>
//
// The build stays in the HTML rather than in here, because it is a property of the
// page as deployed and a shared file cannot know it. `npm test` fails if any page's
// data-build drifts from build.json.

(function () {
    'use strict';

    // Read off this script's own tag, before anything else can run and move it.
    var tag = document.currentScript;
    var MY_BUILD = tag ? tag.getAttribute('data-build') : null;

    // Pages show this at their foot, so a cached build is visible rather than guessed.
    window.ILA_BUILD = MY_BUILD;

    var BUILD_POLL_MS = 10 * 60 * 1000;

    // True only when both are real strings and they differ — a failed fetch, an HTML
    // error page or a missing field must never look like a new version, or the banner
    // cries wolf until nobody reads it.
    function buildIsNewer(mine, theirs) {
        return typeof mine === 'string' && mine.length > 0 &&
               typeof theirs === 'string' && theirs.length > 0 &&
               mine !== theirs;
    }

    async function checkForNewBuild() {
        try {
            const res = await fetch('/build.json', { cache: 'no-store' });
            if (!res.ok) return false;
            const v = await res.json();
            if (!buildIsNewer(MY_BUILD, v && v.build)) return false;
            showUpdateBanner(v.build);
            return true;
        } catch (e) { return false; }
    }

    // Built from DOM nodes rather than a string of HTML: the only text in it comes
    // from build.json, and textContent means there is no way for that to matter.
    function showUpdateBanner(latest) {
        if (document.getElementById('ila-update-banner')) return;

        var bar = document.createElement('div');
        bar.id = 'ila-update-banner';
        bar.setAttribute('role', 'status');
        // Above everything the pages define, the sign-in overlay included (99999).
        // A screen sitting at the sign-in prompt overnight is exactly the one you
        // want to pick up the new build, and a banner behind that overlay is
        // invisible and untappable.
        bar.style.cssText = 'position:fixed; left:0; right:0; bottom:0; z-index:2000000;' +
            'background:#1f6f3f; color:#fff; padding:14px 16px; font-weight:700;' +
            'display:flex; gap:12px; align-items:center; justify-content:center;' +
            'font-size:0.95rem; box-shadow:0 -2px 12px rgba(0,0,0,0.35);';

        var label = document.createElement('span');
        label.textContent = 'Update ready · ' + latest;

        var now = document.createElement('button');
        now.type = 'button';
        now.id = 'ila-update-now';
        now.textContent = 'Reload now';
        now.style.cssText = 'background:#fff; color:#1f6f3f; border:none; border-radius:6px;' +
            'padding:8px 14px; font-weight:700; cursor:pointer; font:inherit;';

        var later = document.createElement('button');
        later.type = 'button';
        later.id = 'ila-update-later';
        later.textContent = 'Later';
        later.setAttribute('aria-label', 'Dismiss until later');
        later.style.cssText = 'background:transparent; color:#fff; border:1px solid rgba(255,255,255,0.5);' +
            'border-radius:6px; padding:8px 12px; cursor:pointer; font:inherit;';

        bar.appendChild(label);
        bar.appendChild(now);
        bar.appendChild(later);
        document.body.appendChild(bar);

        document.getElementById('ila-update-later').onclick = function () { bar.remove(); };
        document.getElementById('ila-update-now').onclick = applyNewBuild;
    }

    // A plain reload would be served the cached shell again, so the new build has to be
    // fetched before the page reloads onto it.
    //
    // THIS USED TO EMPTY THE CACHE AND RELOAD INTO NOTHING
    //
    // Deleting every ila-shell entry did make the reload fetch the new build. It also
    // meant the reload began with an empty cache, so every file missed and the person
    // who tapped "update" watched the whole app come down again with a blank screen in
    // front of them — 357KB on the till, and the Firebase SDK on top of it, on café
    // wifi. On all seven apps, on every device, after every deploy.
    //
    // It was always this way and it did not matter much, because the cache used to be
    // nearly empty anyway. Once the cache became the thing that makes an app open
    // instantly, emptying it became the most expensive thing this file does.
    //
    // So the worker REPLACES the shell instead, and only then does the page reload —
    // onto a cache that is warm and entirely of the new build. Same guarantee, no gap.
    //
    // The wait is bounded, and the fallback is the old behaviour rather than nothing:
    // if there is no worker, or it does not answer, a person who tapped "update" must
    // still get the update. A slow reload is a bad outcome; not applying a fix somebody
    // asked for is a worse one.
    var REFRESH_WAIT_MS = 8000;

    function refreshShell() {
        return new Promise(function (resolve) {
            var sw = navigator.serviceWorker;
            if (!sw || !sw.controller) return resolve(false);
            var done = false;
            var finish = function (v) { if (!done) { done = true; resolve(v); } };
            try {
                var ch = new MessageChannel();
                ch.port1.onmessage = function () { finish(true); };
                sw.controller.postMessage({ type: 'REFRESH_SHELL', url: location.href }, [ch.port2]);
                setTimeout(function () { finish(false); }, REFRESH_WAIT_MS);
            } catch (e) { finish(false); }
        });
    }

    async function applyNewBuild() {
        var refreshed = false;
        try { refreshed = await refreshShell(); } catch (e) {}
        if (!refreshed) {
            // No worker, or it did not answer in time. Fall back to what this did
            // before: empty the shell so the reload cannot be served the old build.
            try {
                const keys = await caches.keys();
                await Promise.all(keys.filter(k => k.indexOf('ila-shell') === 0).map(k => caches.delete(k)));
            } catch (e) {}
        }
        location.reload();
    }

    setTimeout(checkForNewBuild, 30000);
    setInterval(checkForNewBuild, BUILD_POLL_MS);
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) checkForNewBuild();
    });

    // ---------------------------------------------------------------- warming the shell
    //
    // TELLING THE WORKER THE PAGE HAS FINISHED
    //
    // sw.js holds the Firebase SDK for us — three bundles, the better part of 400KB,
    // on every page, and the thing every page's own script sits below and waits for.
    // Left to the fetch handler it is not cached until the SECOND open, so the second
    // open pays for all of it again with nothing on screen; and the worker cannot
    // simply fetch it during install, because install runs while THIS open is still
    // downloading the same three files and would be racing the very download it is
    // trying to save.
    //
    // So it waits to be told, and this is the telling. On load, when the page's own
    // copies are in the browser's HTTP cache — gstatic marks them immutable for a
    // year — so the worker's fetch costs nothing and the next open has them.
    //
    // Here rather than in seven copies at the foot of seven pages, for the reason
    // auth-gate.js gives about itself: six copies of a rule is six chances to get
    // one of them wrong. This file is already the one that reasons about the shell
    // cache, and it is already on every page.
    function warmShell() {
        if (!('serviceWorker' in navigator)) return;
        try {
            navigator.serviceWorker.ready.then(function (reg) {
                var w = reg && reg.active;
                if (w) w.postMessage({ type: 'PRECACHE_SDK' });
            }).catch(function () {});
        } catch (e) {}
    }
    if (document.readyState === 'complete') warmShell();
    else window.addEventListener('load', warmShell);
})();
