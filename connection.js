// Café Ila — the "this screen is not talking to the server" bar.
//
// NOTHING ON ANY SCREEN SAID THE CONNECTION HAD GONE
//
// Every device in this café is on café wifi: two tills, two kitchen boards, the
// stock tablet, and the phone in a customer's hand at a table. Not one page had a
// line about losing that connection — no navigator.onLine, no listener, nothing.
// The failure is quiet by construction: the Firebase SDK keeps the last data it
// received on screen and holds new writes in memory, so a till goes on looking
// completely normal while nothing it does is reaching anybody. A cashier reads a
// stale bill. A kitchen board shows the tickets it had and none of the ones that
// have been sent since. Both look exactly like a quiet ten minutes.
//
// `.info/connected` is the database's own answer to this, and the one signal worth
// trusting here: navigator.onLine only knows whether the device has a network
// interface, which is true of a phone attached to a wifi router whose uplink is
// down — the exact shape of most café outages.
//
// Loaded by every page:
//
//     <script src="/connection.js"></script>
//
// It reads no page state and exports nothing. It waits for whichever page it is on
// to initialise Firebase, then watches, and puts a bar at the top when the answer
// has been "no" for long enough to mean it.

(function () {
    'use strict';

    // .info/connected is false for the first moment of every page load, while the
    // socket is still being opened, and it flickers false on any brief blip. Showing
    // the bar immediately would mean flashing it on every single open, which teaches
    // everyone to ignore it — the one thing an alert like this cannot survive.
    var SETTLE_MS = 2500;

    // A RESTART IS NOT AN OUTAGE.
    //
    // Those two cases are not the same thing and were being timed as if they were.
    // A connection that was working and stopped is a fault the moment it happens; a
    // connection that has not been established YET is just a page that opened a
    // second ago. Firebase reports both as `false`, so a till reopened on perfectly
    // good wifi got the same 2.5s clock as one whose router had died — and on a
    // slower connect it announced an outage that had already fixed itself before
    // anyone finished reading it.
    //
    // So the first connection of a session gets a quieter run-up. Nothing is said
    // while the socket is still being opened. How long that run-up should be is not
    // one number, because it is not one question — see the probe below.
    var BOOT_MS = 5000;      // the network answers; the socket alone is slow
    var BLIND_MS = 2500;     // nothing has answered yet, which is itself an answer

    // ASK, RATHER THAN WAIT.
    //
    // A run-up long enough to cover a slow connect is also long enough to be a stare
    // when the café's internet is simply out — five seconds of a till that will not
    // take an order, every morning of an outage. Shortening it just moves the cost:
    // any ceiling under a slow connect puts the false alarm back.
    //
    // The way out is to stop guessing. `/build.json` is the one path sw.js
    // deliberately does not intercept (it would break the update banner), so a fetch
    // of it is a real question put to the network rather than the cache answering on
    // its behalf. ANY reply — a 404 included — means there is a route out of here and
    // the socket is merely slow, so wait properly. A rejection means there is nothing
    // out there at all, and nobody should be made to wait for it.
    //
    // One request, on every page, shared: pages read the verdict off window.ilaNet
    // rather than each asking again.
    var reachable = null;                     // null = still asking
    var waiting = [];
    window.ilaNet = {
        reachable: null,
        onVerdict: function (cb) {
            if (reachable !== null) { try { cb(reachable); } catch (e) {} return; }
            waiting.push(cb);
        }
    };
    function verdict(ok) {
        if (reachable !== null) return;
        reachable = window.ilaNet.reachable = ok;
        var cbs = waiting; waiting = [];
        cbs.forEach(function (cb) { try { cb(ok); } catch (e) {} });
    }
    try {
        fetch('/build.json', { cache: 'no-store' })
            .then(function () { verdict(true); })
            .catch(function () { verdict(false); });
    } catch (e) { verdict(true); }            // no fetch here: wait it out, never call it offline

    // Below the notification area (3000) so a message can still be read over it, and
    // above the modals (2000), because being disconnected matters MORE while someone
    // is part-way through taking a payment, not less.
    var Z = 2600;

    // navigator.onLine is worthless as proof that a connection WORKS — it stays true on
    // a phone attached to a router whose uplink is down — but it is conclusive the
    // other way: false means no network interface at all, so there is nothing to wait
    // for and no reason to make anyone wait for it.
    var connectedOnce = false;
    function settleFor() {
        if (connectedOnce) return SETTLE_MS;
        if (navigator.onLine === false) return SETTLE_MS;
        if (reachable === true) return BOOT_MS;
        if (reachable === false) return 0;
        return BLIND_MS;
    }

    var bar = null, timer = null, downSince = 0;

    function show() {
        if (bar) return;
        bar = document.createElement('div');
        bar.id = 'ila-offline-bar';
        bar.setAttribute('role', 'status');          // announced by VoiceOver and TalkBack
        // The same treatment the cart bar already uses for something that must be read:
        // the brand inverted. It is not red — this is not an error anyone caused, and
        // the kitchen boards already spend red on a late ticket.
        bar.style.cssText = [
            'position:fixed',
            'top:env(safe-area-inset-top)',
            'left:0', 'right:0',
            'z-index:' + Z,
            'background:var(--brand-text,#ffffff)',
            'color:var(--brand-bg,#8D6E52)',
            'font-family:Quicksand,sans-serif',
            'font-size:0.8rem',
            'font-weight:700',
            'text-transform:uppercase',
            'letter-spacing:1px',
            'text-align:center',
            'padding:10px 12px',
            'pointer-events:none'                    // never in the way of a tap
        ].join(';');
        // Says both halves, because they are different losses: the till is not sending
        // and the board is not receiving, and each screen only cares about one of them.
        bar.textContent = 'No connection · nothing is sending or arriving';
        document.body.appendChild(bar);
    }

    function hide() {
        if (timer) { clearTimeout(timer); timer = null; }
        downSince = 0;
        if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
        bar = null;
    }

    // Armed against when the connection actually went, not against now, so a verdict
    // arriving part-way through does not hand back the time already served.
    function arm() {
        if (timer) { clearTimeout(timer); timer = null; }
        var left = settleFor() - (Date.now() - downSince);
        timer = setTimeout(function () { timer = null; show(); }, left > 0 ? left : 0);
    }

    function onConnected(ok) {
        if (ok) { connectedOnce = true; downSince = 0; hide(); return; }
        if (bar) return;
        if (!downSince) downSince = Date.now();
        arm();
    }

    // The answer changes how long is worth waiting, so a wait already running is
    // recalculated rather than left on the number it was started with.
    window.ilaNet.onVerdict(function () { if (downSince && !bar) arm(); });

    // The pages initialise Firebase in their own inline script, which runs after this
    // file. Waiting for that rather than assuming it keeps this independent of where
    // the tag sits — and if a page never initialises one, this quietly does nothing
    // instead of throwing on every screen that loads it.
    var waited = 0;
    var poll = setInterval(function () {
        waited += 100;
        try {
            if (window.firebase && firebase.apps && firebase.apps.length && firebase.database) {
                clearInterval(poll);
                firebase.database().ref('.info/connected').on('value', function (snap) {
                    onConnected(snap.val() === true);
                });
                return;
            }
        } catch (e) { clearInterval(poll); return; }
        if (waited >= 20000) clearInterval(poll);     // no database on this page; stop looking
    }, 100);
})();
