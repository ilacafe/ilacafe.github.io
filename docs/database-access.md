# Database access and rules

Every app here runs entirely in a browser: the customer's phone, the counter
tablet, the kitchen screen. There is no server of ours in between. So every
check written in a page is **advice to a cooperating browser** — a PIN prompt, a
role lookup, a confirmation dialog. Anyone who opens devtools can skip all of it.

The Realtime Database rules are the only thing that actually stops a read or a
write. They are the security boundary for this entire project.

## Exporting the rules

The rules are committed at `database.rules.json`. If you change them in the
console, export them again so the file stays the source of truth — otherwise
nobody can review the change, see when it happened, or roll it back, and an
accidental `".read": true` stays invisible until someone notices the leak.

Two ways, easiest first.

### From the console

**Realtime Database → Rules**, select all, paste into `database.rules.json` at
the repo root. No tooling, and it always works.

### Over REST

Rules live at the special `/.settings/rules.json` path on the database itself.
This project's database is in `asia-southeast1`, so it must be that host — the
generic `<project>.firebaseio.com` form will not reach it:

```sh
curl "https://ila-cafe-default-rtdb.asia-southeast1.firebasedatabase.app/.settings/rules.json\
?access_token=$(gcloud auth print-access-token)" > database.rules.json
```

The token needs an account with access to the `ila-cafe` project. Firebase's
own docs describe this path for reading rules; note that `firebase database:get`
is for reading *data* and does not serve `.settings`.

A rules file is JSON **with comments** — Firebase accepts them, and an export
may well contain them. The checks here strip comments before parsing, so leave
them in: they are usually the most useful thing in the file.

The map is derived from the source, including multi-path updates — writes whose
path lives in an object key rather than in `ref()`:

```js
updates[`inventory/stock/${item}`] = increment(n);
db.ref().update(updates);
```

An update can also be handed its object inline, which is the natural shape when
the keys are fixed — the end-of-day reset clears four nodes that way:

```js
db.ref('pos').update({ ledgerEntries: null, bills: null, upiTotal: 0 });
```

Read as a `db.ref()` alone that is a write to `pos`, which is true and useless:
what the rules get reviewed against is which children it clears. Both forms are
parsed for their keys.

Those keys are relative to whatever ref `.update()` was called on, which is not
always the root, so the base is read from the call site. What the map still cannot
place — a key whose prefix is in a variable — it prints at the bottom rather than
omitting, because a map that looks complete and is not is worse than one that says
where it stops.

`npm test` checks that file (see below), so every change to it shows up as a
reviewable diff. `firebase.json` points at that filename, so the **deploy
database rules** workflow — and `firebase deploy --only database` locally —
deploys it.

> **Do not deploy rules that were not exported from production first.**
> Deploying a guess can either lock the café out of its own till mid-service or
> quietly open data that was closed. Export, commit, *then* change one thing at a
> time on top of a known-good baseline.

## What the checks cover

`test/rules.test.js` runs as part of `npm test`. With no rules file it reports
that and does nothing else. Once the file exists it checks:

1. it parses, and has a `rules` root
2. nothing is writable without authentication, anywhere in the tree
3. nothing **sensitive** is readable without authentication — `menu`,
   `settings` and `eta` are public by design because the ordering page needs
   them before sign-in; everything else public-readable is a finding
4. every path the apps actually use has *some* rule that could permit it — an
   unruled path is denied by default, which shows up as a feature that silently
   does nothing

What it **cannot** check is whether a condition is *correct* for a given role.
`".read": "auth != null"` and `".read": "root.child('users').child(auth.uid).child('role').val() === 'admin'"`
both pass every check above, and only one of them is right for `pos/ledgerEntries`.
Verifying that needs the Firebase emulator running against real auth tokens.

## The access map

`npm run access-map` prints every database path the apps touch, who reads it and
who writes it, derived from the source. That is the reference to review the
exported rules against: a rule is right when it permits exactly those and
nothing more.

It is generated rather than written down here, so it cannot drift from the code.

## Roles

