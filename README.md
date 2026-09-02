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
| `qr.js` | — | draws the UPI payment code, on the till and on the customer's phone |

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

### Taking money

Every payment the café takes is the same shape: **a UPI code, on a screen, scanned
by a camera on a different device.** At the counter that is the till's screen and
the customer's phone. For a takeaway or delivery ordered from `index.html` — which
is prepaid, because an uncollected order costs food and a slot — it is the
customer's own screen and a second phone, with the UPI ID printed under the code
for anyone who only has one.

There is exactly one thing that does not work, and everything above is shaped
around it: **a `upi://` link fired from a web page cannot pay us.** From a page it
is an NPCI *Intent* (initiation mode 04), and OC/76A bars mode 04/05 to a P2P
payee — the app opens, the customer enters their PIN, and the payment is refused.
No amount of rebuilding the string changes that. So no page here offers to open a
UPI app on the device it is running on. Collection used to be handed to a WhatsApp
pay link for exactly this reason (a link tapped inside a native app does complete),
and in practice that failed for a different reason: WhatsApp renders a link from an
unsaved number as dead text, and a first-time customer is an unsaved number. That
route is gone. What is left is the one the counter has always used.

`qr.js` is the encoder both pages draw with — one implementation, because a wrong
QR is worse than a missing one: it scans, and it pays the wrong thing or nothing.

The ordering page picks the VPA off `settings/upiList` (the weighted routing list —
picking from it uniformly *is* headroom-weighted routing) and writes it onto the
order together with `billedAt`, the moment the customer was shown a code, in the
same push that creates the order. It has to be the same push: under the rules
an anonymous browser may create an order and not touch it again. The till's matcher
requires both fields, and refuses to match an order that has neither — without them
an order would match a bank credit on amount alone and could take money belonging
to another bill.

**That VPA is written by a stranger's browser**, so the matcher does not take it on
trust either: it also refuses any order billed to a VPA the café does not hand out.
Without that, anyone could push an order billed to a VPA of their own, never pay,
and wait — `upiBankMatch` cannot catch it, because an unknown VPA is not in
`upiRouting/config` and that filter fails *open* by design. The next genuine payment
of the same amount would be booked against their order and the real one left
unverified.

Nothing about the *staff* side of this is automatic. The till shows a live
paid/unpaid badge per web order, the customer's phone number to call, and raises a
push when an order has been billed for ten minutes with no matching credit.

**Only a matched credit says "paid".** Staff can Accept an order whose credit has
not landed — that is the override the counter uses when a bank's email is slow —
and the sale goes to the ledger `unverified` until the credit arrives. That is not
payment, and the customer's phone says so: the code stays on their screen, and the
watch stays live so a credit landing later still turns into a confirmation. When
one lands after the order has left `orders/pendingWeb`, the ledger reconciler is
what notices, and it flips `orders/track/{id}/paymentVerified` too — otherwise the
books would settle and the customer would never be told.

**Two clocks on every credit.** `at` is when the Worker ingested the bank's alert;
`bankTime` is when the bank says the money moved, parsed out of the alert. The feed
is ordered by `at`, because arrival order is what a "newest 60" window means. Every
question about whether a credit *belongs* to a sale uses `bankTime` — a bank alert
can queue for hours, so on `at` alone a late credit looks far from its own sale,
and, worse, a payment made before the customer had even ordered looks like it could
be theirs. `bankTime` is null whenever the Worker was not certain of the format,
and every reader falls back to `at`, so an unrecognised format is not a failure.

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
npm run test:compat   # the real Firebase SDK, in a browser, against the emulator
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
  by an independent decoder, and rendered on both real pages with the network off.
  The customer's page is checked for one thing more: the UPI ID and amount printed
  beside the code are the same payment the code encodes.
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
- **dialogs** — every overlay here said `aria-modal="true"`, and nothing made that
  true: aria-modal is a claim about the accessibility tree and nothing else. Opening
  one left focus behind it, so Tab walked down into the sixty rows of the menu
  underneath, where + and - were still live buttons beneath an overlay covering them.
  The till was the same shape with more of it — fourteen overlays over a floor plan of
  live table buttons, and no Escape key on a device cashiers type into all day. Focus
  now goes in, Tab stays in, Escape gets out, and closing hands focus back to whatever
  opened it. Two dialogs are held out of Escape on purpose and the suite checks that
  too: the customer's payment screen is the one telling them what they owe, and the
  till's UPI screen is in a customer's hands while they scan.
