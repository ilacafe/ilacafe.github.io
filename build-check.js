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

    // A plain reload would be served the cached shell again. Drop the shell cache
    // first, so the reload actually fetches the build that is being offered.
    async function applyNewBuild() {
        try {
            const keys = await caches.keys();
            await Promise.all(keys.filter(k => k.indexOf('ila-shell') === 0).map(k => caches.delete(k)));
        } catch (e) {}
        location.reload();
    }

    setTimeout(checkForNewBuild, 30000);
    setInterval(checkForNewBuild, BUILD_POLL_MS);
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) checkForNewBuild();
    });
})();
