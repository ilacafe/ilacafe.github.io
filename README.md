# ilacafe.github.io

Café Ila runs on this repo: customer ordering, the till, the kitchen screens,
stock and admin. Static pages served by GitHub Pages at **ila.cafe**, backed by
a Firebase Realtime Database.

There is no build step. **A push to `main` is the deploy** — the file in git is
the file the counter loads.

## The pages

| Page | Who uses it | What it does |
|---|---|---|
| `index.html` | customers | menu, cart, web orders, order tracking |
| `pos.html` | cashiers | the till: tables, split bills, cash and UPI, tips, cash-up |
| `barista.html` | bar | kitchen display for drinks |
| `chef.html` | kitchen | kitchen display for food |
| `inventory.html` | staff (PIN) | prep logs, deliveries, stock |
| `admin.html` | owner | menu, prices, staff, accounts, refunds, UPI routing |
| `analytics.html` | owner | sales history, demand model, cash-up archive, Worker health |
| `sw.js` | — | push notifications, and caches the app shell |
| `build-check.js` | — | tells a screen that has been open all day that a newer build exists |

Each page is self-contained: its own HTML, CSS and JavaScript in one file, with
Firebase loaded from a CDN. Sign-in is Firebase Auth; the role in
`users/{uid}.role` decides which pages an account can use.

## How it fits together

Three moving parts, and the boundaries between them are where the surprises live.

```
  customer phone            staff tablets                 kitchen screens
  index.html                pos.html / admin.html         chef.html / barista.html
        |                          |                              |
        +--------------+-----------+--------------+---------------+
                       |                          |
             Firebase Realtime Database    ila-push (Cloudflare Worker)
             the only security boundary    the only code not in a browser
                       |                          |
                       +------------+-------------+
                                    |
                              robot@cafeila.app
                        writes eta/model, payments/incoming
```

**Every page is a browser.** There is no server of ours between a till and the
database. Every PIN prompt, role check and confirmation dialog is advice to a
cooperating browser — anyone who opens devtools can skip all of it. The database
rules are the only thing that actually stops a read or a write, which is why
[`database.rules.json`](database.rules.json) matters more than any page does.

**One component is not a browser.** The Cloudflare Worker in [`worker/`](worker/)
holds the `robot@cafeila.app` credential and is the only thing that can refit the
ETA model or record a bank credit. It is also the only place a secret can live.

**Three things deploy separately**, and forgetting this is the most common way to
be confused by this repo:

| what | how | when |
|---|---|---|
| the pages | push to `main` | immediately, via GitHub Pages |
| the database rules | the **deploy database rules** workflow, by hand | never on a push |
| the Worker | push to `main` touching `worker/` | via GitHub Actions |

## Running it

Open the files. There is nothing to compile and no dev server needed — though a
static server avoids `file://` quirks:

```sh
npx serve .
```

Everything talks to the live database, so treat the till pages as live.

## Tests

```sh
npm install
npm test              # syntax, settlement, pricing, QR, rules, Worker
npm run test:browser  # loads the real pages in Chromium (needs a browser download)
npm run test:rules    # runs database.rules.json in the Firebase emulator (needs Java)
npm run access-map    # prints every database path each app reads and writes
npm run bump          # moves every page and build.json to a new build
```

The suites read the real functions out of the pages rather than a copy, so they
cannot pass against code that no longer ships. They cover the parts where a bug
costs money:

- **syntax** — every page parses. With no build step, a syntax error otherwise
  reaches a till and the page silently never starts.
- **settlement** — paying a table cannot erase an order added at the same
  moment, and the archive matches what the server holds.
- **pricing** — a web order is priced from the menu, never from the numbers the
  customer's browser sent.
- **QR** — the payment code is checked against a reference encoder, decoded back
  by an independent decoder, and rendered on a real page with the network off.