`users/{uid}.role` is one of `admin`, `cashier`, `barista`, `chef`. Each app
checks it at sign-in and signs the user out if it does not match. Again — that
check is in the page, so it is advice; the rules have to enforce it.

`inventory.html` is different: it authenticates with a **staff PIN** rather than
a role, against the `staff` map.

## Three things worth looking at closely in the exported rules

These come from reading the code, and each one is a question the rules answer:

**1. `orders/pendingWeb` is written by anonymous visitors.**
That is how web orders arrive, and the ordering page uses `signInAnonymously()`,
so "anonymous" means anyone at all. A rule here should at minimum constrain the
shape of what can be pushed. Note that the POS no longer trusts the prices in
these orders — it re-prices every line against the live menu on accept — but
nothing stops a stranger filling the node with junk.

**2. `orders/track/{trackId}` is read *and* written by anonymous visitors.**
A trackId is the only thing protecting one customer's order from another's.
Worth confirming a visitor cannot enumerate or overwrite someone else's.

**3. `staff` is readable by every signed-in role.**
It maps `SHA-256(fixed salt + PIN) → name`, and the salt is a literal in the
page source. Any staff account that can read this map can recover every PIN in
well under a second, and PINs authorise voids, expenses, withdrawals, tip
payouts and end-of-day. Restricting the read does not fix the design — the PIN
check still happens in the browser and can be skipped — but it removes the
easiest attack. The real fix is to verify PINs somewhere that isn't the client.

## The public surface, and eta/live

The ordering page runs before anyone signs in, so whatever it reads has to be
world-readable. It used to read `orders/active`, `orders/ready` and
`orders/completed` directly, to work out how many orders were ahead, when a pizza
last left the oven, and how fast the kitchen was going.

Those nodes carry every order's items, notes and — for a delivery — the
customer's address, and `ready` and `completed` are never pruned. Serving four
numbers meant publishing the café's whole order history to anyone who asked.

The POS now publishes just those numbers to **`eta/live`**:

```
eta/live: { activeChef, activeBarista, lastPizzaOut, pace: [{at, r}…], updatedAt }
```

`pace` is one ratio per recent completion — how long it took against what the
model expects — with no item names, no destination and no notes. The ordering
page still runs its own median, window and smoothing over it, so the estimate is
unchanged; `test/eta-summary.test.js` asserts that both routes produce the same
tempo to within 1e-9.

The POS is the writer because it is open throughout service and already holds
every input. If no POS is open, the node goes stale, and the ordering page checks
`updatedAt` and falls back to a neutral estimate rather than a wrong one.

### Deploy the code before tightening these rules

The rules that close `orders/active`, `orders/ready` and `orders/completed` are
already in `database.rules.json`, but the order of operations matters:

1. **Ship the pages first** (merge to `main`; GitHub Pages deploys them).
2. **Open the POS and let it publish.** Check `eta/live` has an `updatedAt` in the
   Firebase console. Until a POS with this build is open, nothing writes it.
3. **Then** run the **deploy database rules** workflow.

Do it the other way round and the ordering page loses its wait estimate for as
long as it takes a POS to update — the estimate degrades to neutral rather than
breaking, but there is no reason to accept even that.

The ordering page keeps the old direct reads as a fallback for exactly this
window. Once the rules are deployed those reads fail, which is harmless: the
values stay at their neutral defaults and `eta/live` is doing the work.

## The robot account, and what refits the ETA model

`eta/model` is not static. The Cloudflare Worker in [`worker/`](../worker/)
refits it monthly from 75 days of completions — per-item base times, the oven
curve, both saturation curves, the quantity curve, cushions and margins — behind
guardrails that reject a refit whose numbers are absurd, and a snapshot at
`eta/modelPrevious` to roll back to. `eta/recalMeta` records what the last run
did.

That Worker signs in as `robot@cafeila.app`, which is why the rules name that
address explicitly: it is the only identity allowed to write `eta/model`,
`eta/modelPrevious`, `eta/recalMeta` and `payments/incoming`. No browser holds
that credential, and nothing in a page can obtain it.

