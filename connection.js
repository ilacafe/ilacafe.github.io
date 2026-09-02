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
    // So the first connection of a session gets a longer, quieter run-up. Nothing is
    // said while the socket is still being opened. If it is still not open after
    // this, then it genuinely is not opening, and that is worth saying.
    var BOOT_MS = 5000;

    // Except when the device already knows the answer. navigator.onLine is worthless
    // as proof that a connection WORKS — it stays true on a phone attached to a
    // router whose uplink is down — but it is conclusive the other way: false means
    // there is no network interface at all, so there is nothing to wait for and no
    // reason to make someone wait for it.
    var connectedOnce = false;
    function settleFor() {
        if (connectedOnce) return SETTLE_MS;
        if (navigator.onLine === false) return SETTLE_MS;
        return BOOT_MS;
    }

    // Below the notification area (3000) so a message can still be read over it, and
    // above the modals (2000), because being disconnected matters MORE while someone
    // is part-way through taking a payment, not less.
    var Z = 2600;

    var bar = null, timer = null;

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
        if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
        bar = null;
    }

    function onConnected(ok) {
        if (ok) { connectedOnce = true; hide(); return; }
        if (bar || timer) return;
        timer = setTimeout(function () { timer = null; show(); }, settleFor());
    }

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
