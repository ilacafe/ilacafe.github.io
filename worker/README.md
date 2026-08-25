# The `ila-push` Worker

The most privileged component in Café Ila, and until now the only one with no
diff history.

Everything else in this repo is a static page. Its checks — PIN prompts, role
lookups, confirmation dialogs — run in a browser the customer controls, so they
are advice. This Worker is the one piece that runs somewhere a browser cannot
reach, which is why it holds the `robot@cafeila.app` credential: the only
identity permitted to write `eta/model`, `eta/modelPrevious`, `eta/recalMeta`
and `payments/incoming`.

It does four things:

| | trigger | what it does |
|---|---|---|
| **Push relay** | `POST /` from the pages | encrypts and sends Web Push to admin devices |
| **Payment ingest** | `POST /ingest`, and Email Routing | parses a bank credit alert → `payments/incoming/{utr}` |
| **ETA recalibration** | cron `0 20 1 * *` | refits `eta/model` from 75 days of completions |
| **Verification monitor** | cron `0 * * * *` | unverified-payment alerts, per-bank alarm, weekly digest |

## Deploying

**A push to `main` does not deploy this.** The pages deploy via GitHub Pages;
this deploys only when you run:

### Automatically, on push (no terminal)

Connect this directory to the Worker once, and every push to `main` deploys it:

**Workers & Pages → ila-push → Settings → Builds → Connect**, then set

| field | value |
|---|---|
| Repository | `ilacafe/ilacafe.github.io` |
| Git branch | `main` |
| Root directory | `worker` |
| Build command | *leave empty* |
| Deploy command | `npx wrangler deploy` |

The root directory matters: without it the build runs at the repo root and tries
to install the test dependencies, Playwright included.

The Worker name in the dashboard must match `name` in `wrangler.toml` — both are
`ila-push`, so it lines up. Runtime secrets stay where they are under **Settings
→ Variables and Secrets**; Workers Builds does not touch them.

### By hand

```sh
cd worker && ./deploy.sh
```

That prompts for any secret that isn't set yet, generates `RECAL_SECRET`, and
deploys. Safe to re-run — secrets already set are left alone, so a second run is
just `wrangler deploy`.

**Copy the secrets out of the live Worker before the first run.** They exist
today only as literals inside the deployed script, and deploying replaces it:
dashboard → Workers & Pages → ila-push → Edit code → the constants at the top.
Losing `VAPID_PRIVATE` means every admin device must re-subscribe.

`wrangler deploy` on its own works too. One warning still applies either way:
deploying makes the cron list in `wrangler.toml` authoritative, so a schedule
configured in the dashboard but missing from that file is removed.

## Secrets

The source is world-readable — GitHub Pages serves this repo raw (`.nojekyll`),
so `worker.js` is fetchable at `https://ila.cafe/worker/worker.js`. That is
fine, and it is also the reason **no secret may ever be a literal in it**.
`test/worker.test.js` fails the build if one is.

Set each of these once, with `npx wrangler secret put <NAME>`:

| binding | what it is |
|---|---|
| `VAPID_PRIVATE` | Web Push signing key. Rotating it invalidates every existing subscription — every admin device must re-subscribe. |
| `INGEST_SECRET` | Authorises `POST /ingest`. Must never appear in a page. Lives here and in your Shortcuts / email forwarder. |
| `RECAL_SECRET` | Authorises `recalibrate-now` / `recalibrate-dryrun`. Must never appear in a page. |
| `ROBOT_PASSWORD` | Firebase password for `ROBOT_EMAIL`. |
| `ROBOT_EMAIL` | `robot@cafeila.app` — the account `database.rules.json` grants write access. |
| `VAPID_SUBJECT` | `mailto:` contact for VAPID. |
| `EMAIL_FORWARD_TO` | A verified Email Routing destination; every bank email is forwarded there after processing. |

The last three are addresses rather than secrets, but they are personal, so they
stay out of the repo on the same principle.

