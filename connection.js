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

    // ---------------------------------------------------------------- refused reads
    //
    // A REFUSED READ IS NOT AN EMPTY ONE, AND NOTHING WAS SAYING SO
    //
    // db.ref(p).on('value', cb) takes a third argument, the cancel callback, and it is
    // the only way a page hears that a read was refused. Without one the callback
    // simply never fires: the variable it would have filled keeps whatever it was
    // initialised to — {} or 0 — and the page renders that, with nothing on screen to
    // suggest anything went wrong.
    //
    // That is not hypothetical. Three nodes were added to the rules and merged without
    // deploying them, so every read of them was refused, and analytics showed ₹0 for
    // eighteen months of trading and a cash-up list with no closings in it. From a
    // browser, a node nobody has heard of, a node nobody is allowed to read, and a
    // node that is legitimately empty are the same event.
    //
    // So every listener now passes one of these two, and which one is a judgement
    // about the read rather than a default:
    //
    //     ilaRefused('menu')        the screen is about this — say so on screen
    //     ilaRefused.quiet('eta/model')   enrichment with a working default — log only
    //
    // The bar is deliberately not the offline bar's words or its urgency. An outage
    // fixes itself and this does not: it means a rule is wrong or missing, it will
    // still be true in an hour, and somebody has to go and look.
    var refused = {}, refusedQuiet = {}, refusedBar = null;

    function refusedShow() {
        var names = Object.keys(refused);
        if (!names.length) return;
        if (!refusedBar) {
            refusedBar = document.createElement('div');
            refusedBar.id = 'ila-refused-bar';
            refusedBar.setAttribute('role', 'status');
            refusedBar.style.cssText = [
                'position:fixed',
                // Below the offline bar rather than on top of it: both can be true at
                // once, and the connection is the one to read first.
                'left:0', 'right:0',
                'z-index:' + (Z - 1),
                'background:var(--brand-text,#ffffff)',
                'color:var(--brand-bg,#8D6E52)',
                'font-family:Quicksand,sans-serif',
                'font-size:0.8rem',
                'font-weight:700',
                'text-transform:uppercase',
                'letter-spacing:1px',
                'text-align:center',
                'padding:10px 12px',
                'pointer-events:none'
            ].join(';');
            (document.body || document.documentElement).appendChild(refusedBar);
        }
        // Recomputed every time rather than fixed when the bar was built: the offline
        // bar can arrive after this one, and a stale offset would stack them.
        var above = document.getElementById('ila-offline-bar');
        refusedBar.style.top = 'calc(env(safe-area-inset-top) + ' +
            (above ? above.offsetHeight + 'px' : '0px') + ')';
        // Named, because "something failed" sends somebody hunting and a path does not.
        refusedBar.textContent = names.length === 1
            ? 'Could not load ' + names[0] + ' — this screen is incomplete'
            : 'Could not load ' + names.length + ' things — this screen is incomplete';
        refusedBar.title = names.join(', ');
    }

    function record(label, err, loud) {
        var name = String(label || '');
        if (!name) {
            // Firebase names the path in its own message; use it when there is no
            // label rather than saying nothing useful.
            var m = /permission_denied at (\S+?):/i.exec(String((err && err.message) || ''));
            name = m ? m[1].replace(/^\//, '') : 'part of this screen';
        }
        try {
            console.error('[ila] read refused: ' + name + ' — ' +
                          String((err && err.message) || err || ''));
        } catch (e) {}
        if (!loud) { refusedQuiet[name] = 1; return; }
        refused[name] = 1;
        if (document.body) refusedShow();
        else document.addEventListener('DOMContentLoaded', refusedShow);
    }

    // Returns a cancel callback, so a call site reads
    //     db.ref('menu').on('value', cb, ilaRefused('menu'))
    window.ilaRefused = function (label) {
        return function (err) { record(label, err, true); };
    };
    // Enrichment the page has a working default for. Recorded and logged, no bar:
    // a wait-time estimate that falls back to its default is not worth alarming a
    // cashier mid-service over, and a bar nobody needs is a bar everybody learns
    // to ignore.
    window.ilaRefused.quiet = function (label) {
        return function (err) { record(label, err, false); };
    };
    // For tests and for anyone debugging a screen that says it is incomplete.
    window.ilaRefused.seen = function () { return Object.keys(refused); };
    // The quiet ones are recorded too. Not showing a bar is a decision about what is
    // worth interrupting somebody for, not a reason to lose the fact — and "no bar"
    // and "the callback never fired" are otherwise the same thing to look at.
    window.ilaRefused.seenQuiet = function () { return Object.keys(refusedQuiet); };

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

    // ------------------------------------------------------- the error nobody saw
    //
    // A REFUSED READ HAS SOMEWHERE TO GO. AN UNCAUGHT ERROR HAD NOWHERE.
    //
    // The Worker is the component nobody watches, so it is the one that is watched:
    // ops/cronFailure records a throw, ops/pushHealth records whether a notification
    // landed, ops/cronHeartbeat records that a scheduled job ran at all, and a GitHub
    // workflow reads the last of those from outside. That is the right amount of
    // instrumentation for something invisible.
    //
    // The tills had none of it, and they are where the money is. Across the seven
    // pages there are 113 `catch (e) {}` and a score of console.error, on devices with
    // no console open, in a café. Every fault found here so far was found by somebody
    // noticing something odd at the counter, or by reading the source afterwards.
    //
    // The sharpest case is the one that cost real money: the ordering page wrote an
    // order, the database refused it for being one field too long, and the rejection
    // was attached to nothing. That is an `unhandledrejection` — the browser knew, and
    // there was nothing listening. A customer paid for an order that did not exist.
    //
    // WHAT THIS IS NOT. It is not a log. A log grows, and this node must not: the key
    // is a signature — page, message, and where it came from — so the hundredth
    // occurrence of one fault overwrites the first and bumps a count. The node is as
    // long as the number of DISTINCT things going wrong, which is a number that should
    // be nearly zero and is worth looking at when it is not.
    //
    // WHO MAY WRITE, AND HOW THE CUSTOMER PAGE DOES.
    //
    // Staff write this node directly, and the rules say so rather than this file: a
    // till is authorised by having an entry under users/{uid}, which an anonymous
    // session does not have. Every customer on the ordering page is anonymous, so for
    // a long time that page ran this reporter and reported nothing — the deliberate
    // gap, because letting it write would mean a node anybody at all can write to on
    // the database that holds the café's takings.
    //
    // It was also the worst possible place to have a gap. The ordering page is the one
    // screen a customer touches, it is where the fault that cost real money happened,
    // and it is the one screen with nobody standing over the device to see anything go
    // wrong. So the customer's browser asks the Worker instead, and the Worker writes
    // the row as the robot — the same shape as the cash-out and the stock log.
    //
    // The rules are unchanged by that and still refuse an anonymous write, which is
    // the point: the trust lives in handleClientError, where the key is computed from
    // the text rather than sent, the page is not the caller's to claim, and a report
    // that would ADD a row is refused once the node is long. Nothing here is trusted
    // by anything there.
    var ERR_MAX_PER_LOAD = 8;         // a loop that throws must not become a loop that writes
    var ERR_REPEAT_GAP_MS = 60000;    // the same signature, at most once a minute
    var errSent = 0, errLast = {}, errBusy = false;

    // The same Worker the tills use for a cash-out. The URL is a literal in five pages
    // already and is public by construction — it is a route, not a credential, and
    // every one of its routes authorises the caller for itself.
    var ERR_WORKER_URL = 'https://ila-push.sraveen-chirania.workers.dev/';
    var ERR_WORKER_TIMEOUT_MS = 8000;

    // keepalive, because a page that has just thrown is a page somebody is about to
    // close, and a report that dies with the tab is the gap this closes reopening
    // itself. Every failure is swallowed: there is nowhere else to put this, and an
    // error reporter that can raise an error is a loop.
    function reportViaWorker(u, page, kind, msg, src, build) {
        try {
            u.getIdToken().then(function (tok) {
                var ctl = null;
                try {
                    ctl = new AbortController();
                    setTimeout(function () { try { ctl.abort(); } catch (e) {} }, ERR_WORKER_TIMEOUT_MS);
                } catch (e) { ctl = null; }
                return fetch(ERR_WORKER_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'client-error', token: tok,
                        page: page, kind: kind, message: msg, source: src, build: build
                    }),
                    signal: ctl ? ctl.signal : undefined,
                    keepalive: true
                });
            }).catch(function () { });
        } catch (e) { /* deliberately nothing */ }
    }

    function errPage() {
        var p = (location.pathname || '').replace(/^\/+/, '');
        return (p || 'index.html').replace(/[.#$\[\]\/]/g, '_');
    }
    // Firebase keys cannot hold . # $ [ ] /, and a signature has to be short and stable
    // rather than readable — the readable version is a field inside the record.
    function errKey(sig) {
        var h = 0;
        for (var i = 0; i < sig.length; i++) { h = ((h << 5) - h + sig.charCodeAt(i)) | 0; }
        return errPage() + '-' + (h >>> 0).toString(36);
    }

    // Never throws, never reports itself, and never reports twice for the same thing in
    // the same minute. Anything that goes wrong in here is swallowed on purpose: an
    // error reporter that can raise an error is a loop.
    function report(kind, message, where) {
        if (errBusy) return;                       // re-entrancy: our own failure is not news
        try {
            if (errSent >= ERR_MAX_PER_LOAD) return;
            var msg = String(message == null ? '' : message).slice(0, 300);
            if (!msg) return;
            var src = String(where || '').slice(0, 200);
            var sig = errPage() + '|' + kind + '|' + msg + '|' + src;
            var now = Date.now();
            if (errLast[sig] && (now - errLast[sig]) < ERR_REPEAT_GAP_MS) return;
            errLast[sig] = now;

            if (!(window.firebase && firebase.apps && firebase.apps.length && firebase.database)) return;
            var u = null;
            try { u = firebase.auth && firebase.auth().currentUser; } catch (e) { return; }
            // Nobody is signed in yet — not even anonymously — so there is no identity
            // to write with and nothing that would accept the write.
            if (!u) return;

            errSent++;
            errBusy = true;
            var build = String(window.ILA_BUILD || 'unknown').slice(0, 40);

            if (u.isAnonymous) {
                // The ordering page. The rules refuse this write and should; the Worker
                // makes it on the customer's behalf, having trusted none of it.
                reportViaWorker(u, errPage(), kind, msg, src, build);
            } else {
                var ref = firebase.database().ref('ops/clientErrors/' + errKey(sig));
                ref.update({
                    page: errPage(),
                    kind: kind,
                    message: msg,
                    source: src,
                    build: build,
                    lastAt: firebase.database.ServerValue.TIMESTAMP,
                    count: firebase.database.ServerValue.increment(1)
                }).catch(function () { /* refused or offline: there is nowhere else to put this */ });
                // firstAt is written only if the row is new, so the age of a fault survives
                // every later occurrence overwriting the rest of the record.
                ref.child('firstAt').transaction(function (cur) {
                    return cur === null ? Date.now() : undefined;
                }, function () {}, false);
            }
        } catch (e) {
            // deliberately nothing
        }
        errBusy = false;
    }

    // Exposed so a page can report something it caught itself and cannot otherwise
    // surface — and so the suite can drive it without throwing inside a test.
    window.ilaOops = function (message, where) { report('caught', message, where); };

    window.addEventListener('error', function (ev) {
        // Two different events share this name. A resource that failed to load has a
        // target and no message, and says nothing a person can act on; an uncaught
        // exception has a message and a place.
        if (!ev || !ev.message) return;
        report('error', ev.message, (ev.filename || '') + (ev.lineno ? ':' + ev.lineno : ''));
    });
    window.addEventListener('unhandledrejection', function (ev) {
        var r = ev && ev.reason;
        var msg = (r && (r.message || r.code)) || String(r == null ? 'rejected' : r);
        // A Firebase refusal names its own path, which is the most useful half of it.
        report('rejection', msg, (r && r.stack ? String(r.stack).split('\n')[1] || '' : '').trim());
    });

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
