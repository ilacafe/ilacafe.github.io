# Database access and rules

Every app here runs entirely in a browser: the customer's phone, the counter
tablet, the kitchen screen. There is no server of ours in between. So every
check written in a page is **advice to a cooperating browser** — a PIN prompt, a
role lookup, a confirmation dialog. Anyone who opens devtools can skip all of it.

The Realtime Database rules are the only thing that actually stops a read or a
write. They are the security boundary for this entire project.

## The rules are not in this repo yet

They exist and they are not trivial — `analytics.html` refers to "the locked
rules" and expects `orders/completed` to be role-readable via `users/{uid}` —
but they live only in the Firebase console. That means:

- nobody can review them,
- nobody can see when they last changed, or who changed them,
- an accidental `".read": true` is invisible until someone notices the leak,
- and there is no way to roll one back.

**Export them and commit them.** Two ways, easiest first.

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

Once that file lands, `npm test` starts checking it (see below) and every future
change to it shows up as a reviewable diff.

`firebase.json` is already committed and points at that filename, so
`firebase deploy --only database` will deploy it once it exists.

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
3. **Then** `firebase deploy --only database`.

Do it the other way round and the ordering page loses its wait estimate for as
long as it takes a POS to update — the estimate degrades to neutral rather than
breaking, but there is no reason to accept even that.

The ordering page keeps the old direct reads as a fallback for exactly this
window. Once the rules are deployed those reads fail, which is harmless: the
values stay at their neutral defaults and `eta/live` is doing the work.

## Deploying rules

```sh
firebase deploy --only database          # deploys database.rules.json
```

The pages themselves deploy on push to `main` via GitHub Pages. Rules do not —
they are a separate, deliberate step.