`SHARED_SECRET` is **retired**. It authorised the push relay and was a literal in
four public pages, so anyone who viewed source could send any notification they
liked to every admin device — and, because the caller also supplied the recipient
list, could use the café's VAPID key to push to endpoints of their own. No secret
a browser must hold can fix that. The relay now takes a Firebase ID token and
checks `users/{uid}.role`; recipients come from the database. Once the pages have
shipped and the tablets have reloaded, delete the binding:
`npx wrangler secret delete SHARED_SECRET`.

`VAPID_PUBLIC`, `FIREBASE_API_KEY`, `FIREBASE_PROJECT` and `DB_URL` are in
`wrangler.toml` instead — all four already appear in the site's own source, so
committing them leaks nothing new.

## Who may send a push

`POST /` takes a **Firebase ID token**, not a secret:

```json
{ "token": "<firebase idToken>", "notification": { "title": "…", "body": "…", "tag": "…", "url": "/admin.html" } }
```

The Worker verifies the signature against Google's published keys, checks `iss`,
`aud` and `exp` for this project, refuses an anonymous sign-in, and then requires
`users/{uid}.role` to be one of `admin`, `cashier`, `barista`, `chef`. That last
lookup is why the robot needs read on `users/$uid`.

**Recipients are not a parameter.** The Worker reads `pushSubscriptions` itself.
When the caller supplied the list, the Worker was an open relay: anyone with the
page's secret could push to any endpoint, signed with the café's VAPID key.

`notification` is still free text — staff legitimately send amounts and table
names — but it is bounded and stripped of control characters, and `url` must be a
same-site path. `sw.js` passes `url` to `clients.openWindow()` when the
notification is tapped, so an absolute URL would open someone else's site from
what looks like a café alert.

### Deploying this without dropping alerts

The pages and the Worker deploy separately, so they are briefly out of step. The
pages send the token **and** the old `secret`/`subscriptions` fields, so a page
that ships before the Worker still works against the old one. Order:

1. Merge the pages.
2. `npx wrangler secret put FIREBASE_PROJECT`-adjacent bindings, then `npx wrangler deploy`.
3. Reload the tills and kitchen screens — `sw.js` serves the cached shell and
   applies a new build on the *next* open, so a tablet open all day is still
   running the old page and its pushes will 401 until it reloads. Check the build
   stamp reads `2026-08-25.5`.
4. Deploy the rules (below), then delete the retired secret and ask for the
   transitional block to be stripped from the four pages.

### If a binding is missing

`authOk()` refuses to authorise against an unset secret. This is deliberate:
without it, `data.secret === undefined` is *true* for a request that simply
omits the field, so one forgotten `wrangler secret put` would silently publish
an authenticated route. A missing binding fails closed — the route 401s — rather
than opening.

## Triggering a recalibration by hand

```sh
# see what a refit would do, change nothing (skips the volume gate on purpose)
curl -sX POST https://ila-push.<subdomain>.workers.dev/ \
  -H 'Content-Type: application/json' \
  -d '{"action":"recalibrate-dryrun","secret":"'"$RECAL_SECRET"'"}' | jq

# actually refit
curl -sX POST https://ila-push.<subdomain>.workers.dev/ \
  -H 'Content-Type: application/json' \
  -d '{"action":"recalibrate-now","secret":"'"$RECAL_SECRET"'"}' | jq
```

Start with the dry run. A real run snapshots the current model to
`eta/modelPrevious` before overwriting `eta/model` — so **two real runs in a row
destroy your rollback**, because the second snapshot is the model the first one
just wrote.

## Rolling back a bad model

`eta/modelPrevious` holds the model as it was before the last accepted refit.
Copy it over `eta/model` in the Firebase console. `eta/recalMeta` records what
happened on the last run (`lastRunAt`, `lastResult`, `version`, `reasons`).

## What the guardrails actually stop

`rcCheckGates` rejects the whole refit — keeping the current model and pushing a
notification — when a derived coefficient lands outside a hard bound, when
`pizzaBase` swings more than 40%, or when fewer than 200 clean orders survive
filtering. `RECAL_MIN_NEW_ORDERS` is separate: it declines to *attempt* a refit
until 1,500 completions have finished since the last run.

None of that checks whether the model is *good*, only that it is not absurd.
Judging quality is what `analytics.html`'s accuracy report is for.
