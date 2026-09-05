# Integrations, and where AI belongs

Everything here is a proposal. Nothing in this document ships; it is the
reasoning to argue with before anything does.

Two questions, answered in one place because they have the same answer to the
same first question: **where can this run?** Café Ila has one component that is
not a browser, and that fact decides almost every design below.

---

## The five constraints

Any integration here has to satisfy all five. Most vendor documentation assumes
a server; this project does not have one, and the rules that follow from that
are not negotiable.

**1. There is exactly one place a secret can live.** GitHub Pages serves this
repo raw — `worker.js` is fetchable at `https://ila.cafe/worker/worker.js`, and
so is every page. An API key in a page is an API key published. So every
integration that authenticates with anything becomes a route on the Cloudflare
Worker, holding its credential in a binding. `test/worker.test.js` already fails
the build on a literal secret; a new integration inherits that check for free.

This is not a small tax. It means "add a Zapier webhook" or "drop in their
JavaScript snippet" is never the answer here, and every item below is costed as
a Worker route.

**2. New data needs new rules, deployed by hand.** Anything that writes a node
`database.rules.json` does not mention is refused, and refused Firebase writes
are silent unless something is attached to the promise. Every integration below
that stores anything is also a rules change and a run of the **deploy database
rules** workflow — a separate deploy, in a separate order, documented in
`worker/README.md` for the two routes that have already been through it.

**3. Fail closed, and say so.** `authOk()` refuses to authorise against an unset
binding, because `data.secret === undefined` is true for a request that simply
omits the field. `reportIfItThrows` records a failing scheduled job to
`ops/cronFailure` and pushes the owner at most once a day. A new route joins
both, or it is a route that can be quietly wrong.

**4. Nothing is read whole.** `RECAL_MAX_RECORDS`, `DIGEST_ARCHIVE_KEYS`, the
`limitToLast` on every feed — `test/unbounded-reads.test.js` holds the line, and
it holds it for the Worker too, because the Worker reads on a schedule with
nobody watching and a hard ceiling on memory and time.

**5. A vendor going down must not stop the café.** The idiom already exists, in
`analytics.html`: *"Weather is unreachable — forecasts ignore the rain for
now."* Every integration below needs its own version of that sentence written
before it is built, and a test in the shape of `worker-stall-browser.test.js` —
a connection that is made and then goes nowhere is the café's actual failure
mode, and no browser applies a timeout of its own.

And one that follows from having no build step: a page cannot `npm install`. A
new script in a page is a pinned CDN URL with an SRI hash that
`test/third-party.test.js` verifies against the live file, and it has to
actually be used by the page that loads it.

---

## Part 1 — API integrations

Ranked by what they fix, not by what they add. Everything in Tier 1 replaces
something that is currently fragile or already known-broken.

| | Integration | Replaces | Cost | Effort |
|---|---|---|---|---|
| 1 | Cron heartbeat (Healthchecks.io / Cronitor) | nothing — closes a hole | free | an afternoon |
| 2 | WhatsApp Business Cloud API | `wa.me` links a human taps | paise per message | ~a week + approvals |
| 3 | UPI payment aggregator | bank-alert email scraping | platform fee, T+1 settlement | weeks, staged |
| 4 | Maps geocoding (Mappls / Ola / Google) | an unvalidated address textarea | free tier likely enough | days |
| 5 | Google Business Profile | hours that go stale on Maps | free | days |
| 6 | Accounting (Zoho Books / Tally) | a monthly CSV, or nothing | subscription | days, after a prerequisite |
| 7 | Firebase Phone Auth | a phone number anyone can type | free | days |

### Tier 1 — fixes something broken

#### 1. A dead-man's switch on the crons

The cheapest item on this list and the one I would do first.

