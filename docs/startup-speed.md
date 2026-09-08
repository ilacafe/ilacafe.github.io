# Startup speed — what is left to win

Every page here has already had the obvious pass done to it, and the notes in each
`<head>` say so at length: the SDK is out of the head and preloaded, the Google Fonts
stylesheet no longer holds the paint, both off-origin hosts are preconnected, and the
service worker serves the shell. `npm run perf boot` agrees — every page's own cost to
first paint is in line with the baseline in `tools/perf/README.md`, and nothing in this
document is about making a page draw faster.

What is left is not paint. It is the four things that happen around it: a page that
loads itself twice, three pages that pull down data before anything asks for it, and two
blind spots in the probes that have been hiding the first of those.

Measurements below were taken on `2026-09-08.1` with `npm run perf`, at `CPU=4` and
`DAYS_OPEN=550 BILLS_DAY=100 CUSTOMERS=4000`, the same scale as the baseline. Where a
number is a before-and-after it was taken by making the change, running the probe, and
putting the file back — not by estimating.

---

## 1. index.html loads itself twice on a first visit

The worst one, on the page that can least afford it: the customer's, opened from a table
QR code by somebody who has never been to the site, on café wifi.

`index.html` is the only page carrying this, at the foot of its inline script:

```js
navigator.serviceWorker.addEventListener('controllerchange', function(){
    if (_swReloaded) return; _swReloaded = true;   // guard: never loop
    location.reload();
});
```

The guard stops it looping. It does not stop it firing when it should not. `sw.js` calls
`self.clients.claim()` in its activate handler, and on a device that has never been here
there is no controller yet — so the first visit installs the worker, the worker claims
the page, `controllerchange` fires for the first time, and the page throws itself away
and starts over. The handler is meant for the case where a *new* worker replaces an old
one. It cannot tell that case from the first one.

Measured, with the service worker allowed and the café-wifi profile the `wifi` probe
uses (1.6Mbps, 300ms latency, 4× CPU, 600ms database round trip):

| page | main-frame navigations on a first visit | usable |
|---|---|---|
| index.html | **2** | 2579ms |
| index.html, with the worker blocked | 1 | 2229ms |
| pos.html | 1 | 3283ms |

`pos.html` is the control: it registers the same worker and has no such handler, and it
navigates once. The ~350ms is the small half of the cost — the page is discarded partway
through, so the database round trip for the menu is paid twice, and what the customer
sees is the page appearing, blanking, and appearing again.

**The fix.** Only reload when there was a controller to replace. Read it once, at
registration time, before the worker can claim anything:

```js
var hadController = !!navigator.serviceWorker.controller;
navigator.serviceWorker.addEventListener('controllerchange', function(){
    if (!hadController) return;        // first visit: nothing was replaced
    if (_swReloaded) return; _swReloaded = true;
    location.reload();
});
```

The update path is unaffected: a device that already has a worker still has a controller,
so a genuine replacement still reloads.

---

## 2. admin reads every customer it has ever had, to draw two numbers and ten rows

`admin.html:1393`:

```js
db.ref('customers').on('value', s => renderRepeat(s.val() || {}), window.ilaRefused("customers"));
```

`renderRepeat` uses the node to produce a count, a percentage, and `repeat.slice(0, 10)`.
The node itself is unbounded — `pos.html` writes `customers/<phone>` on every accepted web
order, so it gains an entry per new phone number and never loses one.

Measured on `admin.html`'s cold open at 4,000 customers:

| | payload |
|---|---|
| today | 0.45 MB, of which `customers` is **254 KB** |
| with that one listener removed | **0.20 MB** |

More than half of what the admin screen pulls on every open, to render twelve pieces of
information. It is also an `.on('value')`, so the whole node is re-delivered to every open
admin screen on every write the till makes during service, and both costs grow with the
customer list for as long as the café keeps trading.

This is the same shape as the finding that `payload` was built for — the 5.2MB of
cash-ups read to render a list made of about 10KB of them — and it has the same fix,
which this codebase has already built once. `orders/daily` holds one small rollup per
closed day and turned a 14.35MB read into 1.83MB. A `customers/stats` record maintained
on the write side, holding the two counts and the current top ten, takes this read from
254 KB to well under a kilobyte and stops it growing.

If a rollup is more than is wanted for now, `limitToLast` cannot help here — the top ten
is by order count, not by key — but moving the listener behind the panel (see the next
item) at least stops every admin open paying for it.

---

## 3. admin loads 900 records for a card nobody has scrolled to

