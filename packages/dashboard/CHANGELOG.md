# @adonis-agora/payments-dashboard

## 0.2.0

### Minor Changes

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Seven things a real operator could not see once money was flowing. Each was found by asking a
  question of a running install and discovering the console had no way to answer it.

  **"Did THIS student's payment land?" had no answer.** `listPayments` returned
  `externalReference` — the app's own join key, the one id an operator actually holds — and the
  dashboard's payments handler dropped it before serialising, so the screen showed the gateway's
  `pay_…` instead. There was no lookup by reference or by gateway id anywhere: the handler filtered
  on `status`/`provider`, and so did the client. `PaymentListQuery` now carries
  `externalReference`, `gatewayId` and `customerId` (all EXACT — `order-4` must never return
  `order-42`), `GET <dashboard>/api/payments` takes `?reference=` / `?gatewayId=` / `?customerId=`,
  the row payload carries `externalReference` and `refundedAmount`, and the screen has one search
  box that tries the app's reference first and the gateway id second, because an operator pasting
  from a support ticket does not know which of the two they are holding.

  **There was no customers endpoint at all**, though `billing_customers` has held
  `owner_type`/`owner_id` — written by every app calling `ensureCustomer` — since the first
  release. That mapping is the only thing tying a payment to a person: the payment row carries
  `cus_…` and nothing else. `GET <dashboard>/api/customers` lists it with `ownerType`/`ownerId`/
  `gatewayId`/`provider` filters, the store gained `listCustomersByGatewayIds` so a page of payments
  resolves its owners in one read rather than one query per row, and every payment row now carries
  an `owner`. A gateway customer nobody mapped reads as **unmapped**, not as a blank — it means
  charges are landing that this console can never attribute.

  **No per-payment view, and the ledger could not be filtered.** `BillingListQuery` had no event
  `type`, so "did a refund event ever arrive?" was unaskable. It does now, and `GET /api/providers`
  reports the event types an install has actually received so the filter is built from data rather
  than from the twenty types the package can emit. `GET /api/payments/:gatewayId` assembles what IS
  knowable about one charge: current state, owner, the disputes filed against it, the ledger rows
  whose stored delivery names it, and who refunded it. **It is not a history, and it does not claim
  to be** — `billing_payments` is a single mutable row upserted in place, so what it used to be is
  recorded nowhere. The ledger strand is a `CAST(payload AS TEXT) LIKE` scan and says so on the wire
  (`events.matchedBy`) and on screen: it is unindexed, it can over-match, and it cannot see a
  delivery that never stored the id. No history table was invented. The honest fix is a
  `payment_gateway_id` column the **processor** fills on the way in, which is a write path this
  change does not touch.

  **The dispute-deadline check was structurally dead on a real install.** `disputes_due` was the
  only dispute check, and both reads behind it require `evidence_due_by IS NOT NULL` — a column that
  can only ever be filled by a gateway that publishes a deadline. On Asaas it comes from
  `chargeback.deadlineToSendDisputeDocuments`, which the driver's own comments note no published
  webhook example even contains. So a chargeback could be open with the money already pulled back
  and `payments:health` reported healthy. A new **`open_disputes`** check counts every unanswered
  dispute (`warning`, `open`, `under_review`) with no deadline required and **no threshold that can
  turn it off** — an open chargeback is money already out of the account, so there is no horizon at
  which it stops mattering. `BillingHealth` gained `openDisputes` (oldest first, because with no
  deadline, age is the only priority left) and the health panel names them.

  **A lost Asaas dispute could never be closed, so the alarm stayed red forever.** Asaas publishes
  no lost-dispute event and the driver hardcodes `outcome: 'won'` on close, so `billing_disputes`
  sat at `open` indefinitely; `listDisputesDueWithin` counts past-deadline rows on purpose, so the
  check stayed red and a fifteen-minute cron logged the same failure until nobody read it — burying
  every other finding with it. `POST <dashboard>/api/disputes/:gatewayId/resolve` records how a
  dispute ENDED: a finished status (`lost`/`won`/`expired`/`canceled`), an outcome, a note, and WHO
  said so. It sends nothing to a gateway, and the dialog says so twice: the decision was made at the
  bank, this writes down which way it went. There is still no "fight" and no "accept" — that is a
  business rule and it stays in the app's code.

  **A rejected delivery left no record and no check covered it.** A bad signature, an unparsable
  body or an unknown provider is answered `400` with nothing written anywhere, so a rotated webhook
  token was invisible: zero events, zero failures, every check green. `unconfirmed_payments`
  eventually fires at 2 h, but only for charges the app itself created — refund, chargeback and
  dispute-closure deliveries produce no pending payment and simply vanished. A new
  `billing_audit_events` table records them, a **`rejected_deliveries`** check counts them over 24 h,
  and `GET <dashboard>/api/audit` surfaces them. **The rejection itself happens in
  `providers/payments_provider.ts`, which this change does not touch: the endpoint must call
  `store.recordAuditEvent({ action: 'webhook.rejected', provider, message })` on each `400` path for
  the check to see anything.** Until it does, the store, the check and the screen are in place and
  the count is zero.

  **And a refund issued from the console left no audit trail.** The only record was a diagnostic
  carrying a gateway id, a provider and an amount — and no actor, even though the dashboard's own
  `enforce()` had already verified exactly who authorised the request. `enforce()` now returns that
  user, `Deps.actor` carries it per request, and a successful refund writes an audit row naming the
  person, the amount asked for and whether it was partial. A refund the gateway REFUSED writes
  nothing: an audit of refunds that never happened is an audit nobody can trust. A console with no
  `dashboardAuth` records `actor: null` — "unattributed", never an invented "system".

  `billing_audit_events` is a new TABLE, so it needs nothing from the schema module's post-ship
  ALTER phase: `CREATE TABLE IF NOT EXISTS` carries it to an existing install exactly as well as to a
  fresh one. An install that upgrades the package before running the migration keeps working — every
  audit write is additional to an action that already happened, so a missing table skips the note and
  answers `null` rather than failing a refund the gateway already accepted.

  The console gained two screens (**Customers** and **Activity**) and a per-payment detail view.
  1261 unit tests, 109 integration tests against real Postgres, 119 dashboard tests, typecheck and
  lint clean. Every fix proven by mutation, including the JSONB cast — `jsonb LIKE text` is not an
  operator in Postgres, and the in-memory store would have gone on passing without it.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add the **Disputes** screen to the billing console. `billing_disputes` had a full JSON API and no
  UI, so the one table in this package with a deadline was the one you could not see.

  A chargeback has a clock, and missing it loses the money **by default rather than on the merits**,
  so the screen leads with the clock rather than with the log. Two panels, in this order:

  - **Evidence windows closing** — `GET <api>/disputes?dueWithin=<hours>`: open disputes carrying a
    deadline, soonest first, deadline as the leading column. The countdown is in hours (`in 5 hours`),
    not days: rendering that as "today" is the difference between filing this morning and losing by
    default. The horizon picker opens on **72 h** — the same horizon `payments:health` alerts on, so
    the console and the cron agree about "soon" — and the count above the table is the server's
    unbounded `dueWithin.total`, not the page it happened to fit.
  - **All disputes** — the log, newest first, filterable by status and gateway.

  The work list is deliberately **not** filterable by gateway. It is the one list whose whole job is
  that nothing gets missed, and narrowing it to Stripe while an Asaas window shuts tonight is exactly
  the failure it exists to prevent.

  Three nullable facts are rendered as the things they mean, not as missing data:

  - a window **already past its deadline still appears**, marked `past due` with how long ago — it is
    still open and still unanswered, and going quiet the moment it expires reads as resolved;
  - a dispute with **no deadline** is absent from the work list and says _the gateway sends no
    deadline_ in the log, rather than showing a dash. Several gateways send no date, and Woovi's
    three-day rule is policy rather than a field;
  - a dispute with **no amount** (Stripe's early fraud warning carries none) says so instead of
    rendering `R$ 0,00`.

  `warning` does not look like a chargeback: nothing has been pulled back, a refund still prevents the
  debit, and the row says _no money moved_ in words rather than leaving it to a hue. The seven
  `DisputeStatus` values get their own hues, and an unmodelled gateway status falls back to grey
  rather than borrowing one.

  **The screen is read-only and stays that way.** No "fight this", no "accept", no "refund": whether
  contesting is worth it turns on margin, customer value, the dispute fee and the chargeback ratio
  that puts a merchant into a card network's monitoring programme. That is a business rule that lives
  in your app's code, and a console button invites someone to press it without any of that context.
  The JSON API has no action route for disputes, and a test asserts the client grows no method that
  implies one.

  Also in the console: the health panel's fourth check (`disputes_due`) now has somewhere to go — its
  button opens the Disputes screen on exactly the rows it counted — and the panel names **which**
  windows are closing, with gateway, dispute id and countdown, instead of only how many.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Turn the billing dashboard into a management console: health panel, subscriptions screen, gateway filter, and the first two actions.

  The console could tell you what happened; it could not tell you what needed doing, and it could not
  do anything about it. Four changes:

  - **A health panel at the top of the Overview**, above the revenue tiles. `billingHealth()` — the
    three silent failures of a billing install (events claimed and never finished, events the
    dispatcher gave up on, charges created that never confirmed) — existed only behind
    `node ace payments:health`. It is now `GET <path>/api/health` and the first thing on the page: a
    quiet green line when the install is clean, and when it is not, the count, what it means, which
    provider and event type is failing, and a link straight to those rows.
  - **A subscriptions screen** (`GET <path>/api/subscriptions`), defaulting to `past_due`, showing
    plan, customer, trial end and period end. `paused` is rendered as its own state with its own hue
    and an explicit "not billing" — a paused subscriber is not paying, and reading them as active
    grants access to someone who is not.
  - **A gateway filter** on payments, subscriptions and webhook events, built from
    `GET <path>/api/providers` — what your data actually contains, not the eighteen drivers the
    package ships. A filtered page reports when its scan stopped short rather than showing a
    confident empty result.
  - **Two actions**, the console's first writes. `POST <path>/api/payments/:gatewayId/refund`
    (optional partial amount, confirmed in the UI with the amount and the customer, refused before the
    call for a gateway with no refund API, reporting the gateway's own message when it refuses) and
    `POST <path>/api/webhook-events/:gatewayEventId/retry`, which re-runs a failed event through your
    own webhook handlers. Both are `POST` only and both run through the existing `authorize` guard and
    the `dashboardAuth` session.

  Also: the payments filter now offers `authorized` and `disputed` (both were reachable statuses with
  no way to filter for them), and the SPA's money formatter was aligned with `src/money.ts` — it was
  missing the three-decimal currencies entirely, so a KWD amount rendered 10× too large.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Revenue was reported gross with nothing saying so, and a partial refund was invisible in it.

  `billing_payments.refunded_amount` landed in the previous release precisely so a PARTIAL refund
  could be recorded without mangling `amount` or `status`: a R$10 refund on a R$100 charge leaves the
  row `paid` at `amount: 10000, refundedAmount: 1000`, and the net is one subtraction. But every
  aggregate went on summing `amount` alone. `revenue()` and `billingOverview`'s revenue metric counted
  that charge at its full R$100, the console printed it under the single word **Revenue**, and nothing
  on the screen admitted the number was gross. Money that had already gone back to the cardholder was
  being reported as earned.

  **`revenue()` is unchanged and still gross.** It was the only revenue figure this library had for
  two releases and apps read it; redefining it in a release that already carries breaking changes
  would have moved numbers on other people's screens with no error to announce it. Gross and net are
  both legitimate — gross is what you collected, net is what you kept — so the fix publishes both.

  **`store.netRevenue({ from, to })` is new**, on the `BillingStore` SPI and on BOTH implementations
  (`LucidBillingStore` and the `InMemoryBillingStore` in `/testing`). It takes exactly the rows and
  the window `revenue()` takes — `status = 'paid'`, windowed on `paid_at` — and sums
  `amount - COALESCE(refunded_amount, 0)` instead of `amount`. Integer minor units throughout, never a
  division. Two details it has to get right, both proven against real Postgres: `refunded_amount` is
  `NULL` on every row written before the column existed and `amount - NULL` is `NULL` in SQL, which
  `SUM` spreads across the whole window — so one legacy row would report zero net revenue for an
  install that took a million; and a `BIGINT` sum arrives from node-postgres as a **string**, so it is
  consumed through `Number` like every other amount in the store. On an install whose table predates
  the column, `netRevenue()` answers exactly what `revenue()` does, because no refund was ever
  recorded to subtract.

  **`billingOverview` now returns two money metrics**, `revenue` (label `Revenue, gross (cents)`) and
  `net_revenue` (label `Revenue, net of refunds (cents)`). The `revenue` key keeps its key, its
  position and its value; only its label gained the word "gross". If you render the metric list by
  key, add `net_revenue` to whatever you treat as money — a money metric rendered as a plain count is
  the figure wrong by 100×.

  **The console shows both**, as **Revenue (gross)** ("Paid payments settled in this window. Refunds
  NOT subtracted.") and **Revenue (net)** ("The same payments, minus what was refunded. This is what
  you kept."), each labelled in words so neither can be read as the other.

  Nothing else that reports money inherited the blindness: `billingHealth` and `payments:sync` report
  counts, not amounts, and the payments list and per-payment view already showed `refundedAmount`
  beside the charge. `meteredBill`'s `total` is a projected overage charge rather than settled
  revenue, so refunds do not apply to it.

- [#5](https://github.com/DavideCarvalho/adonis-agora-payments/pull/5) [`1db1891`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/1db1891cad2481c468169de8398ffb307befb01a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `@adonis-agora/payments-dashboard`, the billing console for `@adonis-agora/payments`.

  A React SPA (Vite + Tailwind + TanStack Query) with three read-only screens — an overview of
  `billingOverview()`'s revenue/subscription/usage aggregates over a selectable window, a payment list,
  and the webhook-event ledger that surfaces `failed` rows with the handler error that caused them.
  Everything is a `BillingStore` read; the console makes no gateway calls and has no control actions.

  The Adonis half ships inside `@adonis-agora/payments` and mirrors `@adonis-agora/durable`'s dashboard:
  a `dashboard_provider` that serves the built bundle from disk (never importing the SPA package), the
  `BASE_PLACEHOLDER` rewrite that lets one bundle mount at any path, framework-light JSON handlers, and
  the same optional `dashboardAuth` session gate. New entry points: `@adonis-agora/payments/dashboard`
  and `@adonis-agora/payments/dashboard_provider`, plus a published `config/payments_dashboard.ts`.

  The dashboard is off-able entirely (`enabled: false` registers no routes at all) and defaults to the
  same safe auth posture as the durable console: open outside production, and in production a bearer
  token equal to `PAYMENTS_DASHBOARD_TOKEN`, denying when it is unset.

  Also adds two narrow reads to the `BillingStore` contract — `listPayments(query)` and
  `listWebhookEvents(query)` — implemented in both `LucidBillingStore` and `InMemoryBillingStore`. They
  return a normalized plain shape rather than the implementation's row type, so a reader never depends
  on Lucid.

### Patch Changes

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The console's two actions now echo the host app's CSRF token

  The dashboard is mounted inside a host application, and an AdonisJS app running
  `@adonisjs/shield` guards every state-changing route with CSRF. The SPA sent no token, so
  `POST …/refund` and `POST …/webhook-events/:id/retry` were rejected before they reached the
  dashboard's own authorization — the button did nothing, and nothing on screen said why.

  Shield publishes the token as an `XSRF-TOKEN` cookie for exactly this purpose. Both POSTs
  now read it and send `x-xsrf-token`. No cookie means no header, which is the right answer
  for a host that does not run shield: an empty token would be worse than none.

  Reads are untouched — CSRF only guards mutations.