- **rules** — see below.
- **Worker** — no secret is ever a literal in `worker/worker.js` (the repo is
  served raw, so that file is public), the recalibration route is not gated by
  the secret the public pages carry, and an unset binding fails closed.
- **analytics** — the page fetches the date range it is showing rather than every
  bill ever recorded, and no read pulls an append-only node whole.
- **third-party** — every external script names an exact version, comes from a
  known origin, and is actually used by the page that loads it. CI additionally
  fetches each one and verifies its SHA-384 against the live file.
- **table cache** — a till reloaded during a wifi drop restores the open tables
  rather than showing an empty floor, and refuses a cache old enough to be
  yesterday's.
- **build freshness** — every screen staff leave open carries the build it was
  deployed as, and that stamp matches `build.json`. The browser suite goes further
  and loads each of those pages with a newer build.json in place: the banner has to
  appear, name the new build, and be tappable rather than sitting underneath the
  sign-in overlay.
- **manifest** — the ordering page is installable and its share card points at an
  image that exists, at the size it claims. Both fail silently in a browser.
- **accessibility** — on the customer page, everything clickable is reachable from
  a keyboard, every field has a name, and the wait estimate announces itself.
- **kitchen alarm** — the overdue threshold still adds saturation and oven time
  when the live model does not carry those curves. `etaInterp` reads a missing
  curve as zero, so the alarm would come in short and start calling on-time
  tickets late, silently.
- **web-order payments** — the till knows which bank credits are already spoken
  for. `payments/claims` is keyed by the bank's own reference, which is not a
  clock, so a `limitToLast` on it is a limit on keys: after a few hundred credits
  the visible set stops containing today's, a claimed credit reads as free, and a
  pending web order is shown "✓ paid" against money the counter has already taken.
  The claim state is watched per credit in the window instead, and the suite drives
  the real feed against a stub that sorts the way Firebase does.
- **kitchen DONE** — one tap on a ticket is one ticket, however many times the
  button is pressed. The card only fades once the read behind it comes back, so on
  a slow connection it is still tappable — and a second tap used to ring the
  counter again and count the station done twice. On a split order that second
  count tells the customer their food is ready while the bar has not started the
  drinks. Both kitchen pages carry the same code, so both are checked.
- **refunds and voids** — the two ways money goes back out are each one atomic
  write. Flagging the record, reversing the till and writing the compensating
  ledger line used to be three awaits in a row, so any one of them could be the
  last to land: a refund recorded but never taken off the UPI total, or taken off
  and still listed as owed, or a bill reading VOIDED with the till untouched and no
  button left to finish it. Each said "Nothing was changed — try again", and doing
  as it asked made the second copy.
- **unpaid web orders** — a prepaid order that is not paid reaches someone. There
  are two ways one sits unpaid — the pay link never went out, or it went out and
  nothing came back — and the POS had an alert for each. Only the first fired: the
  second waited on `orders/track/{id}/needsManualVerify`, which nothing in this repo
  has ever written, while the first skipped every order whose link *had* gone out on
  the grounds that the second covered it. A customer sent a link who never paid
  produced no alert at all, for as long as the order existed.
- **rules, in the emulator** — `database.rules.json` is loaded into a real database
  and asked what each *role* may read and write. The offline suite can only read the
  file, and `tools/probe-rules.js` asks the live database with no credentials, so it
  can only ever ask what a stranger can read, after a deploy. This asks the question
  the other two cannot, on every pull request. Half of it is derived from the access
  map — every path an app uses must be permitted to the app that uses it, which is
  what makes tightening a rule safe: a locked-out till fails here rather than at the
  counter. The other half is written by hand, because a list derived from the rules
  would agree with them by construction and check nothing. It also walks everything
  `admin.html` and `analytics.html` show and fails if any other role can reach it —
  those two pages check the role in a browser the holder controls, which is advice
  until the rules say the same thing.