`loadETAAccuracy()` runs from `init()` and opens three reads: `orders/track`
limited to 400, and `orders/completed/chef` and `.../barista` limited to 250 each. They
feed the Kitchen Accuracy card, which sits well below the fold.

| | payload |
|---|---|
| admin today | 0.45 MB |
| without the `customers` read | 0.20 MB |
| without `customers` *and* Kitchen Accuracy | **0.13 MB** |

Together the two changes take admin's cold open down by 71%.

The pattern to copy is on the same page, twenty lines above the card in question. The
archived-verification panel is a `<details>` whose body reads `Open to load…` and which
fetches when it is opened. Kitchen Accuracy is a diagnostic looked at when ETAs feel
wrong, not on every open, and it wants exactly that treatment.

Worth saying plainly: this does **not** make the page paint faster. `npm run perf boot`
puts `admin.html` at ~180ms script and ~225ms layout either way — first paint happens
before any listener has answered, which is the point the boot probe makes. What it saves
is bytes on café wifi, which is what the admin tablet is on.

---

## 4. analytics boots the Demand Map on a view nobody has opened

`analytics.html:955` calls `demandBoot()` from `init()`. The Demand Map is the *other*
tab — `view-analytics` is the one carrying `active` in the markup — so on every open of
the analytics page, before the owner has expressed any interest in it, `loadAll()` fetches
up to `maxPerStation: 6000` completed orders from each of the two stations.

Deferring it until `setView('demand')` is first called takes the cold open from 0.83 MB to
0.81 MB at today's scale. The byte saving is small and honestly not the reason to do it:
the reason is four database round trips removed from the open — 2.4s of them at the
600ms round trip the `wifi` profile assumes — and a cap of 6000 records per station that
the café will keep growing into.

---

## 5. analytics fetches today's orders it is already holding

Immediately after, in `demandBoot`:

```js
await loadAll();          // limitToLast(6000) per station
renderSurface(); renderModelPanel(); renderForecast(); renderPlanner();
await pollToday();        // limitToLast(400) per station, then .filter(r => r.ts >= t0)
```

`pollToday`'s 400 are a strict subset of the 6000 `loadAll` has just put in `records`, on
the same two paths — and it discards all but today's from them anyway. The first call can
read the array instead of the wire:

```js
todayRecs = records.filter(r => r.ts >= t0);
renderToday();
```

and leave `pollToday` to the `setInterval` and the `visibilitychange` handler, which is
where it is actually earning something. Two round trips, awaited on the critical path,
for data already in memory.

---

## 6. index.html blocks on the auth SDK its own comment calls lazy

`index.html:1123` says it outright:

> Anonymous auth is only needed to WRITE the order. Keep it lazy and crash-proof so a
> missing/slow auth library can never stop the menu (which reads public data) from
> rendering.

The `getAuth()` wrapper and the `ensureAuth()` promise are both built for that. But
`firebase-auth-compat.js` is a plain synchronous tag, so it is downloaded, parsed and
executed before a single line of page code runs, and line 1127 signs in anonymously on
the page's first pass. The menu is public data and needs none of it. A customer who
browses and leaves — most of them — pays for the whole library and never writes anything.

**This one has a test in the way, and the test is right about the other two files.**
`test/render-blocking.test.js` asserts that no `firebasejs` script carries `defer`,
because the inline script calls `firebase.initializeApp` on its first working line and a
deferred script runs after the parser has finished — after that line has already thrown.
That is true of `firebase-app-compat` and `firebase-database-compat`. It is not true of
`firebase-auth-compat`: nothing on the synchronous path touches `firebase.auth()` except
line 1127, which is wrapped in `try/catch` and described as deferred already.

So the change is three parts, and none of them is the one-line version:

1. `defer` on the auth tag only, keeping the preload (which already matches on
   `crossorigin` and `integrity`);
2. move the `signInAnonymously()` call into a `DOMContentLoaded` handler, so it runs when
   the library has actually landed;
3. narrow the guard in `render-blocking.test.js` from "no firebasejs script is deferred"
   to "no firebasejs script the inline code needs synchronously is deferred", and say in
   the note which of the three that is and why.

Patched that way locally, the other 39 suites stayed green. **The size of the win is not
measured**, and cannot be with the tooling as it stands — see item 8.

The same reasoning applies to `analytics.html`, `barista.html`, `chef.html` and
`inventory.html`, which each use `firebase.auth()` only inside an `onAuthStateChanged`
callback. It does not apply to `pos.html` or `admin.html` without reading their startup
paths properly first.

