# Startup speed — what is left to win

Every page here has already had the obvious pass done to it, and the notes in each
`<head>` say so at length: the SDK is out of the head and preloaded, the Google Fonts
stylesheet no longer holds the paint, both off-origin hosts are preconnected, and the
service worker serves the shell. `npm run perf boot` agrees — every page's own cost to
first paint is in line with the baseline in `tools/perf/README.md`, and nothing in this
document is about making a page draw faster.

What is left is not paint. It is what happens around it: a shell cache that did not
start working until a page's third open, a page that loaded itself twice, three pages
that pull down data before anything asks for it, and two blind spots in the probes that
were hiding the first two.

The first three are fixed — items 1, 7 and 7b, which together are what "sometimes it
opens instantly, other times a white screen and then the app" actually was. The rest is
still on the table.

Measurements below were taken on `2026-09-08.1` with `npm run perf`, at `CPU=4` and
`DAYS_OPEN=550 BILLS_DAY=100 CUSTOMERS=4000`, the same scale as the baseline. Where a
number is a before-and-after it was taken by making the change, running the probe, and
putting the file back — not by estimating.

---

## 1. index.html loads itself twice on a first visit — FIXED

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

## 2. admin read every customer it has ever had, to draw two numbers and ten rows — FIXED

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
which this codebase had already built once. `orders/daily` holds one small rollup per
closed day and turned a 14.35MB read into 1.83MB.

`customers/_stats` now holds the two counts and the current top ten — about a kilobyte,
whatever the café's history. The underscore is load-bearing: it lives *inside*
`customers/` so it inherits that node's rules rather than needing its own, and a key
that is not ten digits can never collide with a phone number. Everything that walks the
node steps over it on exactly that test.

Two pieces of code now produce that record, which is the risk in it:

- `rollupCustomers()` in `admin.html` builds one from the whole node. That read still
  exists, but it happens **once ever** — the first admin open that finds no rollup
  publishes one, the `pos/eodSummaryBackfill` arrangement. Bumping `CUST_STATS_V` asks
  for it again.
- `bumpCustomerStats()` in `pos.html` folds one accepted order into the rollup that is
  already there, inside a transaction. It reads the customer back rather than assuming,
  because `increment()` is a sentinel the server resolves and the count *after* the
  write is the only thing that says whether this phone is new (`total` goes up) or has
  just come back (`repeat` goes up). With no rollup present it **aborts** rather than
  writing a partial one — admin trusts any record carrying the current version, so a
  half-built one written by the till would never be rebuilt and the panel would count
  from the wrong place for ever.

They are in different files and neither says the other exists, so
`test/customer-rollup.test.js` replays orders through the till's updater and checks the
result against a rebuild from the node those same orders produced. Verified by mutation:
dropping the new-customer count, appending to the top ten instead of updating the row,
and letting the till start its own rollup each make it fail.

---

## 3. admin loaded 900 records for a card nobody has scrolled to — FIXED

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

Done by moving the card's body behind a `<details>`, the same fold the two archive
panels above it already use, loading on first open with a guard — these are value
listeners, `toggle` fires on close as well as open, and a second call would attach a
second set and double-count every ticket.

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

## 7. the service worker precached nothing, and the second open paid for it — FIXED

**This was filed here as a minor cross-page nicety and it was the main event.** It is
what "sometimes it opens instantly, other times a white screen and then the app" was.
The answer is that it was never intermittent: it was the *second* open of any page,
every time, on every app.

The cache used to be filled only by the fetch handler, which is fine until you ask when
the worker starts seeing requests:

| | what happened | navigation pulled |
|---|---|---|
| open 1 | nothing controls the page; every file goes to the network and the worker — registered at the foot of the page — installs *after* they have all been and gone, having seen none of them | `pos.html` 357 KB |
| open 2 | it controls now, so it sees them, and every one is a **miss**; each falls through to `await network`, blank until it lands, and only then fills the cache | `pos.html` **357 KB again** |
| open 3 | hits | 0 |

Measured by inspecting the cache directly: after open 1, `caches` held `ila-shell-v2: []`.
It is empty. Nobody found this by testing, because by the third open everything is fast
and stays fast — and it comes back whenever the cache is lost, which for the customer
page is **every new customer**, and on iOS is any device that has not opened the app for
a week.

Fixed in `sw.js`, in two parts:

- an install handler that fetches the seven shared files (`auth-gate.js`, `pin-mask.js`,
  `build-check.js`, `dialogs.js`, `connection.js`, `qr.js`, `logo.png`) while open 1 is
  still being read, each swallowing its own failure — `cache.addAll()` is atomic and one
  404 would mean the worker never installs at all;
- an activate handler that, after claiming, caches **the page that installed it**, read
  off `clients.matchAll()`. That is the one page this device demonstrably opens and the
  one thing a static precache list cannot know the name of. The till caches the till,
  the kitchen caches the kitchen, and neither pays for the other.

Deliberately *not* precaching all seven HTML pages: that is about a megabyte, most of it
for roles the device will never open, downloaded in competition with the page the person
is actually looking at.

| page | second open, before | after |
|---|---|---|
| pos.html | 357 KB | **0** |
| admin.html | 163 KB | **0** |
| chef.html | 53 KB | **0** |
| inventory.html | 50 KB | **0** |

## 7b. every table QR code was its own cache entry — FIXED

Found while fixing the above. The cache keys on the whole URL including the query
string, and the customer page is only ever opened *with* one — the table QR codes are
`ila.cafe/?table=3`, `?table=7`, and so on round the room. So every table was a separate
entry that had to be filled by its own slow open, and a customer moving tables got a cold
page on a phone holding the identical bytes under another number.