- **cash-up** — the day's archive lands before the till is cleared, and the till is
  cleared before the report is handed off to WhatsApp. That hand-off is a real
  navigation, and it takes the socket — and any un-acked write still on it — with
  it. The reset is one atomic update rather than four writes, because a till that
  comes back half-reset carries yesterday's UPI total into today's takings. A write
  that never answers ends the cash-up with a message rather than a frozen screen.
- **write-only paths** — across the pages and the Worker, every database path
  something writes is read back somewhere, and every path something reads is
  written by something. A screen that will always be empty is harder to spot than
  a record nobody can see, because an empty list looks like a quiet day.
  Two features had been recording faithfully for as long as they existed and were
  readable from nowhere: the prep and delivery log, and the record of bills written
  off unpaid. The write worked in both; nobody had closed the loop.

CI runs these on every pull request and on `main`.

## Database rules

The rules are the only real security boundary: every check inside a page is
advice to a cooperating browser. They live in
[`database.rules.json`](database.rules.json) and `npm test` checks them — see
[`docs/database-access.md`](docs/database-access.md) for what it can and cannot
verify.

Rules cascade downwards and cannot be revoked lower down: a `.read` on a parent
grants read to everything beneath it, whatever the children say. So the public
read sits on the exact nodes a customer needs and nowhere above them. The same cascade
is why `pos` no longer carries a blanket `.read`: it handed the ledger, the bills,
the drawer and the cash-up archive to every signed-in role, including the bar and
the kitchen, which read none of them. `npm test`
holds that list — `menu`, `settings`, `eta/model`, `eta/live`, `orders/track` —
and fails on anything added to it or removed from it.

The two nodes an anonymous visitor can *write* — `orders/pendingWeb` and
`orders/track` — carry a shape: every field named and typed, strings bounded, cart
lines that must be cart lines, and a `createdAt` that has to be the server's own
clock. Checked on creation, which is the whole of what a stranger can do to either
of them, so nothing already recorded has to satisfy a rule it predates.

## The Worker

[`worker/`](worker/) holds the Cloudflare Worker that sends push notifications,
ingests bank credit alerts, and refits the ETA model each month. It is the only
component that runs somewhere a customer's browser cannot reach, and the only
holder of the credential allowed to write `eta/model` and `payments/incoming`.

It does **not** deploy with the pages — see [`worker/README.md`](worker/README.md).

## Deploying

Push to `main`. GitHub Pages serves the result. The Worker is separate, and so
are the database rules; neither ships with a push.

Two things to know:

- `sw.js` serves the cached shell and applies a new build on the **next** open.
  A tablet open all day has no next open, and neither does a kitchen screen. So
  every page staff leave open loads [`build-check.js`](build-check.js), which polls
  `build.json` and offers a **Reload now** banner when the page is behind. It never
  reloads by itself — a till reloading mid-transaction, or a kitchen screen blanking
  while someone reads a ticket, is a worse bug than a stale one.

  Each page declares its own build on the tag that loads it:

  ```html
  <script src="/build-check.js" data-build="2026-08-26.2"></script>
  ```

  `build.json` must be bumped with the pages, and `npm test` fails if any page
  drifts from it. Move all of them together:

  ```sh
  npm run bump              # next build for today
  npm run bump 2026-09-01.1 # or say which
  ```
- Database rules do **not** deploy with a push. Run the **deploy database rules**
  workflow from the Actions tab and type `DEPLOY`. It runs the rules suite first,
  deploys, then reads the live rules back and diffs them against the file — a run
  that says it worked has checked that it did.

  If a check after the deploy fails, it restores the rules that were live before
  and re-checks those — a bad rules file is never left in force while someone
  reads a failed workflow. It refuses to deploy at all if it cannot take that
  copy first.

  Deliberately not automatic: rules are the only real security boundary, and a bad
  commit deploying itself could lock the till out of the database or open it with
  nobody in the loop. Locally, `firebase deploy --only database` still works.