- **touch targets** — the + and - on the ordering page are how every item the café
  sells gets into a cart, and they were 32px and 26px wide with a 24px count between
  them. A thumb is about 45px across, so the tap that misses lands on - when it meant
  +, on a control whose only feedback is a number moving by one in either direction.
  The drawing is unchanged — a 44px button on every row would double the height of a
  sixty-row menu — and the target is not. The suite asks the browser what is hit at
  each point rather than measuring the button, because the button is the part that was
  deliberately left alone.
- **the focus ring** — all seven pages set `outline: none` on their text fields and
  none of them replaced it, so on a tablet signed in from a Bluetooth keyboard there
  was nothing to say whether the next keystroke was going into Email or Password. This
  is asked of a browser and not of the file, because the first version of the fix was
  in every page, correct, and beaten: `#login-box input` carries an id, which outranks
  a bare `:focus-visible` wherever it sits. A source check found the rule and passed;
  the page still had no ring.
- **contrast** — pure white on the brand brown `#8D6E52` is 4.68:1, and AA asks 4.5.
  That 0.18 of margin means there is no such thing as legible dimmed white on this
  background: at 0.8 it is 3.65, at 0.7 it is 3.19, at 0.6 it is 2.77 — under the bar
  for large text as well as body. The pages used opacity as their only device for
  hierarchy, 226 declarations of it, so a browser audit found 47 distinct failing text
  styles: "No Orders" on the kitchen board at 2.39:1, every KPI label on analytics at
  2.77:1, and the sign-in error at 3.36:1 — the one line on that screen that has to be
  read, at full opacity, and no red fixes it because the lightest pink that would pass
  on this brown is white. The brand does not move. Hierarchy is size, weight and
  letter-spacing now; what genuinely has to recede sits on a darkened chip, which
  lowers the surface under it and buys back what dimming spent; and state that used to
  be said by fading — sold out, voided, paused, already paid — is said in words. This
  is asked of a browser because the cascade is the whole question: inherited opacity
  multiplies down the tree, a chip is a semi-transparent layer that has to be
  composited rather than skipped, and none of that is visible in the file. A second
  check reads the source, because most of these pages build their rows from data that
  never renders in a test, and the rule those rows broke is stateable without them.
  The build stamp is the one exemption, and it is not a free one: it is a version
  string nobody reads while using the page, so it stays a ghost in the corner — on the
  condition that hover, focus or a touch brings it to full white, which the suite
  checks rather than takes on trust. Faint was always right; unreadable when you
  finally look was the bug.
- **reflow** — `.logo` was capped with `max-width: 350px`, which caps it against
  nothing: at a 320px viewport a 350px cap is still 350px, so the ordering page, the
  till and admin each carried 50px of horizontal scroll. It reads as a small-phone
  problem and is not one — browser zoom shrinks the layout viewport, so a customer at
  200% on an ordinary phone has about 195px, and the person who zooms in because they
  cannot read the menu is the person the menu then slides under. `analytics.html` had
  already been fixed and the three pages that needed it most never got it. Underneath
  it, `.container` at `width:90%; padding:20px` with no border-box came to 328px
  inside 320. The suite also holds the viewport meta, which is the same question from
  the other end: `admin.html` blocked pinch-zoom outright, and a page must either
  declare `viewport-fit=cover` AND pad content back out with `env(safe-area-inset-*)`
  or do neither — admin used the insets with no cover, so they had never resolved to
  anything but zero, and the kitchen boards declared cover with no insets, so a board
  mounted landscape on a notched tablet could sit its left edge under the camera.
  Last, REG and LRG on the sized-drink rows are a separate grid from the rows they
  label: both asked for the same tracks and resolved differently, because only the row
  has content with a minimum width. The right edges matched by luck, so LRG looked
  fine while REG sat 19px into the Large column.