The document is the same file whichever table asked for it — the number is read by the
page at runtime, not served differently — so navigations are now stored and looked up
under the path alone (`docKey`). Only navigations: a query string on anything else may
well pick the file. Measured: table 7 pulled 158 KB after table 3 had been opened, and
now pulls 0.

---

## 7c. the SDK — the biggest file of all — was still taking three opens — FIXED

Found by going back to the "white screen in all apps" complaint after items 1, 2, 3, 7
and 7b were in, and it is the largest of them.

The precache in item 7 lists **same-origin files only**. The three Firebase bundles —
the better part of 400KB, on every page — were not in it, so they kept the exact
behaviour item 7 was written to fix: not seen on open 1 (nothing is controlling the
page), a full miss and a full download on open 2, cached in time for open 3.

Measured with gstatic answered locally, `pos.html` opened three times on one device:

| open | requests that reached the network | held in the cache |
|---|---|---|
| 1 | 3 | none |
| 2 | **3 again** | all three |
| 3 | 0 | all three |

This is the biggest single thing behind the complaint, because **every page's own script
sits below those three tags and cannot run until all of them have arrived and been
compiled**. For that time the app is not slow, it is absent — the shell paints and
nothing is on it. Fixing the HTML and the small shared files but not the 400KB next to
them fixed the smaller half.

**Not fetched during install, which is the obvious version and is wrong.** Install runs
while open 1 is still downloading those same three files, so the worker would be racing
the download it is trying to save, and a device that lost that race pulls 800KB instead
of 400KB — making the first open, already the worst, worse. So the worker waits to be
told: `build-check.js` (on all seven pages, and the file that already reasons about the
shell cache) posts `PRECACHE_SDK` on `load`. By then the page's own copies are in the
browser's HTTP cache, which gstatic marks immutable for a year, so the fetch should cost
nothing — and if it ever does cost something, it is after the page is up rather than in
front of it.

`test/shell-cache.test.js` checks the worker's URL list against the ones the pages
actually load, in both directions. A version bumped in seven HTML files and not in
`sw.js` breaks nothing, throws nothing, and reads as fixed — the worker would warm three
files no page asks for and every page would go back to being slow on its second open.
Verified by drifting the version: it fails both ways.

**What is measured here and what is not.** Open 2 going from three requests to zero is
measured. Whether the warm fetch on open 1 is free is *not*, and cannot be with this
harness: Playwright's `route.fulfill()` responses are never stored in the browser's HTTP
cache, so every fetch through a fulfilled route counts and reuse is invisible. Checked
directly — the same immutable URL fetched twice hits the route handler twice. Serving
the stub over real HTTP would fix that, but `route.continue({url})` requires the same
protocol and the local server is not HTTPS. The design avoids the cost by construction
rather than by measurement, which is worth saying plainly rather than leaving as a
number nobody can reproduce.

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

## Done

The first three were what the floor was complaining about. Items 2 and 3 followed.

| | change | measured effect |
|---|---|---|
| 7 | precache the shared shell on install, and cache the installing client's own page | second open of every app: full download → **0 bytes** |
| 7b | key navigations on the path, not the query string | a new table QR: 158 KB → **0** |
| 7c | warm the 400 KB Firebase SDK on `load`, not on install | second open of every app: 3 requests → **0** |
| 1 | guard the `controllerchange` reload in `index.html` | a customer's first visit: 2 page loads → **1** |
| 2 | roll up `customers` into `customers/_stats` | admin cold open 0.45 MB → 0.20 MB, and it no longer grows |
| 3 | defer Kitchen Accuracy behind its card | admin cold open → **0.13 MB** with #2, a 71% cut |

`test/second-open-browser.test.js` guards all three, and was checked against the old code
first: it fails six ways there, naming the exact byte count each page pulled on its
second open. None of this was visible to the existing suites, and none of it is readable
off the source — `sw.js` can be inspected all day and it will not say *when* the worker
starts seeing requests.

## Still worth doing

| | change | measured effect |
|---|---|---|
| 4 | defer `demandBoot()` to the Demand Map tab | 4 round trips off the analytics open |
| 5 | build `todayRecs` from `records` in memory | 2 round trips off the analytics open |
| 6 | `defer` the auth SDK on `index.html`, and narrow the test | not measured — see item 8 |
| 8 | let the `wifi` probe see the service worker; count navigations | would have caught #1 |

### A correction, since it was written down here

An earlier version of this file said admin's ~1.2 second gap between the shell painting
and the numbers appearing "is the 0.45 MB". That was wrong, and wrong in a way worth
keeping rather than quietly deleting, because the measurement that produced it is one
this file recommends taking.

The gap was measured on `dataset.lite()`, and **`lite()` drops the `customers` node
altogether** — so the number could never have contained the read it was being blamed on.
What it actually measures is two round trips in series: `users/<uid>` for the role, then
the listeners behind it, at 600ms each. Payload was not in it at all, before or after,
and fixing item 2 did not move it: 1199/1303/1158ms before, 1199/1303/1158ms after.

Isolating the read properly needs a fixture that *has* customers in it. The page picks
its path on one difference — a rollup at `customers/_stats` or none — so the same build
measures both:

| `customers/_stats` | what it reads | panel fills | off the wire |
|---|---|---|---|
| absent (the old path) | the whole node | 3259ms | 254 KB |
| present | `customers/_stats` | **2585ms** | **1 KB** |

At 12,000 customers the old path is 762 KB and 3330ms; the rollup is still 1 KB and
2587ms. **That flatness is the point** — more than the 670ms, which is what today's
four thousand customers happen to cost.
