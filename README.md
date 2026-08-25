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

Each page is self-contained: its own HTML, CSS and JavaScript in one file, with
Firebase loaded from a CDN. Sign-in is Firebase Auth; the role in
`users/{uid}.role` decides which pages an account can use.

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
npm run test:browser  # loads pos.html in Chromium (needs a browser download)
npm run access-map    # prints every database path each app reads and writes
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

CI runs these on every pull request and on `main`.

## Database rules

The rules are the only real security boundary: every check inside a page is
advice to a cooperating browser. They live in
[`database.rules.json`](database.rules.json) and `npm test` checks them — see
[`docs/database-access.md`](docs/database-access.md) for what it can and cannot
verify.

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

- `sw.js` serves the cached shell and applies a new build on the **next** open,
  so a tablet that has been open all day will not have picked up a fix. The
  build stamp at the foot of `pos.html`, `admin.html` and `index.html` is there
  to make a stale build obvious — check it on each device after a deploy that
  matters.
- Database rules do **not** deploy with a push. They are a separate step:
  `firebase deploy --only database`.