**Every write the robot needs was granted to it by email; not one read was.**
Reads were all gated on `users/{auth.uid}/role` existing, and a service account
has no `users` entry — so the robot could write `eta/model` but could not read
`orders/completed` to derive one, and could not read `pushSubscriptions` to
notify anyone. `monitor`, the Worker's own alert state, had no rule at all and
fell to the root's default deny. The rules now name the robot on each of those
reads; `test/worker.test.js` extracts the paths from the Worker's source and
fails if one is unreachable.

Two consequences worth keeping in mind when reading the rules:

- A rule that grants `orders/completed` to staff must still admit the robot, or
  the monthly refit reads nothing and the model silently stops improving.
- `pushSubscriptions` is read by the Worker both to notify the owner and to
  address a staff-sent alert. Anything that closes it to the robot turns off the
  recalibration result, the unverified-payment alert, the per-bank alarm, the
  weekly digest *and* every overdue-order push — all of which fail quietly,
  because a push that cannot be sent has nowhere to report.
- `users/$uid` is readable by the robot so the push relay can check the sender's
  role. The parent `users` node stays admin-only, so that grants a lookup by uid,
  never a listing.

## The staff PIN is attribution, not authorisation

`staff` maps `SHA-256(fixed salt + PIN) → name`, the salt is a literal in the
page source, and every signed-in role can read the map. Any staff account can
therefore recover every PIN in under a second, and PINs gate voids, expenses,
withdrawals, tip payouts and end-of-day.

Restricting that read looks like the fix and mostly is not, because the PIN is
not what authorises the action. `pos.html` pushes ledger entries straight from
the browser:

```js
db.ref('pos/ledgerEntries').push(entry);
```

and `pos` is writable by anyone holding a staff role. So a staff member does not
need anyone's PIN to record a withdrawal against a colleague's name — they can
write the entry directly. The PIN prompt is a speed bump in the UI, and the name
it stamps into `reason` is advisory.

Making it real means moving those writes into the Worker: verify the staff token
and the PIN there, write the entry from there, and stop clients writing those
types at all. That is a change to the till's money path and has not been made.

What has been made is **visibility**. The hourly monitor reports cash leaving the
drawer — `expense`, `withdrawal`, `tip_payout`, `unpaid_writeoff` — with the
amount, the reason and the name it claims, so the owner sees it the same hour
rather than at end-of-day, and the named person can say whether it was them.
Routine spend under ₹500 is not reported, because a notification nobody reads is
worse than none; a written-off bill is reported at any size.

## Deploying rules

Actions → **deploy database rules** → Run workflow, and type `DEPLOY`. It runs
the rules suite against the commit, deploys, then reads the live rules back from
`/.settings/rules.json` and diffs them against the file. A run that reports
success has checked that the rules being enforced are the rules in git.

If any check after the deploy fails, the workflow **puts the old rules back** and
re-probes them. The checks have to run after the deploy, since they are checking
the deploy — so without a rollback a rules file that fails them simply stays in
force while somebody reads a failed workflow. It takes a copy of the live rules
before touching anything, and refuses to deploy at all if that copy cannot be
taken: no backup, no change.

It then asks the database the same question from outside, with no credentials at
all — an unauthenticated GET against every path that should be public and every
path that should not, which is the request an attacker would make. A condition can
be exactly what the file says and still permit the wrong thing: rules cascade, and
reading a rule is not the same skill as predicting its effect. The deny list in
[`tools/probe-rules.js`](../tools/probe-rules.js) is written down separately from
the rules on purpose — derived from them, it would agree with them by construction
and check nothing.

Locally, if you have the credentials:

```sh
firebase deploy --only database          # deploys database.rules.json
```

The pages themselves deploy on push to `main` via GitHub Pages. Rules do not —
they are a separate, deliberate step, and they stay that way on purpose. A bad
rules commit deploying itself could lock the till out of the database mid-service
or open data that was closed, with nobody in the loop.

The workflow needs a repository secret `FIREBASE_SERVICE_ACCOUNT` holding a
service-account JSON with rights over the Realtime Database (Firebase console →
Project settings → Service accounts → Generate new private key). If it is
missing, the run stops and says so rather than failing on an opaque 403.