`reportIfItThrows` catches a cron that **throws**. Nothing catches a cron that
**stops firing** — and there are several ways for that to happen that leave no
trace: a `wrangler deploy` from a `wrangler.toml` missing a schedule silently
removes it (the file's own comment warns about exactly this), an account or
billing problem suspends the Worker, a bad deploy replaces the script. In every
one of those cases `ops/cronFailure` stays empty, no push goes out, the
Worker-health panel on `analytics.html` reports nothing wrong, and the hourly
verification monitor — the thing that notices unpaid web orders and per-bank
alarms — simply stops. It looks exactly like a quiet week.

The fix is a `fetch` to a heartbeat URL at the end of each successful run, and a
service that alerts when a ping does not arrive. Healthchecks.io, Cronitor and
Better Stack all have free tiers that cover two crons. No secret worth
protecting, about five lines, and it is the only thing on this list that
monitors the monitor.

Degraded: a heartbeat that fails to send must not fail the run. Wrap it and
ignore the result.

#### 2. WhatsApp Business Cloud API

There are seven `wa.me` links in this repo and two of them are documented
hazards.

The first is in the cash-up. `pos.html` ends the day with
`window.location.href = 'https://wa.me/...'`, which is a real navigation that
takes the socket and any un-acked write with it — the README explains that the
archive is written *before* the hand-off for precisely this reason, and that the
reset had to become one atomic update because a till that comes back half-reset
carries yesterday's UPI total into today's takings. That is a lot of careful
engineering spent on working around a link.

The second is worse, because it is a route that was tried and abandoned:
*"WhatsApp renders a link from an unsaved number as dead text, and a first-time
customer is an unsaved number."* Every customer-facing message the café might
want to send runs into that.

The Cloud API's **utility templates** are exactly the business-initiated
message-to-a-stranger case, and they are pre-approved by Meta rather than
rendered dead by the recipient's contact list. What that unlocks, in rough order
of value:

- **the three-minute unpaid nudge, sent to the customer instead of the owner.**
  Today an unpaid prepaid order pushes the *owner*, who then has to work out
  which bank app to open and phone somebody. The person who can fix it fastest
  is the customer, and nothing currently reaches them.
- **payment confirmed** — `orders/track/{id}/paymentVerified` already exists as
  the single flag that tells the customer's phone. It only tells a phone that
  still has the tracking page open.
- **ready for collection**, and **out for delivery**.
- **the EOD report to the owner**, sent from the Worker. No navigation, no lost
  socket, and the cash-up stops being the one flow that has to be careful about
  the order it does things in.

It fits the existing shape exactly: `POST /` with a Firebase ID token, verified
against Google's JWKS, `users/{uid}.role` checked, anonymous sign-in refused —
the push relay already does all of that and a WhatsApp send is the same gate
with a different body. Token in a binding.

**The friction is real and mostly not technical.** Meta Business verification;
a phone number that is not already a personal WhatsApp and cannot become one;
template approval per template, with edits re-entering review; and per-message
pricing in the utility category — single-digit paise per message in India at
recent rates, but Meta has changed the India rate card repeatedly, so price it
from their current sheet rather than from anything written here. Free-form
replies are only possible inside a 24-hour window opened by the customer
messaging first, which means the templates are the product and the wording of
each one is a decision to make before any code.

Degraded: keep every `wa.me` link exactly where it is. If the send fails, the
staff-taps-a-link path is what the café has today and it still works.

#### 3. A UPI payment aggregator

The largest change on this list, with the largest payoff, and the one to stage
most carefully.

**What is fragile now.** `parseICICI`, `parseAirtel` and `parseAxis` are regexes
over the text of a bank alert email. `parseBankTime` returns `null` whenever it
is not certain of the format and every reader falls back to `at`, which is
correct and is also the shape of a slow degradation nobody sees. A bank changing
its template does not throw; it produces an alert nothing matches, and the
consequence is that auto-verification quietly stops and every web order waits
for a human with a bank app.

**What it costs elsewhere in the design.** Because a bank credit carries no
order id, matching is done on **amount + a time window + the VPA**. That single
fact is the reason `billedAt` and the VPA have to be written in the same push
that creates the order, the reason the matcher refuses an order billed to a VPA
the café does not hand out, the reason `payments/claims` exists with a
derived-token claim protocol, and the reason the README has to explain what
happens when *"the next genuine payment of the same amount"* is booked against
the wrong bill. All of that is defensive machinery for one missing field.

An aggregator's webhook carries the order id in the payment reference. Matching
becomes a lookup. Most of the machinery above becomes unnecessary — though it
should be kept and left running against the old rails during the transition,
not deleted on day one.

**The bigger prize, if it holds.** The README's diagnosis of why a `upi://` link
from a page cannot pay the café is specific: it is an NPCI Intent, initiation
mode 04, and *"OC/76A bars mode 04/05 to a **P2P** payee."* A payment
aggregator's VPA is a P2M payee. If the diagnosis is right, that restriction
does not apply to a merchant collection flow — which would mean a customer on
`index.html` taps one button, their own UPI app opens, and they pay, with no
second phone and no printed VPA underneath the code.

**Test that with a one-rupee payment before designing anything around it.**
This repo has already been confidently wrong about a payment route once — the
WhatsApp pay link was adopted for a good reason and failed for an unrelated one
— and the cost of being wrong here is a rebuild.

**Honest costs.** KYC and a current account in the business's name. Settlement
moves to T+1 into a nominated account rather than landing instantly in whichever
of the café's accounts the code routed to — which also means `upiRouting`, the
monthly caps and the weighted VPA list become a smaller problem or no problem,
depending on how much of the routing exists for headroom rather than for
convenience. UPI MDR for merchants is nil under the zero-MDR mandate, but
aggregators charge platform and gateway fees of their own and price other rails
differently, so read a current rate card. And reconciliation shifts from bank
alerts to the aggregator's settlement report, which the EOD would need to learn
to read.

**Stage it.** `settings/upiList` is already a weighted routing list, and the
till already refuses an order billed to an unknown VPA. Add the aggregator as
one entry, watch the match rate on real orders for a fortnight, then widen. The
email ingest stays as the fallback path for the direct VPAs, and only stops
being load-bearing when nothing is routed to them any more.

### Tier 2 — new capability, clear payoff

#### 4. Maps: geocoding and a real delivery ETA

`delivery-address` is a 200-character textarea. Nothing validates it, nothing
checks the café can reach it, and the ETA shown to a delivery customer is the
*kitchen's* ETA — when the food is ready, not when it arrives.

Two things a geocoding API buys, in order of value:

- **Refuse an unservicable address before taking money.** A prepaid order to an
  address 12km away is a refund, and `refunds and voids` is a path this repo
  went to some trouble to make atomic precisely because it is expensive. Better
  not to enter it.
- **A delivery ETA that is the kitchen ETA plus the drive**, written onto
  `orders/track` where the customer's phone already reads.

On vendor: evaluate **Mappls (MapmyIndia)** and **Ola Maps** against **Google
Maps Platform** on fifty real addresses out of `orders/history` before choosing.
Indian address and pincode geocoding is where these differ most, the Indian
providers are usually cheaper, and this is a question with a measurable answer
sitting in the database already. Worker route, key in a binding, results cached
against a normalised address string so a repeat customer costs nothing.

Degraded: the address field behaves exactly as it does today and the ETA is the
kitchen's. Say which one is being shown.

#### 5. Google Business Profile

`settings/isOpen` and `settings/storeStatus` already exist and are already
toggled from `admin.html`. Nothing carries them to the place most people check.

Syncing hours and the open/closed flag to the Business Profile stops the single
most expensive small failure a café has — somebody makes the trip because Maps
said open. The same API reads reviews, which could land in a node the owner
actually looks at rather than in an app they have to remember to open.

Free. OAuth, so a refresh token in a Worker binding, which is the one wrinkle:
refresh tokens expire and the failure is silent unless it goes through
`reportIfItThrows` like everything else on the hourly tick.

#### 6. Accounting — but read the prerequisite first

**There is no tax handling anywhere in this repo.** `grep -i gst` across every
page finds only `gstatic.com`. No GSTIN, no HSN, no tax split on a bill, nothing
in `pos/eodArchive` that distinguishes taxable from exempt.

If the café is GST-registered, that is a gap to close *before* an accounting
integration rather than with one — an API that receives untaxed totals produces
books that are wrong faster. If it is under the threshold or on the composition
scheme, a daily sales total is genuinely all the accountant needs, and a monthly
CSV out of `analytics.html` may beat any integration on both cost and effort.

e-invoicing through the IRP applies above a turnover threshold in the crores.
Almost certainly not applicable here; check the current threshold rather than
building for it.

If it is worth doing: the hourly cron already has the archived day in hand, so a
once-daily push of `pos/eodArchive/{date}` as a sales voucher into Zoho Books or
Tally is a small addition. Make it idempotent on the archive key — a retried
Worker run must not book the day twice, and this Worker retries.

#### 7. Firebase Phone Auth for customers

`customers/{phone}` already accumulates `orders`, `lastAt` and `lastSpend`,
written by the till when a web order is accepted. It is keyed by a phone number
somebody typed, which means it is a record anyone can claim by typing the same
number.

Phone Auth turns that into an identity. What it unlocks: order history on
`index.html`, a saved address that lives somewhere other than one browser's
`localStorage`, and any loyalty scheme at all — none of which is safe to build
on a self-declared phone number.

No new vendor; it is already in the Firebase project. The work is a rules change
(a customer may read their own `customers/{phone}` and nobody else's) and a
sign-in flow on a page that currently signs in anonymously, which has to stay
optional — requiring a login to order would cost more than it buys.

### Tier 3 — probably don't

**Swiggy and Zomato.** No open partner API at this scale. The real route is
middleware — UrbanPiper, Petpooja, Rista, Dotpe — which means a subscription, a
menu mapping to maintain, and a second system that believes it knows what is in
stock. Only worth it if aggregator volume is already material. If it happens,
inject into `orders/pendingWeb` with a distinct `source` field so the till knows
they arrive prepaid and the analytics do not silently blend channels.

**SMS.** DLT registration under TCCCPR — entity, header and template, each
approved separately — is weeks of paperwork for something WhatsApp does better
and cheaper. Worth revisiting only if WhatsApp delivery rates disappoint.

**A general integration platform** (Zapier, Make, n8n). Every item above is one
`fetch` inside a Worker that already exists. A platform would add a second place
secrets live and a second thing to notice when it stops.

### Not third-party, but worth doing

- **Cloudflare Analytics Engine.** The Worker's health is currently one database
  node and a push. A binding and one `writeDataPoint` per interesting event
  gives a time series — match rate, parse failures per bank, push failures per
  day — that `analytics.html` could chart beside the panel it already has. No
  new vendor, no new secret.
- **Turnstile.** Free, Cloudflare, and a prerequisite for anything in Part 2
  that an anonymous browser can reach.
- **Client error reporting.** CI catches a syntax error; nothing catches a
  runtime one. A `window.onerror` handler posting to a Worker route that writes
  `ops/pageError` is about twenty lines and would have caught several of the
  bugs the README describes finding by other means. Rate-limit it, or one
  looping error on one till writes forever.

---

## Part 2 — AI

One rule makes everything below safe, and it is worth stating before the list:

> **The model narrates. The code computes.**
>
> Every number a person acts on comes from a deterministic function a test can
> pin. The model's job is to say what those numbers mean, in a sentence, in the
> place where somebody will read it. Nothing that moves money, decides what is
> cooked, or tells a customer a time has a language model in its path.

That is not caution for its own sake. It is the same principle the ETA
recalibration already runs on — `rcCheckGates` rejects a whole refit when a
coefficient lands outside a hard bound, because a model that is confidently
wrong is worse than no model. The difference between the useful version of every
idea below and the dangerous version is which side of that line it sits on.

### Where AI clearly belongs

#### A. The daily and weekly report, in words

The highest value per rupee on this list.

`runWeeklyDigest` already computes the numbers. The EOD already reaches the
owner. What is missing is the reading: not *"₹18,400"* but *"₹18,400, about 22%
under what the model expected for a Sunday — it rained 14mm, and the demand
map's rain bucket accounts for roughly 18% of that. The rest is four pizza
orders that did not happen."*

The input is the already-computed digest object, never raw orders — which keeps
the token count small, keeps the café's order history out of a third party, and
makes the output reproducible from something a test can construct. Cap the
output length. If the call fails, send the numbers exactly as they are sent
today: the degraded path is the current product, which is the easiest kind of
fallback to be confident in.

**Cost, concretely.** Roughly 2,000 input tokens and 300 output per day. On
`claude-opus-5` at $5/$25 per million that is under two cents a day — call it
$0.55 a month. This is not a feature that needs a budget conversation.

#### B. Bank alerts the regexes did not parse — as a fallback that never books money

Only worth building if the aggregator in Tier 1 is *not* happening. If it is,
this problem disappears and you should skip this.

The shape that is safe: run the existing parsers first, unchanged. When an email
arrives **from a known bank sender** and no parser matches it, send only that
residual to a model for extraction, and write the result to a **quarantine
node** — with the model's own reading, the raw text, and no claim of truth —
surfaced on `admin.html` for a human to confirm. Never `payments/incoming`.
Never auto-matched. Never a booking.

Two things make this worth the trouble. A bank template change stops being
silent, because the residual is visible. And the *rate* of residuals is itself
the alarm: a spike means a parser needs updating, which is information nothing
currently produces.

#### C. An ordering assistant on `index.html`

*"Two of us, one vegetarian, under ₹800"* is a question the menu cannot answer
and a person at the counter answers twenty times a day.

It is also the one idea here with real risk, so the constraints are the design:

- **Grounded in `menu` with `inStock`, returning item keys from a fixed list**,
  not prose about items. The page renders the items from its own menu data; the
  model chooses which, and cannot name something the café does not sell.
- **Worker route, Turnstile-gated.** The caller is anonymous by construction —
  `index.html` uses `signInAnonymously()` — so the staff-token gate that
  protects every other route does not apply, and without a gate anyone can burn
  the token budget from a script. This is the one integration where abuse is not
  hypothetical.
- **A hard monthly spend cap in the Worker, and a kill switch in `settings`**
  readable from `admin.html`, so the owner can turn it off without a deploy.
  Report hitting the cap through `reportIfItThrows` like anything else.
- **It must refuse allergen and dietary-safety questions.** The menu carries no
  allergen data. A model asked *"is this dairy-free?"* over a menu that does not
  record dairy will produce an answer, and the answer will sometimes be wrong,
  and this is the one place on this list where being wrong hurts somebody.
  Either add the field to the menu — which is a good idea regardless — or the
  assistant says *"please ask at the counter"* and means it.

**Cost, concretely, because it argues for the guardrails.** A ~3,000-token menu
plus a short answer is around $0.02 per conversation on `claude-opus-5`
uncached; a hundred conversations a day is $60 a month. Prompt-cache the menu
prefix and cache reads run at roughly a tenth of input cost, bringing it nearer
$20. Verify that with `usage.cache_read_input_tokens` rather than assuming —
the minimum cacheable prefix is model-dependent and a 3,000-token menu may sit
below it. If the cap matters more than the quality, `claude-haiku-4-5` at $1/$5
is the explicit trade to make deliberately, not by drifting into it.

Degraded: the menu is the product. If the route is down the page is exactly what
it is today, with one sentence saying the assistant is not available.

#### D. A morning prep sheet

`inventory/stock`, `inventory/recipes` and the demand model between them already
contain *"Saturday wants 4.1 litres of cold brew concentrate and you have
1.2."* That is arithmetic — write it in code, where a test can hold it.

What the model adds is the last mile: turning the list into something readable
at 8am, and drafting the message to the supplier. Most of the work here is not
AI, which is the point. The recipes are already read server-side by
`handleInventoryLog`, so the hard part — knowing what a batch consumes — is
done.

#### E. The weekly paragraph on `security/voids` and `security/unpaid`

The README records that these were write-only for as long as they existed:
recorded faithfully, readable from nowhere. They have a screen now, but a screen
nobody opens is the same problem with more steps.

Detection is statistics — voids per person per shift against that person's own
baseline, unpaid write-offs clustered in a shift. The model writes the sentence
that makes somebody look. Do not let it decide who is stealing; let it say
*"three voids in the last hour of Tuesday's close, all by the same PIN, which is
four times that PIN's usual rate"* and leave the conclusion to a human who knows
the person.

#### F. Review replies, if Google Business Profile lands

Drafted into the owner's queue. Never auto-posted.

### Where AI does not belong here

**The ETA and demand models.** This is the obvious thing to reach for and it
would be a regression. What exists is a fitted regression with hard coefficient
bounds, a 40% swing rejection, a 200-clean-order floor, a snapshot rollback in
`eta/modelPrevious`, a restore button in `analytics.html`, and an accuracy
report. That is a better-engineered system than a prompt, and — more
importantly — it is *auditable*: when the quoted wait moves from 25 minutes to
30, the owner can find out why. Replacing it would trade a system whose failures
`rcCheckGates` catches for one whose failures are a plausible number on a
customer's phone.

**On improving it with weather — a correction.** An earlier draft of this file
said the refit should fold in the rain signal, and called it a real accuracy
gain. That was wrong twice over, and the mistake is instructive enough to keep
rather than quietly delete.

`learnWeather` fits a **demand** multiplier: orders per day against what the
demand model predicted. `rcDerive` fits **wait times**. Rain changing how many
orders arrive is not rain changing how long a pizza takes, and the saturation
curve already carries "a busy kitchen is slower". So the gain was asserted, not
reasoned.

The second error was in the mechanics. The demand model is not stored anywhere —
`fitModel` runs in the browser on every analytics page load — so moving
`learnWeather` server-side means porting `fitModel`, `predictDay` and
`dailyTotals` too, and standing up a second demand model in the Worker that has
to agree with the page's. That is the same defect as the pizza list below, built
deliberately.

What is true is narrower: a multiplier fitted over months lives for one page
load in one browser, and nothing else can use it. That is worth fixing **when
something wants to read it** — the daily digest is the likely first customer —
and the shape should be decided by what that reader needs. Building the
publisher first fails `test/write-only.test.js`, which exists to catch exactly
this, and inventing a reader to get past that test is the tell.

**Anything in the money path.** Matching a credit to a bill, deciding whether an
order is paid, releasing food to be cooked. The design is *"nothing is made
before the money is confirmed"* with exactly two ways past it, both meaning a
person or the bank saw the money. A model is neither, and adding it as a third
would quietly undo the whole argument.

**Voice order entry at the till.** A cashier with a category strip is faster
than speech in a room with a grinder in it.

### The AI-shaped problem whose answer is a data field

Worth its own section, because it is the clearest example of the trap. **Half of
this has since been fixed** — the description is kept because the reasoning is
the point, and the remaining half is still worth doing.

`worker.js` decided what counts as a pizza by substring, against a literal of
its own, in **eight places** across the refit: the oven-idle attach, the
`pizzaBase` coefficient, and the `pizzaBaseAll: 120` volume gate that decides
whether a refit is attempted at all. Meanwhile `pos.html` and `index.html` asked
the same question of `eta/model.pizzaKeys` — a list in the database, editable
from `admin.html`, which the Worker neither read nor wrote.

Two pizza definitions that had to agree, with nothing checking that they did, and
the authoritative one was a literal inside the component that produces the model
the pages read.

Put a new pizza on the menu — *Diavola*, *Truffle & Honey* — and neither list
matched it. The till's failure was visible: it quoted the wrong prep time and
somebody noticed. The refit's failure was not — that order stopped contributing
to `pizzaBase`, stopped counting toward the 120-order minimum, and a refit
declined for want of volume that was sitting in the data. Nothing threw. The
Worker-health panel said nothing. It looked like a quiet quarter.

**What shipped.** `rcDerive` now takes the list and settles it before the
derivation asks anything, and the one call site passes `current.pizzaKeys` — the
live model, which was already being fetched a few lines above. The literal
survives as a fallback rather than being deleted, because a refit that cannot
read the model must not classify *nothing* as a pizza: that is the same silent
failure with the numbers moved. Which list was used is reported in the refit
summary, so `recalibrate-dryrun` says whether it read the model or the file.
`test/pizza-keys.test.js` drives the classifier and then checks the wiring,
because both ways of undoing it — dropping the argument, or pointing `rcIsPizza`
back at the literal — are silent.

**What has not shipped, and is still the better end state.** One list is not the
same as one source of truth. `pizzaKeys` is a keyword list, and a keyword list
is still a guess about a name. The menu item already carries `routing` (chef or
barista), set in `admin.html` and stored; `prepClass` belongs beside it, read
from the menu rather than inferred, with both keyword lists then deleted. The
temptation is to classify with a model. **The right answer is a field.**

Where a model genuinely helps: a **one-off** pass proposing `prepClass` for
every existing item, presented in `admin.html` for the owner to correct before
anything is written. The model as the first draft of a data migration — not as
the thing that runs every hour forever.

### What every AI feature ships with

Not optional extras; the same list the rest of this repo already holds itself
to.

- **A kill switch in `settings`**, readable from `admin.html`. The owner turns
  it off without a deploy, without a terminal, and without waiting for anyone.
- **A hard spend cap in the Worker**, reported through `reportIfItThrows` when
  it is hit, so a runaway shows up on the panel that already exists.
- **A degraded sentence, written first**, in the weather's voice. If you cannot
  write the sentence, the feature is not ready.
- **A test that the page works with the route unreachable**, in the shape of
  `worker-stall-browser.test.js`. A model call is slow enough that a missing
  timeout is not a theoretical bug — it is one a customer will find, and the
  failure is the one this codebase already knows best: connected, and nothing
  coming back.
- **Nothing a stranger wrote reaches a tool that writes.** The ordering
  assistant reads the menu and returns keys. That is the whole surface, and it
  should stay that whole surface.

### Calling the model

The Worker is where every call goes, for the same reason as everything in Part 1.
Two options, and the difference matters here more than usual:

**Cloudflare Workers AI** is a binding — `env.AI.run(...)` — with no API key at
all, running at the edge next to the Worker. For the small narration jobs (D, E,
and arguably A) it is the least new machinery: no secret to rotate, no new
vendor, nothing added to `worker.js`'s dependency surface.

**The Claude API** is the better answer where the writing quality is the
product — the daily digest (A), the extraction fallback (B), the ordering
assistant (C), and the one-off classification migration. Default to
`claude-opus-5` ($5/$25 per MTok, 1M context); `claude-haiku-4-5` ($1/$5, 200K)
is the deliberate trade if a specific route's volume makes it one.

Use the official SDK, `@anthropic-ai/sdk` — `wrangler` bundles it and it is
`fetch`-based, so it runs in a Worker unchanged. One consequence to weigh with
open eyes: **today `worker/worker.js` is one file, and the deployed script is
that file.** Adding a dependency makes the deployed script a bundle, and the
readable source and the running code stop being the same thing. That property is
load-bearing in this repo — the file is served publicly, the no-literal-secrets
test reads it, and `worker/README.md` treats "the only code not in a browser" as
something a person can sit down and read. The SDK is still the right default;
just decide that trade deliberately rather than discovering it after a deploy.