- **target size** — every interactive control on every page has to be at least 44px in
  both directions, measured by hit-testing rather than by reading its box, so a target
  widened with a pseudo-element counts at its real size. This started as the customer's
  + and -, and the widening caught two things a narrower check would not: the till had
  the same 32px control and never got the fix, and where it HAD been attempted the
  pseudo-element pinned the target to the button's own width, so it was fixed in one
  dimension and not the other. The suite also refuses to pass on coverage it did not
  get — with the till's modals left closed it examined one control of forty-nine and
  reported clean, so each overlay is opened in turn and a floor is asserted.
- **on-states are visibly on** — the till's category strip stopped highlighting
  anything, and nothing broke to make it happen. `setActiveChip()` went on adding and
  removing `.active` exactly as before; what changed was underneath it. The highlight
  had never been a mark on the active chip — it was the absence of a dim every OTHER
  chip carried, `opacity: 0.6`, and the contrast pass removed that dim because white
  on this brown clears 4.5:1 with almost nothing spare, so 0.6 put every category the
  cashier was not on below the line. Removing it was right; removing it while leaving
  `.cat-chip.active { opacity: 1 }` behind left a rule that still matched, still
  applied, and resolved to the value the chip already had. No selector failed, no
  element went missing, nothing appeared in the console. So the suite looks the way a
  cashier does: it photographs each control off, photographs it on, and requires the
  two images to differ — with a control shot first, because two photographs of an
  unchanged control must match or the comparison is not evidence. What the difference
  is — a rule, a fill, a weight — is a design decision and none of the suite's
  business; that there is one is not. The chip is marked now rather than the other
  five dimmed: a 2px rule beneath it, the same idiom the stock page's tabs already use.
- **Reduce Motion** — iOS and Android both put it two taps from the home screen, and
  no page asked. The kitchen board pulsed an overdue ticket every 1.2 seconds for as
  long as it was late, which on a bad Sunday is every card on the board in the eye line
  of whoever is cooking. Honoured by shortening the motion rather than deleting it, so
  a zero-length transition still fires and still ends.
- **the one control a customer cannot undo** — Empty sat in the same row as Pay, the
  same size, and deleted the whole cart on the first tap. It now takes a second tap
  inside five seconds, and forgets if the dialog is closed — an armed button left armed
  is the same bug with a delay on it.
- **kitchen alarm** — the overdue threshold still adds saturation and oven time
  when the live model does not carry those curves. `etaInterp` reads a missing
  curve as zero, so the alarm would come in short and start calling on-time
  tickets late, silently.
- **web orders arrive billed** — a takeaway ordered from a phone reaches the till
  carrying the VPA it is billed to and `billedAt`, the moment the customer was shown
  a code, in the same write that creates it, on the server's clock rather than the
  phone's. An order carrying no `billedAt` was billed by nothing, and the till is
  checked for refusing to tie any credit to it — that guard is what stops an unbilled
  order taking a payment belonging to a bill somebody actually was shown.
  Those two fields are the whole of what makes a web payment verifiable, and if the
  write regresses nothing announces it: orders keep being placed and customers keep
  paying, and every one of them silently stops auto-verifying. The suite drives the
  real ordering page through a real cart and reads what it asked the database to
  store. It also checks the code drawn is a code for that VPA and that total, that a
  malformed routing entry can never end up inside the payment string, and that the
  code goes the moment the money is seen — one still on screen is an invitation to
  pay twice.
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
  are two ways one sits unpaid — nothing ever billed it, or it was billed and
  nothing came back — and the POS had an alert for each. Only the first fired: the
  second waited on `orders/track/{id}/needsManualVerify`, which nothing in this repo
  has ever written, while the first skipped every order that *had* been billed on
  the grounds that the second covered it. A customer who was asked and never paid
  produced no alert at all, for as long as the order existed.
