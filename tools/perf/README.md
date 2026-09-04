# Performance probes

Instruments, not tests. Nothing here asserts or fails a build — each probe reports
numbers, and the numbers only mean something next to the baseline below.

```
npm run perf payload     what each page pulls from the database on a cold open
npm run perf boot        first paint, script, layout and DOM size, per page
npm run perf wifi        café wifi: a first visit against a repeat open
npm run perf shift       a six-hour service on the till — does it grow?
npm run perf kds         a kitchen screen as the tickets pile up
```

Scale is the café's, not the probe's, because "is analytics slow?" has no answer and
"is analytics slow after eighteen months at a hundred bills a day?" does:

```
DAYS_OPEN=1100 BILLS_DAY=200 npm run perf payload
PAGES=pos.html,analytics.html CPU=6 npm run perf boot
```

`CPU` is a throttle multiplier — 4 is roughly a counter tablet against a laptop.

## Why these five

Each exists because it found something the others could not see.

**`payload`** found analytics reading 120 complete cash-ups — 5.2MB — to render a list
built from about 10KB of them. No amount of CPU profiling would have shown it: the cost
was entirely on the wire, and the page felt fine on a desk.

**`wifi`** found a localStorage key two pages disagreed about, by making one page's
repeat-open number look wrong enough to chase.

**`shift`** and **`kds`** have never found anything. That is the finding: the till does
not leak across a service, and the kitchen board holds 60fps at eighty tickets.

## Baseline

Taken on `2026-09-03.12`, at `CPU=4`, `DAYS_OPEN=550 BILLS_DAY=100 CUSTOMERS=4000`
(eighteen months of trading). A number well outside these wants explaining.

### payload — bytes per page, per cold open

| page | total | largest node |
|---|---|---|
| analytics.html | 0.83 MB | `orders/history` 740 KB (30-day range) |
| admin.html | 0.45 MB | `customers` 254 KB |
| pos.html | 0.08 MB | `pos/bills` 23 KB |
| chef.html | 0.01 MB | `orders/ready` 6 KB |
| index.html | 0.01 MB | `menu` 7 KB |
| barista.html, inventory.html | < 0.01 MB | |

The till at 80 KB and the kitchen at 10 KB are the ones to watch: those devices open on
café wifi all day. Analytics was 5.90 MB before `pos/eodSummary` existed.

**All Time**, measured with `RANGE=all npm run perf payload`:

| | cold open then All Time |
|---|---|
| before `orders/daily` existed | 14.35 MB |
| the first open after it shipped | 14.35 MB — the history is read once, to build the rollups |
| every open after that | **1.83 MB** |

`orders/daily` is 850 KB for 550 trading days against the 13.35 MB of orders behind it
— 16×.

The rollups carry a per-item order count as well now, which the item drill-down reads,
so a day's record is a little larger than the 721 KB and 19× first recorded here.

WHAT THIS FIXTURE HAS TO KEEP UP WITH. A rollup missing a field the page expects is one
the page REBUILDS, and a fixture whose rollups are of an older shape therefore measures
that rebuild rather than the steady state. This one did, for exactly one change: it
reported All Time at 15.05 MB with the whole order history read four times, which reads
as the optimisation having been undone. It had not — the fixture had gone stale. If a
run here suddenly shows `orders/history` being read whole, suspect this file before the
page. It holds one small record per closed day: the sums every figure on the page
except the transactions table is made of. Today has no rollup, because the day is not
over, so it is read raw and added to them.

The transactions table is the part a rollup cannot answer — "find the order with this
note in it" needs the orders. It shows the most recent 500 of the range, says so, and
offers to fetch the range in full for anyone who needs to search or export beyond it.
That deliberate read is the only thing left that pulls `orders/history` whole.

### boot — the page's own cost to first paint

| page | FCP | script | layout | nodes |
|---|---|---|---|---|
| index.html | 124ms | 54ms | 108ms | 758 |
| pos.html | 176ms | 141ms | 148ms | 886 |
| chef.html / barista.html | 96ms | ~88ms | ~30ms | 124 |
| admin.html | 164ms | 175ms | 272ms | 2009 |
| analytics.html | 244ms | 66ms | 86ms | 511 |
| inventory.html | 100ms | 17ms | 36ms | 57 |

### wifi — 1.6Mbps, 300ms latency, 600ms database round trip

| page | first visit | repeat open |
|---|---|---|
| pos.html | FCP 612ms, usable 3136ms | FCP 88ms, usable **359ms** |
| index.html | FCP 532ms, usable 2125ms | FCP 92ms, usable **337ms** |

The repeat open is the one that matters — it is what a device does at the start of every
shift — so it gets the service worker and each page's own cached menu, which is what it
would really have. The two pages cache under different keys in different shapes (see the
comment on `MENU_CACHE_KEY` in `index.html`), and seeding only the till's left the
ordering page cold on the open that is supposed to be warm.

### shift — six hours, 40 order cycles an hour

Heap 2.4 MB after boot, 2.1 MB at hour six, 1.7 MB after a forced collection. DOM nodes
flat at 881. Database listeners flat at 27. **Growth in any column is the finding.**

### kds — a kitchen screen filling up

| tickets | redraw | worst frame |
|---|---|---|
| 20 | 21.7ms | 17.6ms |
| 80 | 87.5ms | 18.7ms |

Eighty tickets is hours of backlog, not a rush. A worst frame near 16.7ms is 60fps
holding.

## Two things that make the numbers trustworthy

**The stub honours the query.** `limitToLast`, `orderByKey` and `startAt` are emulated
rather than ignored, because what a page *asks for* is the thing being measured. A stub
that returned whole nodes regardless would report every page as pulling the entire
database, and analytics' 5.2MB read would have been indistinguishable from admin's
correctly-capped ones.

**The fixture is the shape the app actually writes.** A bill is what `pos.html` pushes to
`pos/bills`; an order is the `archivePacket` it puts in `orders/history`. The first
version invented plausible-looking bills and came out 26% low, because real ones carry
per-item `base` and `mods` for add-ons. When a probe makes a page throw, the fixture is
wrong until proven otherwise — that is how `settings/upiList` was found to be an array.

**The timing probes use a smaller fixture, deliberately.** The stub inlines the fixture
in an init script, so the browser parses it before the page runs; with the full 18MB one
every page reported a first paint around 1200ms, all of it this file being parsed.
First paint happens before any listener has answered, so what a page costs to draw is a
question about the page — and what it then pulls down is `payload`'s question, where
bytes are the measurement and parse cost does not distort them.
