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
| `analytics.html` | owner | sales history, demand model, cash-up archive |
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
- **write-only paths** — every database path an app writes is read back somewhere.
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
read sits on the exact nodes a customer needs and nowhere above them. `npm test`
holds that list — `menu`, `settings`, `eta/model`, `eta/live`, `orders/track` —
and fails on anything added to it or removed from it.

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