---

## 7. the service worker precaches nothing

`sw.js` installs with `self.skipWaiting()` and an empty cache, and fills it as pages ask
for things. So the shared shell — the three SDK bundles, `connection.js`, `dialogs.js`,
`build-check.js`, `auth-gate.js`, the fonts — is fetched fresh the first time each device
opens its first page, and a device that opens a second app (a manager going from `pos` to
`inventory`) fetches that page's HTML cold.

An install handler that warms the shared files is a small change and makes the *second*
app on a device open like the first one's repeat open. It is deliberately not a
suggestion to precache all seven HTML pages: that is about a megabyte, most of it for
roles the device will never use, and it would slow the install it is meant to help.

---

## 8. two blind spots in the probes, which is why items 1 and 6 were invisible

Both are in `tools/perf/probe.js`, and both are reasonable decisions with a consequence
worth writing down.

**Every probe aborts off-origin requests.**

```js
await tab.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
```

The stub is what the page gets, which is the whole point of the harness — but it means
the Firebase SDK, the largest thing a first visit downloads, is absent from every number
in the baseline. `index.html`'s recorded first visit of "FCP 532ms, usable 2125ms" is a
first visit that never fetched it. The real one is slower, and by an amount nothing here
reports. This is why item 6 has no number against it.

**The `wifi` probe blocks the service worker on the column named "first visit".**

```js
const ctxOpts = { serviceWorkers: warm ? 'allow' : 'block', ... };
```

A real first visit is precisely the one that registers the worker, and on `index.html`
that registration is what causes the reload in item 1. The probe's "first visit" column
is therefore measuring a page that never does the slowest thing a first visit does.

The cheap fix for the second is to allow the worker on both columns — the repeat open
already allows it, and the cache is per-context, so a cold context with the worker
allowed is exactly a first visit. A `navs` column (main-frame navigation count) alongside
FCP would have made item 1 self-evident: 2 against pos.html's 1.

The first is harder and probably wants its own probe rather than a change to these —
something that serves stub copies of the three SDK bundles at their real sizes instead of
aborting them, so that "what does a stranger's first visit cost" has an answer at all.

---

## What was checked and is fine

- **First paint, everywhere.** `boot` matches the baseline on all seven pages. Nothing
  here is paint-bound.
- **The till and the kitchen screens.** `pos.html` pulls 0.08 MB on a cold open,
  `chef.html` 0.01 MB, `barista.html` and `inventory.html` under that. These are the
  devices that live on café wifi all day and they are already the lightest.
- **Repeat opens.** 395ms for `index.html`, 397ms for `pos.html`, 189ms for
  `analytics.html`. This is the number that matters at the start of a shift and the
  service worker has it well in hand.
- **Font weights.** All three requested weights (400, 500, 700) are used. 500 is used
  only nine times across all seven pages, so dropping it would save one font file per
  device — real, but it is bandwidth after the paint, not startup.
- **`build-check.js`.** First poll is on a 30-second timer. It costs the open nothing.
- **Minification.** A third of each page is comments, and they are the reason this
  codebase can be read. There is no build step and adding one to save bytes that gzip
  already handles, on files the service worker serves from cache after the first open,
  would cost more than it returns.
- **Duplicate listeners on the same path.** `payload` reports `orders/active/chef ×2` on
  `chef.html` and similar elsewhere, because the stub tallies per `.on()` call. Firebase
  shares the sync for identical queries on the same path, so these are not two downloads.
  The `×2` on `orders/completed/chef` in `analytics.html` *is* real, because the two
  reads use different limits — that is item 5.

---

## In the order worth doing them

| | change | measured effect |
|---|---|---|
| 1 | guard the `controllerchange` reload in `index.html` | one page load saved on every customer's first visit |
| 2 | roll up `customers` for `admin.html` | admin cold open 0.45 MB → 0.20 MB, and stops it growing |
| 3 | defer Kitchen Accuracy behind its card | admin cold open → 0.13 MB with #2 |
| 4 | defer `demandBoot()` to the Demand Map tab | 4 round trips off the analytics open |
| 5 | build `todayRecs` from `records` in memory | 2 round trips off the analytics open |
| 6 | `defer` the auth SDK on `index.html`, and narrow the test | not measured — see item 8 |
| 7 | precache the shared shell on install | second app on a device opens warm |
| 8 | let the `wifi` probe see the service worker; count navigations | would have caught #1 |