- **rules, in the emulator** — `database.rules.json` is loaded into a real database
  and asked what each *role* may read and write. The offline suite can only read the
  file, and `tools/probe-rules.js` asks the live database with no credentials, so it
  can only ever ask what a stranger can read, after a deploy. This asks the question
  the other two cannot, on every pull request. Half of it is derived from the access
  map — every path an app uses must be permitted to the app that uses it, which is
  what makes tightening a rule safe: a locked-out till fails here rather than at the
  counter. The Worker gets the same treatment from `worker.js`, and needs it more:
  its reads fail silently, so a rule that shuts the robot out stops the hourly report
  and the monthly refit without breaking anything anyone can see. The other half is written by hand, because a list derived from the rules
  would agree with them by construction and check nothing. It also walks everything
  `admin.html` and `analytics.html` show and fails if any other role can reach it —
  those two pages check the role in a browser the holder controls, which is advice
  until the rules say the same thing.
- **the deploy probe's own footing** — `tools/probe-rules.js` reads a refusal as a
  pass, twenty-odd times, and that is sound only while the refusals are Firebase's.
  Every way of not reaching Firebase produces refusals too — a proxy that denies the
  host, a network policy, an outage — so run without a route to the database, every
  forbidden path is "denied" and the report is a clean bill of health for a database
  the process never spoke to. Found by running it inside a sandbox whose egress proxy
  answers 403 to CONNECT: all six public paths failed loudly, and all twenty-two
  forbidden ones passed. The public paths are now a positive control — one of them
  must answer before any refusal below counts — and this suite drives the real script
  against a stub answering the way each of those worlds answers: unreachable, healthy,
  reachable-and-leaking, and one-public-path-down, which is a finding about the rules
  and must not be mistaken for the network.
- **the SDK the till runs on** — every other browser suite stubs `window.firebase`,
  because what those suites ask about is the page's own code. That left the Firebase
  SDK itself with no coverage, on pages pinned to a 2021 release that had to move
  eventually. `npm run test:compat` reads the version and the integrity hashes out of
  the pages, fetches those exact bundles, refuses to run unless their bytes hash to
  what the pages committed — and then drives a real browser through the operations
  the money paths are built from: `ServerValue.increment`, a multi-path update at the
  root, a transaction that aborts, a listener that is detached. Moving the SDK is the
  moment you find out whether any of those changed.
- **cash out of the drawer** — `expense`, `withdrawal` and `tip_payout` are written
  by the Worker and by nothing else. Each sat behind a PIN prompt in the till, and
  the prompt was advice: `pos` is writable by any staff role, so the entry could be
  pushed with a colleague's name on it and no PIN at all. The Worker verifies a staff
  token *and* the PIN, then writes the ledger line and the drawer decrement in one
  atomic write; the rules refuse those three types from every browser, which is the
  half that makes the prompt a gate. Everything else in the ledger is still the
  till's to write — a sale has to be recordable when the Worker is unreachable — and
  each of those now moves its line and its running total in one write, and says so on
  screen if that write is refused rather than swallowing it.
- **stock on and off the shelf** — `inventory/stock` and `inventory/logs` are written
  by the Worker and by nothing else, so a prep or a delivery cannot be recorded without
  a PIN and cannot happen without a log line. The prompt used to be advice twice over:
  it ran in a browser, and `inventory` was writable by any staff role, so the write did
  not need it. The Worker reads the recipe rather than being told it, and the stock
  tablet no longer downloads the staff PIN hashes at all.
- **the table index prune** — the one job here that deletes. It takes entries older
  than its window and nothing else: an entry a minute inside it is one a customer may
  still be using, an entry whose timestamp it cannot read is left alone rather than
  guessed at, and a read it could not make deletes nothing — a denied read must not
  look like an empty index.
- **one order, not the whole history** — a customer can read their own order by its
  id and find it from the table they are sitting at, and cannot list every order the
  café has taken. Nor take every trackId at once from the index that replaced the
  query, which would be the same leak one level up.
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
holds that list — `menu`, `settings`, `eta/model`, `eta/live`, a single
`orders/track/{trackId}`, and one table's `orders/tableIndex` — and fails on anything
added to it or removed from it.

`orders/track` was on that list as a whole node until recently, because a customer
scanning a table QR queried it by `table` and a query needs read on what it queries.
One unauthenticated request returned every order the café had ever taken. The lookup
moved to `orders/tableIndex`, which holds trackIds and timestamps and nothing else,
is readable one table at a time, and is pruned to six hours by the Worker.

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
