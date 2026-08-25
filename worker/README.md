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

```sh
cd worker
npx wrangler deploy
```

Read `wrangler.toml` first — it carries two warnings that matter on a first
deploy from this file (the compatibility date, and cron triggers being made
authoritative).

## Secrets

The source is world-readable — GitHub Pages serves this repo raw (`.nojekyll`),
so `worker.js` is fetchable at `https://ila.cafe/worker/worker.js`. That is
fine, and it is also the reason **no secret may ever be a literal in it**.
`test/worker.test.js` fails the build if one is.

Set each of these once, with `npx wrangler secret put <NAME>`:

| binding | what it is |
|---|---|
| `VAPID_PRIVATE` | Web Push signing key. Rotating it invalidates every existing subscription — every admin device must re-subscribe. |
| `SHARED_SECRET` | Authorises the push relay. **Public by construction** — it is a literal in `pos.html`, `admin.html`, `barista.html`, `chef.html`, all served from ila.cafe. Rotating it means editing those four pages too. |
| `INGEST_SECRET` | Authorises `POST /ingest`. Must never appear in a page. Lives here and in your Shortcuts / email forwarder. |
| `RECAL_SECRET` | Authorises `recalibrate-now` / `recalibrate-dryrun`. Must never appear in a page. |
| `ROBOT_PASSWORD` | Firebase password for `ROBOT_EMAIL`. |
| `ROBOT_EMAIL` | `robot@cafeila.app` — the account `database.rules.json` grants write access. |
| `VAPID_SUBJECT` | `mailto:` contact for VAPID. |
| `EMAIL_FORWARD_TO` | A verified Email Routing destination; every bank email is forwarded there after processing. |

The last three are addresses rather than secrets, but they are personal, so they
stay out of the repo on the same principle.

`VAPID_PUBLIC`, `FIREBASE_API_KEY` and `DB_URL` are in `wrangler.toml` instead —
all three already appear in the site's own source, so committing them leaks
nothing new.

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
