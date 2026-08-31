# @adonis-agora/payments

## 0.6.0

### Minor Changes

- [#20](https://github.com/DavideCarvalho/adonis-agora-payments/pull/20) [`db19529`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/db195294515022e9d306141ebd2f556e98542e35) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `tokenizeCard` to the driver contract, implemented for Asaas.
  
  Asaas has no browser-side tokenization — no publishable key, so its
  `POST /creditCard/tokenizeCreditCard` authenticates with the account API key and the card
  number necessarily reaches the server. The contract accepted a card that was already
  tokenized (`CardInput.token`) and offered no way to obtain one, so every application built
  a transparent checkout by hand-rolling the same authenticated POST. One of them wrote it
  against `/creditCard/tokenize`, a path that does not exist: the endpoint 404s and every
  card checkout fails as "invalid card".
  
  - `PaymentsDriver.tokenizeCard?(input)` — optional, gated by the new
    `capabilities.cardTokenization`. A gateway that tokenizes in the browser (Stripe,
    Mercado Pago) or is a merchant of record (Polar, Dodo) declares it `false` and omits the
    method rather than inventing an endpoint.
  - New types `TokenizeCardInput` and `TokenizedCard` (`{ token, last4, brand, provider }`).
  - The Asaas provider docs claimed the card number "never touches your server". It does,
    for this gateway, and the page now says so along with the PCI consequence and the fact
    that tokenization needs activation on a production Asaas account.

## 0.5.0

### Minor Changes

- [#18](https://github.com/DavideCarvalho/adonis-agora-payments/pull/18) [`7513756`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/7513756cc6e85cf2b7763737da27bb7599d03878) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Dashboard: a refused page navigation now gets a real page instead of `{"error":"forbidden"}`.
  
  Opening the console without permission used to answer the browser with the same JSON the API
  gets. It now serves a built-in access-denied page in the console's own visual language — the
  status, a sentence explaining the refusal, a "Back to app" link and, when `dashboardAuth.login`
  is configured, a "Sign in" button. The Mode-A-only "Open this console from your application."
  notice uses the same page. API requests are unchanged (the SPA still relies on their JSON), and
  an `authorize` hook that redirects still wins.
  
  The page carries no inline `<script>`, so a nonce'd `script-src` CSP cannot break it; its inline
  `<style>` takes `@adonisjs/shield`'s request nonce when one exists.
  
  New `accessDenied` option on `config/payments_dashboard.ts` to customise it — an object
  (`brand`, `title`, `message`, `homeHref`, `loginHref`, `accent`, labels) to tweak the built-in
  page, or a function `(info, ctx) => html | void` to render it yourself or redirect.
  
  Also: the built-in `dashboardAuth` login page no longer dies under a nonce'd CSP. It is now a real
  HTML form that works without JavaScript — a form submit is answered with a redirect (to the page
  the operator came from, or back to the form with the error shown) while the page's own `fetch`
  keeps getting JSON — and its inline script/style carry `@adonisjs/shield`'s request nonce.
  `renderLoginPage` takes an optional `{ nonce, error, returnTo }`.

## 0.4.1

### Patch Changes

- [#14](https://github.com/DavideCarvalho/adonis-agora-payments/pull/14) [`3a885c4`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/3a885c478dec80ca1b112e318ec3890b6a1bd77c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Dashboard: survives a strict CSP, fits on a phone, has URLs, and no longer links to a 404.
  
  - **Every API request 404 under a nonce CSP — fixed.** The provider used to hand the SPA its
    mount/API base as an inline `<script>` setting `window.__PAYMENTS_*__`. A host with
    `script-src 'self' 'nonce-…'` (`@adonisjs/shield`'s `@nonce`) drops that script silently; the SPA
    then fell back to `/payments-dashboard/api` and every request from a console that rendered fine
    answered 404. The config now travels as a `<script type="application/json">` data block, which
    is never executed and so cannot be refused. Nothing to change on the host. The globals are still
    honoured as a fallback for tests/embedding.
  
  - **Hash routes.** The current screen lives in the URL fragment (`#/webhooks`,
    `#/webhooks?status=failed`, `#/payments?customer=cus_…`, `#/payments/<gatewayId>` for one payment
    open in full), so the back button works, a reload comes back to the same screen, and a view can be
    pasted into a ticket. The health panel's buttons write the same hashes they used to set in state.
    A fragment rather than a path because the provider deliberately registers no SPA catch-all.
  - **Mobile.** Every pill row (the tab bar, the status filters) scrolls sideways instead of pushing
    the page wider than the viewport; the detail and confirm dialogs no longer overflow on a long
    gateway id; tighter page padding under `sm`.
  - **Sign out only where it can work.** The config block now carries the auth surface
    (`auth: { modes } | null`), and the SPA shows the Sign out link only
    when `dashboardAuth` is configured — that is the only configuration that registers
    `<path>/logout`; on every other deployment the link was a 404 one click away.
  - **Favicon.** Inline SVG icon, so the browser's automatic `/favicon.ico` probe stops 404ing in the
    host app's log.
  
  `renderIndexHtml` gains an optional fifth argument (`InjectedAuth`) and now emits the JSON block instead of the globals; `CONFIG_ELEMENT_ID`/`InjectedConfig` are exported. Existing callers are unaffected.

## 0.4.0

### Minor Changes

- [#11](https://github.com/DavideCarvalho/adonis-agora-payments/pull/11) [`7702f90`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/7702f90a239a8062b940edf797e2c65fa962a5c4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stripe SDK 19–22 accepted as a peer (`^17 || ^18 || ^19 || ^20 || ^21 || ^22`)
  
  Stripe 22 widened `Invoice.Status` with an open string member, so the driver now maps invoice
  statuses explicitly: the known ones pass through, an unknown one falls back to `draft` — the
  same default a missing status already had. Nothing narrows for apps still on 17 or 18.
  
  The dashboard is rebuilt on Tailwind 4, React 19 and Vite 8 — same tokens and layout.

### Patch Changes

- [#9](https://github.com/DavideCarvalho/adonis-agora-payments/pull/9) [`01d5a0c`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/01d5a0c2f6453dd8db7d162cf500b2dae635ae74) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Docs describe how the library works, not how it got there
  
  Roughly sixty passages across thirty-four pages narrated the library's own bug history —
  "it used to answer `200`", "the driver used to divide by 100", "this used to be the silent
  default". That belongs in a changelog. A reader arriving at a provider page wants the rule
  that holds now; the fix that produced it is noise, and it makes a stable library read like a
  list of things that were once broken.
  
  Every one is rewritten to state present behaviour, keeping the reasoning that made it the
  right behaviour — the *why* survives, the *when* goes.
  
  Ten provider pages also carried a "Not yet run against a live account" warning. Those are
  gone.

## 0.3.0

### Minor Changes

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add an Adyen driver — `payments.adyen({ apiKey, merchantAccount, currency })`, on Adyen's Checkout
  API v71 over REST with no SDK dependency.

  Stored-token card charges (`paymentMethod.type: 'scheme'`), Pay by Link for hosted checkout, and
  refunds: `supportedMethods` is `credit_card` and `undefined`, `capabilities` is
  `{ refunds: true, invoices: false, subscriptions: false }`. The API key travels as `X-API-Key`;
  `currency` and `merchantAccount` are both required and checked at boot. Live traffic goes to a
  per-customer host (`https://{prefix}-checkout-live.adyenpayments.com/checkout/v71`), so booting live
  without `liveUrlPrefix` fails at boot rather than as a DNS error on the first charge. Adyen's money
  is already an integer in the currency's minor units, so nothing is converted in either direction.

  `externalReference` is **required** on `charge` and `createCheckout`: it becomes Adyen's `reference`,
  which every webhook echoes as `merchantReference` — the routing key, and one of the eight fields the
  HMAC covers.

  **Webhook verification is pinned to Adyen's own test vector.** The signature is HMAC-SHA256, base64,
  over `pspReference:originalReference:merchantAccountCode:merchantReference:amount.value:amount.currency:eventCode:success`
  under the **hex-decoded** Customer Area key, and it arrives in `additionalData.hmacSignature`. Two
  things are easy to get subtly wrong and both are covered by tests: signing with the key's characters
  instead of its bytes, and escaping `:` as `\:`. The escaping rule belongs to Adyen's classic
  HPP/dictionary signature — Adyen's own Node, PHP, Java and Python libraries all join the eight
  webhook fields unescaped, and so does this driver, so a `merchantReference` containing a colon
  verifies instead of being rejected as a forgery. Set `hmacKey` and verification is mandatory; leave
  it unset and it is skipped, so local development works without Customer Area setup.

  Adyen batches notifications in a `notificationItems` array while `parseWebhook` returns one event.
  JSON/HTTP POST webhooks send one item per request, but if more arrive the driver **throws** instead
  of handling the first and silently dropping a capture or a refund. Note also that Adyen's docs ask
  for a `200` whose body is `[accepted]`, while the package's mounted `/payments/webhook/:provider`
  route answers `200 {"received": true}` — current Adyen docs accept any `2xx`, but mount your own
  route if your account requires the literal body.

  **What it refuses, because Adyen has no endpoint behind it:** every customer operation (Adyen has no
  customer resource — `shopperReference` is a string you invent); `findPayment` (Checkout v71 has no
  read-back by `pspReference`); `refund` with no amount (Adyen requires one and the payment cannot be
  read back to infer a full refund); all four subscription methods (Adyen has no subscription
  resource — recurring billing is you charging a stored token on your own schedule); `listInvoices`; a
  charge with no payment method; and `split`, which Adyen expresses as absolute amounts against
  balance accounts.

  `idempotencyKey` is sent as Adyen's `Idempotency-Key` request header on `charge` and
  `createCheckout` — the only thing Adyen deduplicates on, and it never echoes the key back on the
  response.

  One documented ambiguity: `resultCode: 'Authorised'` maps to `paid` because Adyen captures
  automatically by default, but on a manual-capture account it means only that the funds are held. The
  API reference does not expose which mode an account is in, so the driver cannot tell — treat `paid`
  from `charge()` as "authorised" and let the `CAPTURE` webhook be settlement.

  Written against Adyen's published Checkout v71 reference and covered by unit tests; it has not been
  exercised against a live Adyen account. Verify against `checkout-test.adyen.com` before taking real
  money.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Adyen's `NOTIFICATION_OF_CHARGEBACK` was moving a paid payment to `disputed` before Adyen had taken
  anything.

  Adyen's webhook reference is explicit about which dispute events withdraw funds, and three of them
  do not: `NOTIFICATION_OF_FRAUD` (the issuer's TC40/SAFE alert), `REQUEST_FOR_INFORMATION` (the scheme
  asking a question) and `NOTIFICATION_OF_CHARGEBACK` (a chargeback announced, not yet taken). The
  driver mapped the third to `payment.disputed`, so the payment row stopped saying `paid` over money
  still sitting in the account. All three are now **`payment.dispute_warning`**.

  `NOTIFICATION_OF_CHARGEBACK` is also the only event carrying `additionalData.defensePeriodEndsAt` —
  the deadline that makes a dispute actionable at all. It now comes through as `actionableUntil` on the
  normalized event, alongside the dispute's own `pspReference` as `disputeId`. Flattening the event
  into one with no room for a deadline was throwing that field away.

  `CHARGEBACK` — the debit itself — stays `payment.disputed`, and stands alone rather than assuming a
  notification came first: an ACH return goes straight there with no warning and cannot be defended.

  **The resolution is now named.** `CHARGEBACK_REVERSED` and `PREARBITRATION_WON` close a dispute as
  `won`; `SECOND_CHARGEBACK` and `PREARBITRATION_LOST` close it as `lost`.
  `DISPUTE_DEFENSE_PERIOD_ENDED` means "expired or liability accepted" and the event code does not say
  which, so the driver reads `additionalData.disputeStatus` — `Won` → `won`, `Lost` / `Accepted` /
  `Undefended` → `lost`, `Expired` → `expired` — and stays a `payment.updated` when it recognizes
  nothing, rather than reporting a loss that might be a win. `INFORMATION_SUPPLIED` is a
  `payment.updated`: movement inside an open dispute, not a resolution.

  Adyen does not treat `CHARGEBACK_REVERSED` as final — pre-arbitration can follow with a second close
  carrying the opposite outcome. It is reported anyway, because the alternative was emitting nothing
  for a successful defense.

  **If you have a handler on `payment.disputed`,** it no longer fires for a notification of chargeback.
  That is the fix; add `payment.dispute_warning` if you were relying on hearing about the defense
  period there.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **A webhook delivery can carry more than one event, and now it is processed as one.**

  Two gateways put a list in the delivery envelope — Adyen's `notificationItems` and Efí's
  `pix` — while `parseWebhook` returned exactly one `WebhookEvent`. Both drivers refused a
  batch loudly rather than processing the first and dropping the rest, which was the safe half
  of the answer and lost every entry in the batch. The contract now carries what the envelope
  carries.

  **`PaymentsDriver.parseWebhook` returns `WebhookEvent | WebhookEvent[]`** (still optionally a
  promise). This is a widening, not a migration: every other driver keeps returning a single
  event and the union lets it. A driver whose gateway sends one event per request should keep
  returning one — an array of length one adds nothing and reads as if batching were possible.
  Only an implementation that _reads_ the result needs updating; the mounted route accepts
  either shape.

  **Adyen verifies the HMAC per notification item.** Adyen's signature lives inside each item's
  own `additionalData.hmacSignature` and nothing signs the envelope, so the driver verifies
  _every_ item before mapping _any_ of them: verifying the first and trusting the rest is a
  replay hole where an attacker appends whatever they like beside one genuine notification. One
  bad signature rejects the whole delivery with `400`. Adyen documents that JSON and HTTP POST
  webhooks carry a single item (only legacy SOAP batches, up to six), so in practice this stays
  one event — the array is simply no longer truncated to its first entry.

  **Efí returns one event per Pix**, each keyed on its own `endToEndId`. Efí's reference shows
  one entry per notification and never states a maximum; the shape is a list either way.

  **The mounted route loops, and every event gets its own ledger row.** Idempotency is keyed on
  the gateway event id, so four events in one delivery are four rows, four
  `webhook.received`/`processed`/`failed` triples on the diagnostics bus, and a redelivery
  where three were already processed runs only the fourth. The whole delivery shares one
  `traceId` — the trace answers "what happened to this HTTP request", and losing the fact that
  these four arrived together would be the one thing a batch makes worth knowing. Each event's
  `raw` is the envelope narrowed to its own item, so a ledger row can still say which
  notification it is about and remains replayable by the dashboard.

  **Behavior change: a delivery whose processing failed now answers `500`, not `200`.** When an
  event throws, its siblings are still attempted — they are different payments, and refusing
  them because a neighbour failed loses money for a reason unrelated to them — and the response
  then reports the failure:

  ```json
  { "received": true, "processed": 3, "failed": ["evt_2"], "error": "..." }
  ```

  A `2xx` promises the gateway it never has to send that delivery again, which over a failed
  event is the payment lost for good. Previously the in-process dispatcher swallowed the error
  and answered `200`, leaving the event to a background retry that dies with the process; the
  gateway's own redelivery is the only durable retry there is, and it only starts on a non-2xx
  (Adyen queues one for up to 30 days, Efí makes up to 9 attempts). Both retries now run, and
  the ledger keeps that safe — whichever attempt claims the `failed` row first does the work
  and the other short-circuits. **If you alert on 5xx from `/payments/webhook/:provider`, that
  alert will now fire on a failing handler where it previously stayed silent.** A rejected
  delivery — bad signature, unparsable body, unknown provider — is unchanged at `400`, since
  redelivering it would fail identically.

- [#5](https://github.com/DavideCarvalho/adonis-agora-payments/pull/5) [`1db1891`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/1db1891cad2481c468169de8398ffb307befb01a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The billing store answers the operational questions, and two bugs that only a real database could
  show are fixed.

  **Every insert failed on Postgres.** The published migration declares `uuid('id')` with no
  database-side default and the four billing models never assigned one, so `billing_payments`,
  `billing_subscriptions`, `billing_webhook_events` and `billing_usage_events` all rejected every
  insert with `null value in column "id" violates not-null constraint` — the idempotency ledger
  included, which is the first write of every webhook. Fixed with a `@beforeCreate()` hook that
  generates the uuid on the model: it works on every dialect (unlike `gen_random_uuid()`) and needs no
  new migration.

  **Every aggregate returned zero.** A Lucid model query hydrates rows into model instances, and a
  value with no matching column — `count(*) as total` — goes into `$extras`, not onto the instance. So
  `rows[0].total` was `undefined`, `Number(undefined ?? 0)` returned a confident `0`, and `revenue()`
  and `countActiveSubscriptions()` reported zero against any real database. Every aggregate query now
  goes through `.pojo()`.

  Both were invisible to the existing suite, which only ever exercised the in-memory store. There is
  now an integration suite (`pnpm test:integration`) that runs against a throwaway Postgres via
  testcontainers, on the **real published migration stub** rather than a copy of the schema.

  New reads on `BillingStore`, so nothing has to reach around it into the tables:
  `findWebhookEventByGatewayEventId(id)`, `countPayments(query)`, `countWebhookEvents(query)` and
  `webhookEventBreakdown(query)`, filtered by `status` and a `createdBefore`/`createdAfter` window.

  New `billingHealth(store)` and `node ace payments:health` report the three silent failures of a
  billing install — events claimed and never finished, events the dispatcher gave up on, and charges
  created that never confirmed. The command exits non-zero when any is non-zero, so a scheduler can
  page on it.

  `payments:sync` now uses the **configured** store rather than always constructing a Lucid one (an app
  with a custom `billing.store` had its reconcile write somewhere the rest of the billing layer never
  reads), no longer reports an unreadable `billing_customers` as "empty", and no longer imports the
  database service at module scope.

- [#5](https://github.com/DavideCarvalho/adonis-agora-payments/pull/5) [`1db1891`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/1db1891cad2481c468169de8398ffb307befb01a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `billing.role` splits the deployment into an api half and a worker half, and `billing.dispatcher` is
  finally read.

  `dispatcher` was declared in the config and **never consulted** — the provider resolved the backend
  from the legacy `billing.durable` boolean alias only, which cannot express `'queue'` at all. So
  `dispatcher: 'queue'` and `dispatcher: 'durable'` were silent no-ops. `dispatcher` is now read first,
  with the alias kept as the fallback.

  `billing.role` is `'all'` (default), `'api'` or `'worker'`. A `'worker'` process does not mount
  `/payments/webhook/:provider` — it consumes what the api half enqueued. An `'api'` process skips
  resolving app handlers, because they run on the worker.

  Splitting requires a channel between the halves, so `'api'`/`'worker'` demand an explicit
  `dispatcher` of `'durable'` or `'queue'`. `'in-process'` calls the processor inline and `'auto'` can
  silently resolve to it, so both are refused at boot rather than producing a deployment where the api
  half quietly processes everything and the worker sits idle.

  `CheckoutSession` also now declares `pixCode`/`pixCopiaECola`. Three drivers were already writing the
  field onto it; it only survived typecheck because a conditional spread bypasses the excess-property
  check, so the value was undiscoverable from the type.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Mercado Pago now closes a dispute and carries its deadline; Pagar.me, PagBank and InfinitePay say
  plainly what they cannot report.

  **Mercado Pago — a chargeback that ends now ends in the ledger.** `charged_back` collapsed into
  `payment.disputed` whatever `status_detail` said, so a dispute the seller _won_ sat at `disputed`
  forever — and `revenue()` sums rows that say `paid`, so it wrote off money that had come back.
  `status_detail` is Mercado Pago's own outcome: `reimbursed` is _"decision in favor of the seller,
  money refunded to the seller's account"_ and now closes the dispute as **`won`** (which moves the row
  back to `paid`); `settled` is _"decision against the seller, money withdrawn"_ and closes it as
  **`lost`**. `in_process` — and any detail the driver does not recognize — stays `payment.disputed`,
  because an open dispute has no result to report. `in_mediation` is unchanged.

  **The evidence deadline was there and unread.** It lives on the chargeback _case_, not on the
  payment, so a `topic_chargebacks_wh` notification now also fetches `GET /v1/chargebacks/{data.id}`
  and carries `date_documentation_deadline` as **`actionableUntil`**, the case's `reason`, and the case
  id as `disputeId`. That second call fails soft: the money question is already answered by the
  payment, and throwing would turn a chargeback the driver read correctly into a 400 and a redelivery.

  Mercado Pago publishes no pre-dispute alert — the first thing you hear is the chargeback — so no
  `payment.dispute_warning` is emitted, and `topic_claims_integration_wh` stays unmapped because its
  `data.id` is a claim id with no payment beside it. Whether funds move when a chargeback opens or only
  when it settles is not stated in the reference; the mapping was left where it was rather than
  downgraded on a guess, and that is now written on the provider page.

  **Pagar.me — `chargeback.received` is still not mapped, and now that is a documented decision.**
  `charge.chargedback` is deprecated with a migration deadline of **2026-09-30**, and its replacement
  exists in Pagar.me's event list with a one-sentence description and no published payload, no example
  and no field list. Mapping it on the guess that `data` is a dispute object would file
  `payment.disputed` against an id that may be the dispute's rather than the charge's. It now passes
  through **untouched** instead of being run through the charge mapper, which was fabricating a
  `{ gatewayId: '', amount: 0 }` for any handler registered on it. `charge.chargedback` →
  `payment.disputed` is unchanged. Pagar.me's dispute lifecycle and its `responseDeadline` live in the
  separate Disputes API, which is not on the driver contract — so there is no `actionableUntil` and no
  `payment.dispute_closed` for this gateway, and the provider page says so.

  **PagBank and InfinitePay have no dispute vocabulary to map.** PagBank's Orders API has no chargeback
  status: a chargeback is the legacy form-encoded `notificationType=transaction` notification (status
  9, "Retenção temporária"), a different API with different credentials that the driver already refuses
  loudly. InfinitePay documents one webhook, fired only on approval, and no dispute resource at all —
  contested sales are handled in the app, so the first you hear of one is the debit. Both are now
  pinned by tests asserting no dispute type can be emitted, and stated on their provider pages rather
  than left for the reader to discover.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Adopt the widened payments contract in the Brazil/LatAm drivers — Asaas, AbacatePay,
  Pagar.me, PagBank and Mercado Pago.

  **Chargebacks stop being invisible.** `payment.disputed` is a canonical event now, and each
  of these gateways gets its dispute-opening event mapped onto it: Asaas
  `PAYMENT_CHARGEBACK_REQUESTED`, AbacatePay `checkout.disputed` / `transparent.disputed`,
  Pagar.me `charge.chargedback`, and Mercado Pago's `topic_chargebacks_wh` topic plus the
  `charged_back` / `in_mediation` payment statuses. Three of those were previously reported
  as something else and were actively wrong: AbacatePay's disputes arrived as
  `payment.failed` (a chargeback filed as a payment that never happened) and Mercado Pago's
  as `payment.refunded` (indistinguishable from a refund the seller chose to make). The later
  steps of a dispute stay `payment.updated`: the contract deliberately has no resolution
  event, because no two gateways report one the same way.

  **PagBank has no dispute event to map**, and its docs page now says so plainly. A PagBank
  chargeback arrives only as a legacy form-encoded `notificationType=transaction`
  notification (transaction status 9, "Retenção temporária"), resolved against the v3 XML API
  with legacy credentials — a different API this driver does not speak, and refuses rather
  than half-parses.

  **`authorized` is told apart from paid and from pending** wherever the gateway separates
  authorization from capture: Asaas `AUTHORIZED` (`authorizeOnly: true`), PagBank
  `AUTHORIZED` ("pré-autorizada"), Mercado Pago `authorized` / `pending_capture`, and
  Pagar.me — which has no `authorized` charge status at all, so the driver reads
  `last_transaction.status === 'authorized_pending_capture'` behind a charge that still says
  `pending`. Previously all of these collapsed into `pending`, understating a hold the issuer
  had already granted.

  **Mercado Pago's `paused` preapprovals** map to `paused` instead of `past_due`. Billing has
  stopped and the subscription is alive; nothing failed, and it must not entitle the payer.

  **Idempotency is honoured where the gateway documents it and refused where it does not.**
  Mercado Pago's `refund()` now takes the caller's key instead of always generating one (the
  random fallback stays for callers who pass none — a key derived from the payment id would
  collapse two deliberate partial refunds into one). PagBank's `refund()` sends
  `x-idempotency-key`. Pagar.me's `charge()` sends the `Idempotency-key` header its docs
  specify for order creation, which is new — the key previously only doubled as the order
  `code`. Everywhere else the key is **refused with a clear error** rather than accepted and
  dropped: Asaas and AbacatePay document no idempotency mechanism at all, Pagar.me documents
  one only for `POST /orders`, and Mercado Pago only for payments and refunds. Silently
  dropping a key turns a caller's retry guarantee into a second refund.

  **PagBank's `listInvoices` throws** instead of returning `[]`. `capabilities.invoices` is
  false, the Orders API has no invoice resource, and `GET /orders` accepts only `charge_id` —
  an empty array said "this customer has no invoices", which PagBank never told us.

  No `supportedMethods` changed: pix, boleto and card are named categories already, and the
  new `wallet` / `bank_transfer` / `bank_debit` / `upi` / `bnpl` / `voucher` entries describe
  nothing these five gateways produce from `charge()`.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The Brazil-first gateways get the dispute vocabulary — and for two of them the answer was that
  their reference does not have one.

  **Asaas closes a won dispute.** `PAYMENT_AWAITING_CHARGEBACK_REVERSAL` is documented as "Disputa
  vencida, aguardando repasse da adquirente" — Asaas' own English wording is "Dispute won, awaiting
  acquirer settlement" — and it was being flattened into a `payment.updated`, so a successful defense
  reached nobody and the row stayed at `disputed` while the money was coming back. It is now a
  **`payment.dispute_closed` with outcome `won`**, and the payment status map follows it:
  `AWAITING_CHARGEBACK_REVERSAL` reads as `paid` rather than `disputed`, so `findPayment` and the
  webhook stop describing the same gateway state two different ways. `PAYMENT_CHARGEBACK_DISPUTE`
  stays a `payment.updated` — documents submitted is movement inside an open dispute, not a
  resolution.

  **Asaas' deadline was sitting unread.** The payment's `chargeback` object carries
  `deadlineToSendDisputeDocuments`, the only response deadline Asaas publishes anywhere; it now comes
  through as `actionableUntil`, with `chargeback.id` as `disputeId` and `chargeback.reason` as
  `reason`. Every field is read defensively: Asaas' webhook reference points at the
  `GET /payments/{id}` schema for the notification's payment object, where `chargeback` lives, but no
  published example shows it — an absent one is an event without a deadline, never a malformed one.

  `PAYMENT_CHARGEBACK_REQUESTED` **stays** `payment.disputed`. Asaas does not publish when the balance
  is actually debited — its developer reference says nothing about the money, and its help centre
  describes the debit as happening on a LOSS while also describing a win as the value _returning_ to
  the balance. The chargeback has been filed either way, so the mapping stands and the ambiguity is
  written down on the docs page instead of guessed at. Asaas also sends no dispute-lost webhook and no
  pre-chargeback warning of any kind; both absences are now documented and pinned by a test.

  **Efí: a Pix cannot be charged back, but it can be taken back.** BACEN's MED (_Mecanismo Especial de
  Devolução_) returns money to a payer who reported fraud, and it arrives on the Pix webhook this
  driver already parses — as an ordinary `devolução`, distinguished from a refund you made only by its
  `natureza`. The driver was calling it `payment.refunded`, which says the merchant chose to give the
  money back: the one thing that did not happen. A `devolução` whose `natureza` is `MED_FRAUDE`,
  `MED_OPERACIONAL` or `MED_PIX_AUTOMATICO` is now **`payment.disputed`** when it is `DEVOLVIDO` and
  **`payment.dispute_warning`** while it is `EM_PROCESSAMENTO`; `NAO_REALIZADO` took nothing and stays
  out of the dispute vocabulary, and `ORIGINAL`/`RETIRADA`/absent are still your refund. `findPayment`
  agrees: a charge settled by a Pix that was MED-returned reads back as `disputed`. Efí sends no
  notification when a MED is _opened_ and its devolução object has no deadline field, so no
  `actionableUntil` is invented.

  **Woovi maps all four dispute events.** `OPENPIX:DISPUTE_CREATED` is a **`payment.dispute_warning`**,
  not a `payment.disputed`: Woovi documents that the balance is _blocked_ while a MED is analysed, and
  a block is not a withdrawal. `DISPUTE_REJECTED` closes it as `won`, `DISPUTE_ACCEPTED` as `lost`,
  `DISPUTE_CANCELED` as `canceled` — meanings that come from Woovi's help centre rather than its API
  reference, which is said plainly on the docs page. A dispute payload names the Pix and nothing else,
  so `gatewayId` on these events is the **`endToEndId`**, and `OPENPIX:CHARGE_COMPLETED` now carries
  `metadata.endToEndId` so an app can store the link and join the two.

  **Woovi also matched none of its own event names.** Real payloads are prefixed —
  `OPENPIX:CHARGE_COMPLETED`, not `CHARGE_COMPLETED` — and the driver's map was written against the
  bare names, so a live webhook fell through as an unrecognized event and the payment was ledgered
  without ever being synced. Both spellings are accepted now.

  **AbacatePay has no dispute vocabulary beyond "opened", and none was invented.** `checkout.disputed`
  and `transparent.disputed` stay `payment.disputed`; its published event list has nothing before a
  dispute and nothing after it, so there is no warning to map and no outcome to report, and its
  reference says neither whether the funds are withdrawn nor what the deadline to respond is. The
  driver says so in a comment, the docs page says so in a callout, and a test keeps a later edit from
  inventing either event.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Chargebacks, held funds and retry keys in the five card-first gateways** — Stripe, Adyen,
  Square, Razorpay and PayPal now use the words the shared contract grew, and refuse where a
  gateway cannot keep the promise.

  **Stripe's webhooks are normalized at all.** The driver passed `event.type` and the raw
  Stripe object straight through, and the processor switches on the canonical names — so it
  recognized _nothing_ Stripe sent: every event was ledgered as processed and
  `billing_payments` stayed empty. A chargeback cannot move a row that was never written, so
  this is where the dispute work had to start. `payment_intent.*`, `charge.refunded`,
  `charge.dispute.*`, `checkout.session.*` and `customer.subscription.*` now map onto the
  canonical types; everything else still passes through under its Stripe name with the raw
  object as `event.data`. **This is a behavior change for existing Stripe handlers**: one
  registered on `'payment_intent.succeeded'` should now be registered on `'payment.succeeded'`.
  A rename only happens when the canonical payload can actually be built — the built-in
  handlers throw on a malformed payload, and a throw inside the webhook route is a 500 Stripe
  retries forever.

  **`payment.disputed` is mapped in all five.** Only the opening event, in every case; the
  resolution — won, lost, funds withdrawn, evidence filed — stays `payment.updated`, because a
  canonical type no driver emits is worse than none.

  - **Stripe** — `charge.dispute.created`, keyed on the PaymentIntent (`payment_intent` is
    nullable on the Dispute object, so the charge id is the fallback).
  - **Adyen** — `NOTIFICATION_OF_CHARGEBACK` **and** `CHARGEBACK`. Both, because an ACH return
    goes straight to `CHARGEBACK` with no notification and cannot be defended at all — mapping
    only the notification would miss exactly the disputes nobody can fight.
    `REQUEST_FOR_INFORMATION` and `NOTIFICATION_OF_FRAUD` deliberately stay updates: no money
    moves on either, and treating them as chargebacks would take a live payment away over a
    question.
  - **Square** — `dispute.created`, keyed on `disputed_payment.payment_id` (nested, not a
    top-level field).
  - **Razorpay** — `payment.dispute.created`, keyed on `dispute.payment_id` with the
    **disputed** amount, not the charged one.
  - **PayPal** — `CUSTOMER.DISPUTE.CREATED` (and the deprecated `RISK.DISPUTE.CREATED`), keyed
    on `seller_transaction_id` — the capture id; `buyer_transaction_id` would find no row.

  **`authorized` — funds held, money not moved.**

  - **Stripe** `requires_capture` was falling through to **`failed`**: a live authorization
    reported as a dead payment. It is `authorized`, and `requires_confirmation` — which fell
    there with it — is `pending`.
  - **Razorpay** `authorized` was `pending` by a documented decision, taken when nothing better
    existed. It is `authorized` now. The `payment.authorized` webhook stays `payment.updated`:
    there is no canonical authorized event, and settling on it would report an order the
    merchant has not been paid for.
  - **Square** `APPROVED` was `pending` — the status of a payment nobody has attempted, for one
    whose money is reserved with a clock against it.
  - **Adyen** gains a **`captureMode`** option, because `Authorised` means two different things
    and the Checkout API will not say which: `captureDelay` is a Management API field and both
    modes answer `/payments` identically. With `'automatic'` (the default, and Adyen's) the
    capture follows on its own and **no CAPTURE webhook is sent**, so `Authorised` is `paid`
    and `AUTHORISATION` is `payment.succeeded`. With `'manual'` it is `authorized`,
    `AUTHORISATION` is only an update, and `CAPTURE` is what settles it.
  - **PayPal** creates `intent: 'CAPTURE'` orders, so it produces no held authorization of its
    own; `PAYMENT.AUTHORIZATION.CREATED`/`.VOIDED` are now recognized as updates carrying
    `status: 'authorized'` instead of falling through as unknown.

  **`paused` no longer entitles anyone.** Stripe's `paused` mapped to **`active`**, which
  granted access to a subscriber nobody is billing. Square's `PAUSED`, Razorpay's `paused` and
  PayPal's `SUSPENDED` mapped to `past_due`, which said the subscriber owed money they did not.
  All four say `paused`.

  **Idempotency reaches the calls that grew a key — or throws.**

  - **Stripe** sends `Idempotency-Key` on `refund`, `createCustomer`, `createSubscription` and
    `updateSubscription` as well as the two it already had. Stripe accepts it on every POST, so
    nothing here has to refuse.
  - **Square**'s key is a body field, and `refund`, `createCustomer` and `createSubscription`
    were generating a UUID and dropping yours — which made Square's own retry safe and a
    retried **job** double-refund. `updateSubscription` **throws**: neither the PUT nor
    `swap-plan` takes one.
  - **Adyen** sends `Idempotency-Key` on `refund` too, capped at the documented 64 characters.
  - **PayPal** sends `PayPal-Request-Id` on `refund` and `createSubscription`; every site now
    goes through one guard capping the key at the 38 characters PayPal's own guidance names.
    `updateSubscription` **throws** — `PATCH /v1/billing/subscriptions/{id}` documents no such
    header.
  - **Razorpay** has no general idempotency header at all. `refund` honours the one mechanism
    that exists — **`X-Refund-Idempotency`**, validated (≥10 chars, `[A-Za-z0-9_-]`) before the
    round trip, because a key Razorpay rejects is a key that does not deduplicate.
    `createCustomer`, `createSubscription` and `updateSubscription` **throw**: dropping a key
    there would turn a retry into a second customer, or a second live subscription billing the
    same person every month.

  **Payment methods are named by category.**

  - **Square** widens `supportedMethods` to `wallet`, `bank_debit` and `bnpl` alongside the
    card pair: the Web Payments SDK mints Cash App, ACH and Afterpay tokens, and they all reach
    `POST /v2/payments` through the same `source_id`. `source_type` maps to those categories
    instead of leaving everything but `CARD` unset.
  - **PayPal** widens to `wallet`: `charge()` charges `payment_source.paypal.vault_id` and
    nothing else, which is a stored-balance wallet by definition. `createCheckout()` stays
    `undefined`. A charge routed as anything but the wallet now throws.
  - **Razorpay** stays `['undefined']`, and the reason was never the missing `upi` name:
    **`POST /v1/orders` has no `method` field**, so `charge()` cannot produce a UPI payment on
    request — Checkout method restriction is a browser option. On the way back it is different,
    and `upi`, `wallet`, `bank_transfer` (netbanking) and `bnpl` (paylater, cardless EMI) are
    reported as themselves. A UPI payment used to come back unlabelled.
  - **Stripe** and **Adyen** keep their `supportedMethods` — neither has a single API field for
    "a bank transfer", only iDEAL, Bancontact, EPS, P24, BLIK and a new one each quarter — but
    both now report the category on `Payment.method`. Adyen's was hardcoded to `card`, which
    labelled a SEPA mandate or an iDEAL transfer a card payment.

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

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **The dashboard mounts at `/payments` now, not `/payments-dashboard`.**

  It shares that prefix with the machine endpoints — `POST /payments/webhook/:provider` and
  `GET /payments/client/status` — and the old default existed because that looked dangerous: a console
  guard sitting in front of a gateway's delivery endpoint is how a webhook ends up answering `403` to
  Stripe.

  It is not dangerous, because every route the dashboard provider registers is an **exact** path:
  `/payments`, `/payments/assets/:file`, `/payments/api/…`, and the login routes. There is no SPA
  catch-all, so the guard cannot reach a delivery it was never routed. The test that used to assert
  "no dashboard route starts with `/payments`" now asserts the invariant that actually matters — no
  wildcard, and nothing dynamic directly under the prefix, either of which would swallow
  `:provider` and `client`.

  **To keep the old URL**, set it explicitly:

  ```ts
  // config/payments_dashboard.ts
  export default defineConfig({ path: "/payments-dashboard" });
  ```

  Also: `assertCapability` accepts `'disputes'`. The capability has been on the driver contract since
  disputes landed and was read by nothing, so an app could call `submitDisputeEvidence` on a gateway
  that had already declared it does not support it.

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

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A chargeback has a deadline, and until now nothing in the library knew it.

  `payment.disputed` moved the payment row off `paid`, which stopped the worst version of the bug —
  revenue counted twice while the money was already going back. But a dispute is not one moment, it is
  three, and the library had a name for only the middle one. The two that decide the outcome were
  missing: the **warning** that arrives before a chargeback exists, when refunding is still cheaper
  than losing, and the **close** that carries whether you won.

  **The contract.** `Dispute` and `DisputeEvidence` are shared types now, and the driver contract
  carries `capabilities.disputes` plus optional `findDispute` and `submitDisputeEvidence`. `Dispute`
  leads with `evidenceDueBy` and `canSubmitEvidence` because those are the two fields an operator acts
  on — every network gives a fixed window to respond, and missing it loses the money by default rather
  than on the merits. Both methods are optional: a gateway with no dispute API declares
  `disputes: false` and the router refuses before a call is made, rather than a driver returning an
  empty object that reads like "no disputes".

  **Two new canonical webhook types.** `payment.dispute_warning` and `payment.dispute_closed` join
  `WEBHOOK_EVENT_TYPES`, and the diagnostics bus publishes them with the fields that make them
  actionable — `actionableUntil` on the warning, `outcome` on the close. **No driver maps them yet**;
  they are declared so the drivers can be wired one at a time against real gateway payloads without
  each one inventing its own name for the same event. Today Adyen's `NOTIFICATION_OF_FRAUD` still
  flattens to `payment.updated` and Stripe's `radar.early_fraud_warning.created` lands in the ledger
  as an unknown type. Both are tracked in the roadmap.

  **What this deliberately does not do:** decide. The library carries evidence to the gateway and tells
  you a window is closing. Whether a dispute is worth fighting or cheaper to refund depends on margin,
  customer value and fraud history — that is a business rule, and it stays in your code.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A dispute has a deadline, and now something stores it.

  The three dispute events landed and the processor reacted to all of them, but nothing was
  persisted: `evidence_due_by` arrived on a webhook, went out on the diagnostics bus, and was gone.
  "Which disputes are open, and which windows close this week" could only be answered by opening every
  gateway's own dashboard, one at a time — and a window that closes unanswered loses the money by
  default rather than on the merits.

  **New `billing_disputes` table**, published as `add_billing_disputes` (guarded by `hasTable`, so a
  fresh install gets it from `create_billing_tables` and this one does nothing) and declared in the
  create migration too. It keeps the dispute's own gateway id (unique — the idempotency key), the
  payment's gateway id (indexed — the join back to `billing_payments`), status, reason, amount,
  `evidence_due_by`, the outcome, and the opened/closed timestamps.

  **New reads on `BillingStore`**: `saveDispute`, `findDisputeByGatewayId`,
  `findOpenDisputeByPayment`, `listDisputes`, `countDisputes`, and the two that earn the table —
  `listDisputesDueWithin({ withinHours })` and `countDisputesDueWithin(...)`, the open disputes whose
  window closes soonest, in deadline order rather than arrival order. A deadline already **past**
  stays in the list: the dispute is still open and still unanswered, and dropping it the moment it
  expires would make the alert go quiet at exactly the moment it became true. A dispute the gateway
  sent no deadline for is never in it — `null` there means "the gateway told us nothing", not "no
  hurry".

  **The processor writes them.** Each of `payment.dispute_warning`, `payment.disputed` and
  `payment.dispute_closed` now persists a dispute row _in addition_ to what it already did — a warning
  still moves no money, a chargeback still moves the payment to `disputed`, a won close still puts it
  back to `paid`, and a close with no outcome still throws. Rows are keyed on the dispute's own gateway
  id; where a gateway sends none, on `dispute:<provider>:<payment gateway id>`, so the later events of
  one dispute land on the row its opening event created instead of accumulating one row per webhook.

  **`node ace payments:health` gained a fourth check**: an open dispute whose evidence window closes
  within 72 hours (`--dispute-window` in hours). It exits non-zero like the others and names each
  closing window — the dispute, the payment and the deadline — because a count sends nobody anywhere.

  **A read-only disputes panel** in the dashboard API: `GET <path>/api/disputes` for the log, and
  `?dueWithin=<hours>` for the work list, with the full closing-window total beside the page. No
  action buttons, deliberately: whether to fight a dispute or refund it turns on the fee, the evidence
  your app holds and the chargeback ratio that triggers network monitoring, and that decision stays in
  your code.

  An install that upgrades the package before running the migration keeps taking webhooks: the dispute
  write is skipped and the dispute reads answer empty, rather than failing every gateway delivery with
  `relation "billing_disputes" does not exist`.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Make `findDispute` and `submitDisputeEvidence` real on Stripe, and say plainly why Adyen cannot have
  them.

  `PaymentsDriver` has declared both methods and a `capabilities.disputes` flag since the dispute pass,
  and no driver implemented either — a contract nothing kept. Stripe now keeps it.

  **Stripe** (`capabilities.disputes: true`, API `2025-08-27.basil`). `findDispute` is
  `GET /v1/disputes/{id}`; `submitDisputeEvidence` is `POST /v1/disputes/{id}` with the `evidence` hash
  and `submit` (defaulting to `true` — the method is called submit, and staging silently would report a
  defense the bank never received; `metadata.submit: false` stages a draft). The two fields an operator
  acts on are read from Stripe's own `evidence_details`, never guessed from the status: `evidenceDueBy`
  from `due_by`, and `canSubmitEvidence` from the status **and** `past_due` — past the deadline a
  dispute is lost by default while its status still says `needs_response`. A dispute Stripe closed as
  `lost` on arrival, or one the networks forbid contesting, reports `canSubmitEvidence: false`, so the
  caller learns it before building a case rather than at the API error. `warning_*` statuses stay on the
  warning side of the money line, `warning_closed` maps to `expired` and `prevented` to `canceled`.

  Evidence is carried or refused, never dropped. `explanation` → `uncategorized_text`, the customer and
  shipping fields → their Stripe names, a single `documentIds` entry → `uncategorized_file`, and
  `metadata` reaches Stripe's own 27 evidence field names verbatim (checked against them, with file
  fields requiring a `file_…` upload id). What Stripe has no home for throws with the fix in the
  message: `receiptUrl`/`invoiceUrl`/`termsUrl` (Stripe wants a File upload id, and reviewing banks
  follow no links), `priorUndisputedPayments` (Visa CE 3.0 wants two prior charge ids with device and
  IP, not a count), more than one `documentIds` entry (Stripe files evidence by type), and an empty
  evidence packet — which would spend the dispute's single submission on nothing. Mapping happens
  before the dispute is read, so a refusal costs no round trip.

  The library never decides whether to fight: no auto-submit, no threshold, no default response. It
  makes the deadline visible and the submission one honest call.

  **Adyen** keeps `capabilities.disputes: false`, and both methods now exist and throw instead of being
  absent. Adyen has a dispute API — Defend Disputes v30 — but it cannot be driven through this
  contract: none of its five endpoints reads a dispute back (so `Dispute.status`, `amount` and the
  deadline would be invented), a defense is a scheme-specific `defenseReasonCode` plus base64 documents
  with no free-text field anywhere, and it lives on `ca-{test,live}.adyen.com/ca/services/DisputeService/v30`
  behind a credential with the "API dispute management" role. The throws name the three calls to make
  instead, and the provider page documents the flow — including that a `disputeServiceResult.success:
false` arrives with an HTTP 200.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A documentation sweep across every page, and the six code bugs it turned up. The docs were read
  against the source rather than against themselves, which is the only way this kind of thing surfaces.

  **AbacatePay created checkouts and subscriptions for 1/100 of their amount.** AbacatePay documents it
  outright — "valores monetários são sempre em centavos" — and `charge()` passed the integer straight
  through, while `createCheckout` and `createSubscription` ran `toDecimal`. The driver disagreed with
  itself on two paths nobody had compared: R$19,90 went out as `19.9` and became a 19-centavo
  checkout. Same bug as Woovi's, found the same way.

  **`withBillable` was not exported from the package root**, so every model `node ace make:billable`
  has ever scaffolded failed to compile — the stub imports it from `@adonis-agora/payments` and the
  root exported only the model classes. `withSubscription` and `withPayment` were unreachable too. A
  new test reads every published stub and fails when it imports a symbol the package does not export.

  **A failing invoice provider rejected `charge()` after the gateway had taken the money.** The caller
  saw a failed call over a real charge, and the obvious response to a failed charge is to charge again.
  The charge and the invoice are two different facts; `charge()` now returns the true one and publishes
  **`invoice.failed`** with the payment's gateway id. Subscribe to it: in Brazil an NFS-e is a legal
  obligation and nothing else will tell you.

  **`billing.dispatcher: 'queue'` never existed.** It was in the config type, the docs and the
  dispatcher's own comments; `queueDispatch` was declared and never read, so the mode fell through and
  silently ran durable-or-in-process. Splitting `billing.role` across api/worker was _permitted_ on it,
  which produced an api process doing all the work and a worker sitting idle. It is refused at boot
  with a named error, and `'durable'` is now the only mode a deployment can be split on.

  **`autoCreateSchema: false` did not reach a store the app built itself.** `billing.store: () =>
lucidBillingStore({ paymentModel: MyPayment })` constructs the store before the provider reads the
  config, so the flag was skipped and DDL ran against exactly the shared database it was set to
  protect.

  **`payment.failed` never published its `reason`.** The field was on the payload type from the
  beginning, so a subscriber could not see it even on the gateways that normalize one — and "why" is
  the only question anyone asks of a failed payment.

  Smaller: the routing error listed five payment methods when there are eleven (the union is derived
  from a list now, so the message cannot go stale again); the dashboard's `422` told operators to run a
  migration that no longer exists; and a dozen doc comments still named the collapsed migration files.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add the Dodo Payments driver (`payments.dodo()`) — merchant-of-record billing for SaaS,
  over the REST API with no SDK dependency.

  Dodo is the legal seller of record: it registers for, calculates, files and remits sales
  tax and VAT across 220+ regions, carries chargeback liability and PCI scope, and pays you
  net. The library does not model any of that, but one consequence lands directly in the
  driver: **there is no amount-only endpoint anywhere in the Dodo API.** Every charge names a
  product you created in Dodo, and an arbitrary amount is honored only on a product with Pay
  What You Want enabled. `charge()` therefore requires `metadata.productId`, and refuses
  rather than guessing.

  **Supports** cards worldwide and **Pix in Brazil** — the charge's `method` becomes
  `allowed_payment_method_types`, which is the field that restricts the hosted checkout
  (`pix` keeps the card methods as a fallback, because a checkout whose every listed method
  is unavailable simply fails). **Boleto is not advertised**: it exists in Dodo's raw
  processor-level enum but is absent from its supported-methods documentation. A Pix charge
  returns `hostedUrl` and no `pixCode` — Dodo's API returns neither field; the payer gets the
  QR on Dodo's page.

  Also: customers, checkout sessions (`POST /checkouts`, the non-deprecated route),
  subscriptions, full refunds, and payments-as-invoices with the PDF on `hostedPdfUrl`.
  Amounts are integers in the currency's smallest unit throughout, so nothing is converted.
  `currency` is required and is sent as Dodo's `billing_currency`.

  **Refuses**, rather than reporting a change Dodo never made:

  - `refund(paymentId, amount)` — a partial refund. Dodo's `POST /refunds` has no top-level
    amount; partial refunds are per line item and need the product id of the line, which this
    contract's single `amount` cannot address. A full refund works normally.
  - `createSubscription({ amount | cycle })` — the recurring price and interval belong to the
    product.
  - `createSubscription({ card })` — there is no tokenized-card input.
  - `updateSubscription({ amount | description })` — a Dodo subscription has neither field. A
    plan switch goes through `metadata.productId` and `POST /subscriptions/{id}/change-plan`.
  - `updateCustomer({ taxId })` — a Dodo customer has no tax id; it belongs to an individual
    B2B purchase.
  - `charge()` with no `metadata.productId`, or with no billing country from
    `metadata.billingCountry` / `metadata.billing` / the driver's `billingCountry` option —
    Dodo requires a country on every payment.

  `charge()` returns a **pending** payment: `POST /payments` hands back a payment link the
  customer still has to pay on, and settlement arrives as a `payment.succeeded` webhook.
  Cancelling is a `PATCH` either way — Dodo has no `DELETE /subscriptions/{id}` — and Dodo has
  no `subscription.created` event, so `subscription.active` is what maps onto it.

  Webhooks are verified against the Standard Webhooks scheme with a ±5 minute replay window.
  The HMAC key is the secret with `whsec_` stripped and the rest **base64-decoded** — the
  spec default, which Dodo's docs never state outright but its SDK's dependency on the
  `standardwebhooks` reference library settles. Note this is the opposite of the Polar driver
  added alongside it.

  Written against the published API reference and covered by unit tests; **not yet exercised
  against a live Dodo Payments account.** Verify in test mode before taking real money.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Efí (formerly Gerencianet)** driver — the **Pix API** (`pix.api.efipay.com.br`) and only
  that one. Efí's Cobranças API is a different product with different auth (boleto, card,
  carnê, native subscriptions, no certificate); nothing there is reachable from this driver
  and no flag switches it over. BRL-only, so no `currency` option.

  ```ts
  providers: {
    efi: payments.efi({
      clientId: env.get('EFI_CLIENT_ID'),
      clientSecret: env.get('EFI_CLIENT_SECRET'),
      pixKey: env.get('EFI_PIX_KEY'),
      certificate: env.get('EFI_CERTIFICATE'),   // the .p12 from the Efí dashboard
    }),
  }
  ```

  **The certificate is the interesting part.** Efí requires mutual TLS on every request,
  including the OAuth token request, and a client certificate belongs to the TLS handshake
  rather than to a header — so it could not be configured the way every other gateway's key
  is. `httpRequest` gained one optional `fetch` option, and the driver builds a
  certificate-bearing `fetch` over `node:https` (which has accepted `pfx` forever) and passes
  it through, keeping the shared error handling and adding **no new dependency**. Pass
  `certificate` as a path or a Buffer, or pass your own `fetch` when a proxy holds the
  certificate. Miss it and the driver refuses to boot — at boot, not at the first charge —
  with the dashboard path and the config key in the message.

  **The token cannot outlive itself.** The access token is cached against the `expires_in`
  Efí actually returned, minus a minute of skew; concurrent charges share one token request
  instead of racing to mint several, and a `401` drops the cache and retries once for the
  token revoked before it expired. A cache with a lifetime of its own is how you get a driver
  that works all afternoon and starts failing an hour into a deploy that stayed up — the
  tests move the clock past the expiry and assert a second token is minted.

  **The txid is the only reference Efí echoes.** Its notification carries `endToEndId`,
  `txid`, `chave`, `valor`, `horario` and `infoPagador` — nothing else of yours. So an
  `externalReference` that fits the txid charset (26–35 alphanumerics) is sent as the txid and
  comes back as `event.data.externalReference`; one that does not fit is not mangled — Efí
  generates the txid and you route on the returned `gatewayId`. Money crosses as a decimal
  string built by shifting the integer's digits, never by dividing, so `1990` cannot leave as
  `"19.89"`.

  **Nothing authenticates the webhook inside the driver, and the docs say so** instead of
  implying a guarantee. Efí's mechanisms are mutual TLS at your edge and an `hmac` **query
  parameter** — and `parseWebhook` is handed the body and the headers, never the URL. The
  provider page says where to enforce both. A batched notification (more than one Pix in the
  array) is refused loudly with every txid named, rather than processing the first and
  dropping money that has already arrived; the registration probe, which has no `pix` array,
  is answered with an inert event so registering the webhook succeeds.

  **What it refuses:** every subscription method (recurring Pix at Efí is either the Cobranças
  API or Pix Automático, both different products), every customer operation (the payer is
  inline on the charge), and any `method` other than `pix`. `listInvoices` returns `[]`.

  Written against Efí's published Pix API reference and covered by unit tests; **it has never
  presented a real certificate to a live Efí account.** Verify against homologation (`pix-h`)
  with your own `.p12` before taking real money.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Store the two things the library's own story depended on and never kept: the app's
  `externalReference` on the payment row, and the normalized event on the webhook ledger row.

  **This release adds two database columns. Existing installs must run a new migration.**
  `node ace configure @adonis-agora/payments` now publishes a second migration file,
  `add_billing_external_reference`, alongside `create_billing_tables` — it adds
  `billing_payments.external_reference` (nullable, indexed) and
  `billing_webhook_events.normalized` (nullable jsonb). Every step in it is guarded by
  `hasColumn`, so a fresh install (whose `create_billing_tables` already declares both columns)
  runs it as a no-op. Run `node ace migration:run` after upgrading.

  - **`externalReference` is now stored and queryable.** Drivers mapped it, `parseWebhook`
    surfaced it and the processor published it on the diagnostics bus — and then dropped it, so
    nothing could look a payment up by the id the app actually knows it by. The processor now
    persists it from `payment.succeeded`, `payment.failed`, `payment.refunded` and
    `payment.disputed`; a later event that echoes no reference does **not** blank a stored one.
    New: `BillingStore.findPaymentByExternalReference(reference)` (both implementations),
    `savePayment({ externalReference })`, and `externalReference` on `PaymentListItem`.
  - **The browser status endpoint polls by your own id.** `GET <path>/status?reference=` now looks
    the payment up by `external_reference` first and falls back to reading the reference as a
    gateway id. `resolveReference` remains as an escape hatch for apps that poll with something
    that is neither, but it is no longer the default: `config.resolveReference` now defaults to
    `null` instead of the identity mapping, and setting it replaces the built-in lookup entirely.
  - **The dashboard's webhook retry replays signed gateways.** It rebuilds the event from the
    ledger row's `payload` + `normalized` columns and runs the processor directly, never calling
    `parseWebhook` — which used to re-verify a signature computed over headers the ledger never
    kept, so a Stripe or Adyen retry answered `422` while unsigned gateways replayed fine.
    `createReplayAction` no longer takes a `parse` dependency.

  **Degradation before the migration runs, by design:** both writes ask the schema once (cached)
  and skip a column that is not there, so an install that upgrades the package before migrating
  keeps taking webhooks. It records payments without a reference,
  `findPaymentByExternalReference` answers `null`, the status endpoint falls back to the gateway
  id, and the dashboard's retry answers `422` naming the missing migration. Nothing is
  backfilled — a reference that was never stored cannot be recovered from a raw payload.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Four places where the config said one thing and the money did another. Three gateway calls that
  reported a success the gateway never performed now do the real thing, or refuse — and Stripe no
  longer picks a currency for you.

  **Breaking config change: `currency` is required on Stripe.** It defaulted to `'brl'`, so an app in
  the euro area that never set it charged in reais — silently, successfully, with nothing in the flow
  saying so. Stripe bills in whatever you hand it, which makes any default a guess at the app's
  country, and the wrong guess does not fail. The driver now refuses to boot without one:

  ```
  [payments] Driver "stripe" has no currency configured. Set `currency` in
  config/payments.ts — a multi-currency gateway has no safe default.
  ```

  **To migrate:** add `currency` to your Stripe provider in `config/payments.ts` —
  `payments.stripe({ apiKey: env.get('STRIPE_KEY'), currency: 'brl' })` keeps today's behavior
  explicitly. The type makes it required, so `tsc` finds it before boot does. Asaas, AbacatePay and
  Woovi are BRL-only, take no currency option, and are unchanged.

  **Stripe sends the idempotency key as a request header.** `idempotencyKey` was written into the
  PaymentIntent's metadata, which Stripe does not deduplicate on — a retried charge created a second
  PaymentIntent while the docs promised it could not. `charge` and `createCheckout` now pass it as the
  SDK's `idempotencyKey` request option (the `Idempotency-Key` header), the two inputs that carry a
  key. The metadata copy stays: Stripe never echoes the header back on the object, so it is the only
  thing that lets `payment.payload` trace a charge to the key that created it.

  **Stripe creates the payment method the charge asked for.** `charge()` never sent
  `payment_method_types`, so a charge routed as Pix was created with whatever the account's dashboard
  defaults are — while `supportedMethods` advertised `pix` and `boleto`. The charge's `method` now maps
  onto the intent (`pix` → `pix`, `boleto` → `boleto`, `credit_card` → `card`), and a Pix or boleto
  intent comes back with what the payer needs: `pixCode` (the BR Code) and `hostedUrl` (Stripe's
  instructions or voucher page), read off `next_action`. A charge with no `method` still falls back to
  Stripe's dynamic payment methods. Note that routing alone does not carry the method —
  `payments.driver('pix')` picks the provider, `method: 'pix'` on the charge picks the method.

  **Woovi refuses a subscription update instead of faking one.** `updateSubscription` fetched the
  subscription, merged the new amount into a local copy and returned it, so the caller got back a
  `Subscription` showing the new amount while OpenPix kept charging the old one. OpenPix subscriptions
  are immutable — the API creates and reads them and nothing else — so the driver now throws a
  `[payments]` error telling you to cancel and recreate, or to keep the change on your own record.
  This is a behavior change for anyone who was calling it and believing the result.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - PayPal, Razorpay and Square were all reporting a pre-dispute alert as a chargeback, and none of the
  four drivers here could tell you how a dispute ended. All four now speak the full dispute
  vocabulary — `payment.dispute_warning`, `payment.disputed`, `payment.dispute_closed` — and carry the
  response deadline as `actionableUntil`.

  **PayPal.** A PayPal dispute is not a card-scheme chargeback; it has a lifecycle of its own and
  PayPal decides it. `CUSTOMER.DISPUTE.CREATED` fires at two different points in that lifecycle —
  PayPal's own sandbox guide has you assert `dispute_life_cycle_stage` is `INQUIRY` on one test and
  `CHARGEBACK` on the next — and the driver mapped both to `payment.disputed`. An `INQUIRY` is the
  buyer and seller talking in the Resolution Center with nothing adjudicated and nothing debited, so it
  is now **`payment.dispute_warning`**. `CUSTOMER.DISPUTE.UPDATED` carrying a stage past `INQUIRY` is
  now `payment.disputed`: PayPal sends no dedicated "escalated to a claim" event, so that is the only
  notice a row that opened as a warning ever gets. `CUSTOMER.DISPUTE.RESOLVED` now closes the dispute
  with the outcome from `dispute_outcome.outcome_code` — `RESOLVED_SELLER_FAVOUR` → `won`,
  `RESOLVED_BUYER_FAVOUR` → `lost`, `CANCELED_BY_BUYER` → `canceled` — and stays a `payment.updated`
  for the four codes that do not name who kept the money (`RESOLVED_WITH_PAYOUT` is "the merchant _or_
  customer", `ACCEPTED`/`DENIED` are deprecated, `NONE` is "closed without any decision").
  `seller_response_due_date` now comes through as `actionableUntil`, and the dispute's `reason` is now
  spelled `reason` rather than `disputeReason`.

  **Mollie.** Unchanged where it should be: Mollie has no fraud alert, no retrieval request and no
  inquiry, so the driver emits no `payment.dispute_warning` and the chargeback object carries no
  deadline to surface. What changed is the close — `chargeback.reversed` was a plain `payment.updated`,
  which left the row stuck at `disputed` with the revenue written off. It is now
  **`payment.dispute_closed` (`won`)**, and the reversal is read from `reversedAt` as well as from the
  event name, because the payload is a snapshot and a redelivered `chargeback.received` carries it too.
  The chargeback id is now `disputeId` rather than `chargebackId`.

  **Razorpay.** `payment.dispute.created` fires for all five dispute **phases**, and two of them are
  not a chargeback: `fraud` is the bank's risk-analysis alert and `retrieval` is what Razorpay itself
  calls "essentially a _soft_ chargeback". Both are now **`payment.dispute_warning`**. `.won`, `.lost`
  and `.closed` are now `payment.dispute_closed` — `closed` maps to `canceled`, because Razorpay
  defines it as a fraud case that ended after you supplied details or refunded, with no verdict and
  nothing deducted. `respond_by` now comes through as `actionableUntil`, and `reason_code` and
  `amount_deducted` are on the payload as `reason` and `amountDeducted`. `.under_review` and
  `.action_required` stay `payment.updated`.

  **Square.** The Dispute `state` now decides the event, on `dispute.created` and
  `dispute.state.updated` alike. `INQUIRY_EVIDENCE_REQUIRED` and `INQUIRY_PROCESSING` are
  **`payment.dispute_warning`**; `EVIDENCE_REQUIRED` and `PROCESSING` are `payment.disputed` (Square
  "withholds the disputed funds from the seller's Square account balance" the moment the bank notifies
  it); `WON` closes as `won` and `LOST`/`ACCEPTED` close as `lost` — accepting a dispute is Square
  returning the money to the cardholder, so it is a loss. `INQUIRY_CLOSED` names no winner and stays a
  `payment.updated`. `due_at` now comes through as `actionableUntil`, and the deprecated
  `dispute.state.changed` and `dispute.evidence.deleted` events are recognized.

  **If you have a handler on `payment.disputed`,** it no longer fires for a PayPal inquiry, a Razorpay
  fraud or retrieval alert, or a Square inquiry. That is the fix — add `payment.dispute_warning` if you
  want to hear about them, which you do: that is the window where a refund still stops the chargeback
  being filed at all.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Export the webhook payload types an app handler actually needs

  `WebhookEvent` was exported; the shapes drivers normalize `event.data` onto were not. Every
  app writing a handler had to re-declare them as an inline cast — a type that agrees with
  nothing and drifts silently when a field is added. `PaymentWebhookData`,
  `SubscriptionWebhookData` and `DisputeWebhookData` are now exported from the package root,
  along with the `isPaymentWebhookData` / `isDisputeWebhookData` / `isSubscriptionWebhookData`
  guards.

  `DisputeWebhookData` also gained `externalReference`. Gateways that build a dispute event
  out of the payment resource carry it — Asaas nests `chargeback` on the payment and spreads
  the payment's fields — and an app routing a chargeback back to its own order needs it as
  much as a `payment.succeeded` handler does. It was on the wire and hidden by the type.

  The `make:webhook-handler` stub now uses those types (and is in English; it was writing
  Portuguese comments into other people's apps).

  The gate that checks published stubs against the package's exports could not see any of
  this: it matched `import {` and not `import type {`, so a stub importing a type that does
  not exist passed. Fixed, and proven by mutation in both directions.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Eight things an application integration found, all of them silent: typed webhook handlers, a boot
  refusal for the wirings that could never work, lazy service accessors, and a testing surface that
  does not need a cast.

  **1. `event.data` is typed by the event type.** `WebhookEvent<T = unknown>` plus
  `WebhookHandler = (event: WebhookEvent) => …` forced every handler to open with
  `const data = event.data as PaymentWebhookData` — and on `payment.disputed` that cast was simply
  wrong, because a dispute carries a `DisputeWebhookData` whose `amount` and `currency` are optional
  (a Stripe early fraud warning has neither). New `WebhookEventDataMap` pairs each canonical type with
  its payload, and `defineWebhookHandler('payment.disputed', (event) => …)` infers it, so reading a
  payment field off a dispute is a compile error. The returned value is callable _and_ carries
  `type`/`handle`, so one definition works as a `billing.handlers` entry and as an
  `app/payment_handlers/` default export. A passthrough type keeps `data: unknown` — nothing
  normalized it, and pretending otherwise is the same lie one level down. `make:webhook-handler` now
  generates `WebhookEventFor<'…'>` and no cast.

  **2. A typo in `eventType` no longer boots.** `normalizeWebhookHandlerModule` accepted any string,
  the provider did `handlers[type] = …`, and the processor skipped a lookup miss — so
  `'payment.suceeded'` registered a handler nothing ever called, the ledger recorded the delivery as
  **processed**, the route answered 200 (telling the gateway never to send it again), and the grant
  never happened. `WEBHOOK_EVENT_TYPES` and `WebhookEventType` are now exported (they existed and were
  not, so apps typed the key as a bare string), and the provider refuses at boot on an unknown type —
  and on two handlers claiming the same type, which used to overwrite in silence. The rule is
  namespace-based and stated in the error: `payment.*`/`subscription.*` is the library's namespace, so
  a type there must be canonical; a gateway event a driver could not map arrives lowercased as the
  gateway spells it (`payment_anticipated`) and is accepted as-is. `billing.passthroughEvents` covers
  the rare gateway that spells one with a dot.

  **3. Lazy service accessors.** `getPayments()` throws until the provider's `booted()` hook runs, and
  providers registered earlier boot first — durable constructs workflow services before payments has
  set anything — so resolving in a constructor throws. `lazyPayments()`, `lazyBillingStore()` and
  `lazyPaymentsDriver(methodOrName?)` resolve on first property access, so `#payments = lazyPayments()`
  in a field initializer is safe. `getPayments()`/`getBillingStore()` keep the eager throw.

  **4. `@adonis-agora/payments/testing` can build a manager.** It exported the fake driver and no way
  to wrap it, so apps wrote `setPayments({ driver: () => fake } as never)` — a cast that erased the
  fact the stand-in has no `invoice()` and no `assertCapability()`. New `fakePayments(driver?)` returns
  a real `PaymentsManager`; `swapPayments(manager)` / `swapBillingStore(store)` return a restore that
  works when nothing was set, which the hand-rolled save/restore could not express.

  **5. Webhooks can be awaited in tests.** In durable mode `dispatchAll` resolves when the event is
  **accepted**, not processed, so every app pairing `billing.dispatcher` with durable wrote the same
  polling `waitFor` — and had to write its negative assertions as timed sleeps.
  `dispatcher.flushWebhooks()` (and `flushWebhooks()` from `./testing`) resolves when the accepted work
  has actually run, background in-process retries included, and throws instead of hanging when the
  events belong to a separate worker process.

  **6. `truncateBillingTables(db)`, and `dropBillingTables` invalidates the store's memo.**
  `LucidBillingStore` caches schema creation in `#schemaReady`, so an app that dropped the tables
  between test groups left the store certain they still existed and every following query failed on a
  missing relation. The drop now tells live stores to forget; the new truncate empties the rows, which
  is what a suite actually needs — without it one test's webhook ledger deduplicates the next test's
  event, the library's idempotency working against the suite.

  **7. `driver()` no longer ignores `config.methods`.** `#resolveName` returned `{ name: default }`
  with no method, so the routing map was never consulted and the driver came back unbound — the same
  failure the manager's own comment names one branch down: _a charge routed as Pix could come back a
  card_. Now: exactly one method routed to the default provider is bound; several is ambiguous and the
  `charge`/`createSubscription` is refused, naming the two ways to say what you meant (so an app that
  already passes `method:` everywhere is unaffected); and a method the map routes to a **different**
  provider is refused rather than sent to the wrong gateway.

  **8. A driver with an empty webhook-credential slot no longer boots.** `if (this.#webhookToken !==
undefined)` meant a driver with nothing configured verified nothing, and the mounted
  `POST /payments/webhook/:provider` accepted any body — including one that marks a payment paid. Every
  driver now declares `webhookVerification` (`'configured'` / `'unconfigured'` / `'unsupported'` — Efí
  and InfinitePay sign nothing at all), and the provider refuses to boot on an unconfigured one, the
  way the dashboard already refuses a missing session secret. `allowUnverifiedWebhooks: ['efi']` is the
  explicit opt-out for an app that terminates verification upstream.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **New driver: InfinitePay** (CloudWalk, Brazil) — `payments.infinitepay()`. **It does checkout
  links and nothing else, because that is all InfinitePay documents.**

  **Not yet run against a live account.** It is written against InfinitePay's published checkout
  documentation and covered by unit tests that stub the HTTP layer; nothing in it has touched a real
  InfinitePay account. Create a link, pay it, and confirm the `checkPayment()` step end to end before
  taking real money.

  InfinitePay's only currently documented developer API is the Checkout / Payment Link API: create a
  link, redirect the payer, receive a per-link webhook when the payment is approved. There is no
  documented server-side charge API, no refund endpoint, no customer resource, no subscription API,
  and no list or search endpoint of any kind. So this driver implements `createCheckout`,
  `parseWebhook` and a driver-specific `checkPayment()` — and **`charge()`, `refund()`,
  `createCustomer()`, `findCustomer()`, `updateCustomer()`, `findPayment()`, `listInvoices()` and
  every subscription method throw** a `[payments]` error naming the gap. They do not return an empty
  result and they do not call an endpoint that is not there. (A v2 transactions API did exist and is
  still referenced by CloudWalk's abandoned WooCommerce and Magento plugins, but its documentation
  host is gone and its credentials were handed out by email; the driver deliberately does not build
  on an archive.)

  ```ts
  providers: {
    infinitepay: payments.infinitepay({
      handle: env.get('INFINITEPAY_HANDLE'),
      webhookUrl: env.get('INFINITEPAY_WEBHOOK_URL'),
    }),
  }
  ```

  **The credential is a `handle`, not a secret.** The checkout endpoint is public and takes no
  credentials at all; the handle (your InfiniteTag) is what identifies the merchant. "Checkout
  Integrado" must be enabled in the InfinitePay app first. Amounts are integer centavos on both
  sides — no conversion — and being BRL-only it takes no `currency` option. `supportedMethods` is
  `['pix', 'credit_card']`: what the hosted page settles with. **No boleto.**

  **The webhook is unauthenticated, and the driver says so rather than implying otherwise.**
  InfinitePay documents no signature, no HMAC and no shared token for the checkout webhook — its own
  security advice is to re-check the payment instead. `parseWebhook` therefore verifies nothing: an
  event out of it means _somebody claimed a payment happened_. Confirm it with `checkPayment()`
  (`event.raw` carries the three ids it needs) before crediting anything, and put an unguessable
  segment in the `webhookUrl` you configure. `webhook_url` is sent **per link** — there is no global
  registration — so without `webhookUrl` no webhook ever arrives.

  **`findPayment` throws; `checkPayment` replaces it.** `POST /payment_check` needs all three of
  `order_nsu`, `transaction_nsu` and `slug`, and the last two only exist once the payment does. A
  pending link is invisible to the API, so one id is not enough and the driver refuses instead of
  guessing.

  `createCheckout` returns the gateway's `url`; since the response carries no link id, the session's
  `id`/`gatewayId` is the `order_nsu` the call sent — the only id the webhook and `checkPayment`
  speak in, and therefore where `externalReference` goes. It is the one field InfinitePay echoes
  back, and it returns on `event.data.externalReference`. `cancelUrl` is ignored (a link has one `redirect_url`), `planId`/`trialDays` are refused,
  and `metadata.items` passing a real cart must add up to `amount` or the call throws.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add a **Lemon Squeezy** driver — the v1 REST API on `api.lemonsqueezy.com`.
  `payments.lemonsqueezy({ apiKey, storeId, webhookSecret })`, REST over `fetch`, no new peer
  dependency.

  Lemon Squeezy is a merchant of record: it is the seller of record on your customer's statement, it
  remits sales tax and VAT worldwide, and it pays you out. It is also the only gateway in this package
  that speaks **JSON:API** — every field lives under `data.attributes`, ids are strings at the resource
  level, and both `Accept` and `Content-Type` must be `application/vnd.api+json`, which is why this
  driver does its own `fetch` instead of going through the shared HTTP helper.

  **`charge()` throws.** Lemon Squeezy has no server-side charge endpoint at all — as merchant of
  record it owns the payment page, and a purchase begins with a hosted checkout. `createCheckout()` is
  the entry point; `planId` is a **variant** id and is required, because a Lemon Squeezy checkout
  always sells something from the catalog.

  **`createSubscription()` throws** for the same reason: a subscription exists once a customer
  completes a checkout for a subscription variant, never from an API call.

  **Cancelling immediately throws.** `cancelSubscription(id)` cancels at the end of the billing period
  and the subscription runs to `ends_at`; there is no immediate-termination endpoint, and reporting one
  would leave a customer with access the caller believes was revoked. `updateSubscription()` accepts
  only a plan swap (`metadata.variantId`) and refuses `amount` (the price belongs to the variant) and
  `description` (no such field). A `taxId` on a customer throws — Lemon Squeezy has none; the buyer
  enters a tax number at checkout, so pass `metadata.taxNumber` on the checkout instead. `trialDays`
  throws too: a trial is a property of the variant.

  **Money is already in cents** — `999` is $9.99 — so unlike the Brazilian gateways there is no decimal
  conversion in either direction. There is **no `currency` option**: a store has exactly one currency
  set in the dashboard, and rather than let you assert one that might not match, the driver reads the
  currency off what the API returns and reports no `amount` on a `CheckoutSession`, because the
  checkout response states a price but never a currency. There is also **no sandbox host and no
  sandbox flag** — test mode lives in the API key, and `meta.test_mode` is surfaced on
  `event.data.testMode`.

  **Webhooks.** `X-Signature`, HMAC-SHA256 over the raw body in hex, compared timing-safe; the driver
  refuses to parse without a configured signing secret. `order_created` is mapped by the order's own
  `status`, not by the event name, so an order that failed or was refunded does not become
  `payment.succeeded`. Lemon Squeezy sends no event id, so a stable one is derived from the event name,
  resource type, id and `updated_at` — `updated_at` included so a second `subscription_updated` for the
  same subscription is not mistaken for a replay. `externalReference` rides on
  `checkout_data.custom.external_reference` and comes back as `meta.custom_data`; because
  `CheckoutInput` has no `externalReference` field, pass it as `metadata.externalReference`.

  `supportedMethods` is `['undefined']` only — the API takes no payment-method argument, so the driver
  cannot promise a payment will be a card rather than PayPal.

  Written against Lemon Squeezy's published API reference and covered by unit tests; **not yet
  exercised against a live Lemon Squeezy account**. Verify in test mode before taking real money.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **The library creates its own tables now. There is no migration to run.**

  Every other library in this ecosystem owns its schema — `@adonis-agora/durable` exports
  `createDurableTables`, `@adonis-agora/authz` exports `createAuthzTables`, both auto-create by
  default with an off switch. This package did not, and the cost compounded in one release: each
  column added after 0.2.0 became another migration file with hand-written `hasColumn` / `hasTable`
  guards, and adopting the library meant publishing and running **three** files before taking a single
  payment.

  `billing.autoCreateSchema` is on by default. The store calls `createBillingTables` once on first
  use; the DDL is idempotent, so an install that already ran the 0.2.0 migration gets no-ops, and the
  cost is one round trip on the first query of a process.

  **It is an upgrade path, not just a first-install convenience.** `CREATE TABLE IF NOT EXISTS` cannot
  carry a new column to a table that already exists, so columns added after their table shipped are
  applied as guarded `ALTER TABLE`s — which is precisely what `add_billing_external_reference` was
  doing by hand. Upgrading the package is now a deploy, not a deploy plus a migration.

  **To own the DDL yourself** — a shared database, a team that reviews every schema change, a deploy
  that runs migrations as their own step:

  ```ts
  // config/payments.ts
  billing: {
    autoCreateSchema: false;
  }
  ```

  and run the migration `configure` publishes. It calls the same `createBillingTables`, so the two
  paths cannot drift. `createBillingTables`, `dropBillingTables` and `BILLING_TABLES` are exported for
  seeders and test bootstraps.

  **Three published stubs became one.** `add_billing_external_reference` and `add_billing_disputes` are
  gone; their work is in the function. Files already published into your app keep working — they are
  your migrations now, and re-running them is harmless.

  The gate that makes this safe is a test, not a convention: `lucid_store_schema.spec.ts` enumerates
  every public method on `LucidBillingStore` and fails when one of them queries without creating the
  schema first. A lazily-created schema that most methods wait for is worse than none — it works in
  development, where something writes before anything reads, and fails in production on whichever call
  happens to be first.

  ***

  Two ordering bugs in this function were found by the integration suite against a real Postgres, and
  both would have shipped: an `ALTER TABLE` running two statements above its own `CREATE TABLE`, and
  an index on a column an older install does not have until the ALTER adds it. Either one fails the
  whole call, so the schema is half-built on every boot and the only symptom is a query error
  somewhere else. The DDL is now three explicit phases — create, then late columns, then indexes —
  and a test asserts that order rather than trusting it.

  Separately, and found by the same suite: **`billing_payments.amount` was arriving as a string.** The
  column is `BIGINT` and node-postgres returns bigints as strings rather than guess past 2^53, so a
  row read back held `'1990'` while its declared type said `number`. Adding a fee to it concatenated.
  Both `BillingPayment.amount` and `BillingDispute.amount` now coerce on read; `Number()` is safe for
  these columns specifically, because 2^53 minor units is ninety trillion reais.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **New gateway: Mercado Pago** — `payments.mercadopago({ accessToken, currency, webhookSecret })`.
  Pix, boleto and card through the Checkout API (`POST /v1/payments`), Checkout Pro preferences for
  hosted checkout, and preapprovals for subscriptions. Plain REST, no SDK, no new peer dependency.

  It is the first **multi-currency** driver after Stripe, and it takes `currency` the same way: as a
  required option with no default. Mercado Pago runs seven country sites (BR, AR, MX, CL, CO, PE, UY)
  and bills in whatever it is handed, so a default would be a guess at which one — and the wrong guess
  charges instead of failing. `transaction_amount` crosses the boundary as a decimal, converted with
  the currency in hand: `clp` has no cents, and dividing a Chilean amount by 100 bills 1% of it while
  the gateway accepts it happily.

  `idempotencyKey` goes out as the `X-Idempotency-Key` header Mercado Pago requires, not as a body
  field. `externalReference` maps to `external_reference` on payments, preferences and preapprovals,
  and the driver rejects a reference outside Mercado Pago's 64-character alphanumeric shape up front
  instead of letting the gateway answer with an opaque 400.

  **A Mercado Pago notification carries the id of the changed resource and nothing else** — no amount,
  no status, no `external_reference`. So `parseWebhook` verifies the `x-signature` HMAC (over
  `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, read out of Mercado Pago's own SDK because the
  docs page no longer publishes it) and then fetches the resource, returning the real event with its
  status, amount and your `externalReference`. That fetch is one API call per notification, and a
  failed one throws so the route answers 400 and Mercado Pago retries — reporting a status the gateway
  did not confirm would be worse than a retry. `subscription_authorized_payment` is the exception: its
  `/authorized_payments/{id}` shape is unverified against the reference, so it stays `payment.updated`
  with the id rather than mapped from guessed field names.

  **What it refuses**, rather than fake: `listInvoices` (Mercado Pago has no invoices for a customer —
  `authorized_payments` are a subscription's charges, keyed by a different id space);
  `cancelSubscription({ atPeriodEnd: true })` (a preapproval cancel is immediate and irreversible); a
  subscription `startDate` with no end date (Mercado Pago silently ignores it); and a card charge with
  no brand in `metadata.paymentMethodId`.

  Written against Mercado Pago's published API reference and covered by unit tests; it has not been
  run against a live Mercado Pago account. Verify in sandbox before taking real money.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add a Mollie driver — `payments.mollie({ apiKey, currency })`, on Mollie's v2 REST API with no SDK
  dependency.

  Cards and a hosted checkout page in any currency, native subscriptions, and refunds:
  `supportedMethods` is `credit_card` and `undefined`, `capabilities` is
  `{ refunds: true, invoices: false, subscriptions: true }`. `currency` is required — Mollie settles
  in whatever you hand it, so a default here would be a guess at the app's country, and the wrong
  guess still takes money. Mollie's money is a decimal string in the currency's own scale (`"19.90"`
  for EUR, `"1990"` for JPY, `"1.990"` for KWD); the conversion happens only at the HTTP boundary,
  through `formatDecimal`/`fromDecimal`.

  **The webhook is a bare id, and the fetch is what authenticates it.** Mollie POSTs
  `id=tr_5B8cwPMGnU6qLbRvo7qEZo`, form-encoded, unsigned, with no status — deliberately, so a forged
  call cannot make you think a payment succeeded. `parseWebhook` reads the id, fetches the payment
  with your API key, and builds the event entirely from what that authenticated call returned; nothing
  in the request body is trusted beyond the id. It returns a promise, which the driver contract allows
  and the mounted `/payments/webhook/:provider` route awaits, so Mollie webhooks mark payments paid
  through the normal route with no extra wiring. A failed fetch **throws**: the route answers 400 and
  Mollie retries, which is the right outcome for a payment nobody could confirm. Event ids are
  `mollie:<paymentId>:<status>`, stable per transition, so a redelivery dedupes while the next status
  still gets through. Set `webhookSecret` and the driver also verifies Mollie's next-gen
  `X-Mollie-Signature` (HMAC-SHA256 hex over the raw body) fail-closed, before fetching anything — a
  signature proves who sent the event, not what the payment is worth.

  **`supportedMethods` is short because the shared union has no room.** `PaymentMethodName` is
  `pix | credit_card | debit_card | boleto | undefined`, so iDEAL, Bancontact, SEPA Direct Debit,
  PayPal, Klarna, Apple Pay, EPS, Przelewy24, BLIK, TWINT and the rest of Mollie's catalogue cannot be
  declared or routed by name. They still work — omit `method` and Mollie's hosted page offers whatever
  the profile has enabled, which is what `'undefined'` means. `debit_card` is absent for the same
  reason: Mollie has no debit-only method to ask for.

  `idempotencyKey` is sent as Mollie's `Idempotency-Key` request header on `charge` and
  `createCheckout` — the only thing Mollie deduplicates on. It is not copied into `metadata`, where it
  would be echoed back and protect nothing.

  **What it refuses, rather than reporting a success Mollie never performed:**
  `split` (Mollie Connect routes
  are absolute amounts against organization ids); `trialDays` on a subscription (Mollie has no trial —
  pass `startDate`); `planId`/`trialDays` on a checkout; a charge with no redirect URL; a `method`
  Mollie has no id for; and `listInvoices`, because Mollie's Invoices API returns the monthly invoices
  Mollie issues to _you_ for its fees, not documents you issue to your customers.

  Every Mollie subscription endpoint is nested under a customer while the driver contract passes only
  the subscription id, so `cancelSubscription`/`updateSubscription`/`findSubscription` resolve the
  customer from the subscription they created, or from Mollie's account-wide list — and throw rather
  than guess when neither finds it. Pass `"cst_xxx/sub_xxx"` to skip the lookup.

  Written against Mollie's published v2 API reference and covered by unit tests; it has not been
  exercised against a live Mollie account. Verify in sandbox (a `test_` key) before taking real money.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The dispute vocabulary on the four merchant-of-record gateways — Paddle, Lemon Squeezy, Polar and
  Dodo Payments. On an MoR the gateway is the seller on the cardholder's statement, so the dispute is
  legally the gateway's and not yours. That changes what the events mean, and it turns out to change it
  differently on all four. All four keep `capabilities.disputes: false`, now declared rather than
  implied.

  **Paddle: `chargeback_warning` is not a funds-untouched warning, and it now moves the row.** Paddle
  Billing has no `dispute.*` event at all — the whole dispute vocabulary is the `action` field on an
  adjustment. Both `chargeback` and `chargeback_warning` are now **`payment.disputed`**, which runs
  opposite to the Stripe and Adyen pre-dispute alerts on purpose: Paddle is the merchant of record and
  acts on the early warning instead of forwarding it, so "the disputed amount is refunded" the moment
  that adjustment is created. Mapping it to `payment.dispute_warning` writes nothing to the payment row
  and would leave it saying `paid` over money Paddle has already returned to the buyer. Paddle
  therefore sends **no** funds-untouched pre-dispute notification, and this driver does not invent one.

  `chargeback_reverse` and `chargeback_warning_reverse` now close the dispute as
  **`payment.dispute_closed` with `outcome: 'won'`** — both put the amount back, and leaving the row at
  `disputed` writes off money that returned. Every dispute event now carries the adjustment id as
  `disputeId` and the adjustment's `reason`. Only `adjustment.created` is a dispute moment;
  `adjustment.updated` stays `payment.updated`, because it fires for the approval lifecycle of an
  adjustment that already exists.

  **There is no `actionableUntil` on Paddle, and that is the finding, not a gap.** "The Paddle team
  contests chargebacks for you", and the defense "is fully automated, and additional evidence submitted
  by sellers is not required or accepted". No response window belongs to you and no adjustment field
  carries one.

  **Dodo: the whole lifecycle now has outcomes.** `dispute.won` → `won`, `dispute.lost` and
  `dispute.accepted` → `lost` (accepting without contest is a loss, not a cancellation),
  `dispute.expired` → `expired`, `dispute.cancelled` → `canceled`. `dispute.challenged` stays
  `payment.updated` — movement inside an open dispute. A `dispute.*` event whose `payload_type` is not
  `Dispute` degrades to `payment.updated` rather than a close the processor would throw on for carrying
  no outcome. The dispute's `remarks` now comes through as `reason`.

  `dispute.opened` stays `payment.disputed` at **every** `dispute_stage`, including `pre_dispute`.
  Dodo's reference says "Cardholder initiates dispute; funds are held" without qualifying it by stage,
  so downgrading a `pre_dispute` open to a warning would leave the row saying `paid` over money Dodo
  says it has already held. The stage travels on `event.data.disputeStage`.

  Dodo is the one MoR here where the fight and the clock are yours — ten days, evidence through the
  Dodo dashboard — but it sends **no deadline field**, so there is no `actionableUntil`. The driver
  deliberately does not derive `created_at + 10 days`: that would put a date the library invented into
  the one field an operator is meant to trust. The rule is documented on the provider page instead.

  **Lemon Squeezy and Polar send nothing at all, now proven rather than asserted.** Neither catalogue
  has a dispute or chargeback event; Lemon Squeezy has no `order_updated` either, so the `fraudulent`
  order status it uses for a charged-back order can never reach a webhook handler, and Polar's Order
  status enum has no charged-back value. Both gateways manage the dispute themselves and bill you the
  $15 network fee. Each driver now has a test asserting that **no** event it can receive produces
  `payment.disputed`, `payment.dispute_warning` or `payment.dispute_closed`, so a well-meaning future
  mapping cannot quietly invent one. Worth knowing on Polar: Rapid Dispute Resolution auto-refunds a
  dispute, so a chargeback genuinely can reach you as an ordinary `refund.created` — it stays
  `payment.refunded`, because that is what happened to the money.

  **If you have a handler on `payment.disputed`,** it now also fires for a Paddle `chargeback_warning`.
  That is the fix.

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

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add a **Paddle** driver — Paddle Billing (the v2 API on `api.paddle.com`), not the deprecated
  Paddle Classic vendors API. `payments.paddle({ apiKey, currency, sandbox, productId, webhookSecret })`,
  REST over `fetch`, no new peer dependency.

  Paddle is a merchant of record: it is the seller on your customer's statement, it remits sales tax
  and VAT worldwide, and it pays you out. That is why this driver refuses more than it implements, and
  the refusals are the point.

  **`charge()` throws.** Paddle has no endpoint that takes money — every payment is collected by
  Paddle Checkout or a Paddle-issued invoice. The closest thing, `POST /transactions`, creates an
  _unpaid_ record whose only route to payment is the checkout URL it returns, which is exactly what
  `createCheckout()` does. Returning a `Payment` from `charge()` would advertise a capture that never
  happened, so `createCheckout()` is the entry point and `charge()` says so.

  **`createSubscription()` throws.** Paddle's API has no create-subscription endpoint at all: Paddle
  creates one when a customer completes a checkout for a recurring price. Call
  `createCheckout({ planId })` and read the id off the `subscription.created` webhook.

  **`updateSubscription()` refuses `amount` and `description`.** Paddle has no editable amount on a
  subscription — you swap `items[].price_id` with a `proration_billing_mode`, which the shared input
  cannot express — and no description field. Only `metadata` is written, onto `custom_data`. Likewise
  `trialDays` on a checkout throws (a Paddle trial lives on the price), a `taxId` on a customer throws
  (Paddle keeps tax ids on a _business_), and a partial refund throws when the transaction has more
  than one line item, because Paddle refunds per line item and an `amount` alone cannot address one.

  **Money.** Paddle sends and receives amounts as **strings in the smallest unit** with the currency
  named separately — `"1990"` + `"USD"`. The package's integer cents convert at the driver boundary
  and nowhere else. `currency` is **required**, like Stripe's: Paddle bills in whatever the transaction
  names, so a default would be a guess at the app's country and a wrong guess succeeds silently.

  **Webhooks.** `Paddle-Signature: ts=…;h1=…`, HMAC-SHA256 over `` `${ts}:${rawBody}` `` in hex,
  compared timing-safe against the notification setting secret. Paddle always signs, so the driver
  refuses to parse without a configured secret rather than trusting the body. The timestamp check is
  opt-in via `webhookMaxAgeSeconds` — Paddle documents it as optional and its own SDK's five-second
  window would discard real events on a retry or a skewed clock. `externalReference` rides on
  `custom_data.external_reference` and is read back onto `event.data.externalReference`; because
  `CheckoutInput` has no `externalReference` field, pass it as `metadata.externalReference`.

  `supportedMethods` is `['undefined']` only — the transaction API takes no payment-method argument, so
  the driver cannot promise a charge will be a card, and routing `credit_card` here is correctly
  refused by the manager.

  Written against Paddle's published Billing API reference and covered by unit tests; **not yet
  exercised against a live Paddle account**. Verify in the sandbox before taking real money.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **New driver: Pagar.me** (Stone's Brazilian gateway, Core API v5) — `payments.pagarme()`.

  **Not yet run against a live account.** It is written against Pagar.me's published v5 API reference
  and covered by unit tests that stub the HTTP layer; nothing in it has touched a real Pagar.me
  account. Verify your flow in test mode (an `sk_test_…` key) before taking real money.

  Pix, boleto, credit and debit card, native subscriptions, payment links and marketplace splits,
  over `https://api.pagar.me/core/v5` via `fetch` (no SDK dependency). Authenticated with HTTP
  Basic: the secret key is the username and the password is empty. `PAGARME_SECRET_KEY` is the env
  fallback; there is no sandbox host, because a `sk_test_…` key is what puts the account in test
  mode.

  ```ts
  providers: {
    pagarme: payments.pagarme({ secretKey: env.get('PAGARME_SECRET_KEY') }),
  }
  ```

  **Money stays in centavos.** Asaas, AbacatePay and Woovi take decimal reais, so those drivers
  divide by 100 — Pagar.me's `amount` fields are already integer centavos, the same unit as this
  library's `Money`, and the driver does no conversion at all. R$ 19,90 is `1990` on both sides,
  including a `fixedValue` split share. Being BRL-only, it takes no `currency` option.

  **A charge is an order carrying one payment.** `POST /orders` with a single `items[]` line and one
  `payments[]` entry; the first charge the gateway creates is what comes back as the `Payment`, and
  that `ch_…` id is what `findPayment` and the `charge.*` webhooks then talk about.
  `externalReference` is sent as the order's `code` _and_ as `metadata.external_reference` — order
  metadata is repeated on every charge, which is what makes the reference survive into the webhook.
  On a checkout it becomes the payment link's `order_code`, which Pagar.me stamps as the `code` of
  every order the link produces; either way it comes back out on `event.data.externalReference`.

  **Webhooks are authenticated by Basic credentials, or not at all.** Pagar.me signs nothing; the
  dashboard offers optional HTTP Basic credentials on the webhook endpoint and no HMAC. Set
  `webhookUser`/`webhookPassword` (or `PAGARME_WEBHOOK_USER`/`PAGARME_WEBHOOK_PASSWORD`) and the
  driver rejects, timing-safe, any request that does not carry them.

  Three places where the driver refuses instead of pretending:

  - **`updateSubscription` throws.** A Pagar.me subscription has no amount or description of its own
    — the price lives on its _items_, changed through the subscription-item sub-resource. No request
    means what the contract's `{ amount, description }` means, so it refuses rather than returning a
    subscription the gateway never changed. Cancel and recreate, or edit the item.
  - **`supportedMethods` excludes `'undefined'`.** An order must name its `payment_method`, so "let
    the customer choose" exists only on a payment link, never on a charge. A charge with no `method`
    is refused rather than left to the account's dashboard defaults.
  - **A split rule naming both `percentualValue` and `fixedValue` throws.** A Pagar.me rule carries
    exactly one `type`, so there is no honest mapping for both.

  `cancelSubscription` cancels immediately — there is no period-end flag in the API. `atPeriodEnd:
true` sends `cancel_pending_invoices: false`, which leaves the current cycle's already-issued
  invoices payable; it does not keep the subscription running. `createCheckout` creates a payment
  link and ignores `cancelUrl`, because a link has only `flow_settings.success_url`. Chargebacks
  (`charge.chargedback`) normalize to `payment.updated`, since the contract has no dispute event —
  `event.raw.type` still names the original.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **PagBank (PagSeguro)** driver — the Orders API v4 (`api.pagseguro.com/orders`), Bearer
  token, Pix, credit and debit card, and boleto. BRL-only, so like the other Brazilian
  gateways it takes no `currency` option; there is nothing to choose.

  ```ts
  providers: {
    pagbank: payments.pagbank({
      token: env.get('PAGBANK_TOKEN'),
      notificationUrls: [`${env.get('APP_URL')}/payments/webhook/pagbank`],
    }),
  }
  ```

  Money is **integer centavos on both sides**. PagBank's `amount.value` is already the
  currency's smallest unit, so unlike the Asaas and Woovi drivers this one converts nothing —
  `1990` in your code is `1990` on the wire. Pix uses PagBank's current flow, where the charge
  carries `payment_method.type: 'PIX'` and the BR Code comes back on `charges[].qr_code.text`;
  the older order-level `qr_codes` shape is still read when one arrives.

  **Which id it reconciles on.** PagBank gives the same money an order id (`ORDE_…`) and a
  charge id (`CHAR_…`), and the webhook delivers the _order_. The driver therefore uses the
  order id as `gatewayId` everywhere — keying on the charge id would file the charge you
  created and the webhook confirming it under two different ids, and nothing would reconcile.
  `refund()` and `findPayment()` take either id and resolve the other themselves.
  `externalReference` is the order's `reference_id`, echoed on every notification, and
  `idempotencyKey` goes out as the `x-idempotency-key` header PagBank honours for 48 hours.

  **The webhook check is stated plainly rather than implied.** PagBank's `x-authenticity-token`
  is `sha256("<your API token>-<raw body>")`. The driver verifies it timing-safe on every
  notification and rejects anything missing, wrong, or computed over altered bytes — but it is
  **not an HMAC**. It is a secret prefix hashed with SHA-256, the textbook setup for a
  length-extension forgery (what saves it in practice is that the forged body carries binary
  padding in the middle, which `JSON.parse` refuses), and the secret is the API credential
  itself, so rotating one rotates the other. The provider page says so in as many words.
  `verifyWebhooks: false` exists for exactly one reason — PagBank's sandbox does not always
  send the header — and it leaves the endpoint open to anything that can reach it.

  **What it refuses,** loudly, with a `[payments]` message naming what to use instead:
  subscriptions (that is PagBank's separate Assinaturas API), every customer operation (the
  Orders API has no customer resource — the payer travels inline, and `customer: { name,
email, taxId }` is required on every charge), and the legacy form-encoded
  `notificationCode` notifications, which are a different API with no authenticity token at
  all. `listInvoices` returns `[]`: orders are indexed by their own id, not by customer.

  Written against PagBank's published API reference and covered by unit tests; **it has never
  talked to a live PagBank account.** Verify in the sandbox before taking real money.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Six ways the billing tables recorded the wrong amount of money — a won dispute vanishing from
  revenue, a partial refund never recorded at all, and a reconcile that moved historic revenue into
  the current month. Every one of them was silent.

  **`savePayment` no longer erases `paid_at` on a write that omits it.** The column was written
  unconditionally (`payment.paidAt ? ... : null`), while three of the processor's own handlers —
  `payment.refunded`, `payment.disputed`, `payment.dispute_closed` — call it without one, because a
  refund or dispute payload carries no settlement date. `revenue()` filters
  `status = 'paid' AND paid_at >= from AND paid_at < to`, so a dispute closed as **won** restored
  `status = 'paid'` with `paid_at = NULL` and the recovered money dropped out of every windowed
  revenue figure, permanently — `paid_at` is the only record of when a charge landed. Absent now means
  "not stated" and leaves the stored value alone, exactly like `externalReference`; pass `null` to
  clear it. `refundedAmount` follows the same rule. **If you have run a dispute to a won close, or a
  refund, on an earlier version, those rows have `paid_at = NULL` and are missing from your monthly
  revenue** — `payments:sync` can repair them from the gateway, or set the column from
  `billing_payments.payload` by hand.

  **New column: `billing_payments.refunded_amount`** (integer minor units, same units as `amount`,
  nullable). Added by `createBillingTables`' post-ship `ALTER` phase, so an existing install picks it
  up on the next boot with no new migration; it is also on the read side, as
  `PaymentListItem.refundedAmount`. Net revenue for a row is `amount - refunded_amount` — never a
  division.

  **`payment.updated` has a built-in sync.** It used to reach `default: return Promise.resolve()`, so
  the ledger row went to `processed` and nothing happened. On Asaas that is where a **partial refund**
  arrives (`PAYMENT_PARTIALLY_REFUNDED`) — deliberately, because `payment.refunded` writes the whole
  charge off — along with a deleted charge, a restored one, a denied refund and an undone cash
  receipt. It now keeps status, amount, refunded amount and settlement date current on a row that
  already exists, and publishes the `payment.updated` diagnostic that was declared and published by
  nothing. It never creates a row, and it never moves one out of `disputed`: only
  `payment.dispute_closed`, which carries an outcome, resolves a chargeback. `PaymentWebhookData`
  gains optional `status`, `paidAt` and `refundedAmount` for drivers that can normalize them; the
  Asaas driver now does, summing only refunds Asaas reports as settled.

  **`payment.succeeded` prefers the gateway's own settlement date** (`data.paidAt`) over the webhook's
  arrival time, so a redelivered or replayed confirmation is still filed in the month it was earned.

  **Asaas webhooks are deduplicated on Asaas' event id.** `parseWebhook` synthesized
  `` `${event}-${paymentId}` ``, which is a (payment, event-type) identity rather than an event
  identity — so the SECOND `PAYMENT_UPDATED` for a payment was silently discarded by the idempotency
  ledger as a replay of the first, and a partial refund arrives as exactly that type. Its
  `Math.random()` fallback also disabled deduplication entirely for any payload naming neither a
  payment nor a subscription. The driver now reads the `id` Asaas sends on the notification body, and
  falls back — only when there is none — to a SHA-256 digest of the raw body, which is deterministic:
  a genuine redelivery still deduplicates, two different notifications no longer collide.

  **Asaas `charge()` honours `idempotencyKey` instead of silently ignoring it.** Every other Asaas
  method refuses the key loudly ("Asaas has no idempotency mechanism … deduplicate before you call,
  e.g. by looking the record up by `externalReference` first"); `charge()` alone quietly repurposed it
  as an `externalReference` fallback, so an app passing `idempotencyKey: order.id` on the one call
  that moves money got no protection and no warning. The driver now performs that documented lookup
  itself: with a key, it searches `GET /payments?externalReference=…&customer=…` first and returns the
  existing charge — Pix code attached — instead of creating a second one. A deduplicated call emits no
  fiscal invoice and publishes no `charge.created` diagnostic, because nothing was charged. It is one
  request, not a lock: two concurrent calls with the same key can still both create.

  **Asaas `listInvoices` pages.** It issued `GET /payments?customer=…` with no `limit`/`offset` and no
  loop, while Asaas pages that endpoint — so `payments:sync` printed a confident "N invoice(s) synced"
  covering only the newest page and left older charges unreconciled with no way to tell. It now
  follows `hasMore` to the end, and throws rather than truncating if a gateway never stops.

  **`payments:sync` reconciles in both directions, and stops inventing settlement dates.** It wrote
  `status: 'paid'` and counted everything else as "skipped (non-paid)", so a local row saying `paid`
  while the gateway said refunded or charged back could never be corrected — the exact drift a
  gateway-is-truth reconcile exists for. It also stamped `paidAt: new Date()`, so running it in two
  months counted the same charge in both. It now asks the gateway's payment resource (which speaks
  `BillingStatus`, unlike `Invoice.status`, whose vocabulary has no `refunded`) and writes that status
  in either direction, using the gateway's own settlement date or none at all, and never overwriting a
  `paid_at` already recorded. **One local state is never overwritten from the gateway: `disputed`** —
  the gateway's payment resource usually still reports a disputed charge as received, so reconciling it
  back to `paid` would re-count money the bank has pulled back. Those rows are reported and left alone.
  The per-customer output now reads `reconciled / already current / undecidable` rather than
  `synced / skipped`.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add the browser-facing payment status endpoint, plus a new `@adonis-agora/payments-react` package with the `usePaymentStatus` hook that polls it.

  A Pix QR code (or a boleto) is not paid until the gateway's webhook confirms it, seconds to days later. Every app that takes Pix hand-writes the same polling loop, and most write it without backoff, without a stop condition, and without cleanup on unmount.

  **Server.** A new opt-in config (`config/payments_client.ts`) and provider (`@adonis-agora/payments/payments_client_provider`) mounting one route:

  ```
  GET /payments/client/status?reference=<reference>
  -> { status, amount, currency, paidAt }
  ```

  Disabled by default — unlike the dashboard, this endpoint is reachable by every logged-in browser. The response is deliberately four fields: no payload, no customer, no gateway ids.

  Ownership is enforced ahead of the lookup. `authorize` decides whether the request may exist (default: a user resolved structurally off `ctx.auth`, so authkit, `@adonisjs/auth` and a custom guard all work and none is a dependency), `owner` says who is asking, and `authorizeReference` decides whether that caller may see this payment. The default `authorizeReference` checks the payment's gateway customer against the one the owner holds in `billing_customers`; an app that never recorded that mapping is **denied** with a message telling it to use `ensureCustomer({ store, owner })` or supply its own hook — never silently allowed. Every answer carries `Cache-Control: no-store` and costs one indexed read, with no gateway call.

  **Browser.** `usePaymentStatus(reference)` polls with backoff (2s, growing, capped at 30s) and stops on a terminal status, on unmount, while the tab is hidden (resuming on focus), and on a `401`/`403`. Errors are surfaced, never thrown. No context provider and no data-fetching dependency.

  It does **not** wrap any gateway's card SDK — Stripe, Mercado Pago and Adyen ship their own.

  See the new [Client polling](https://agora.goflip.ai/docs/payments/client) page, including how to write your own `authorize`/`owner`/`authorizeReference` and how to build the endpoint from scratch as an ordinary controller.

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

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **New gateway: PayPal** — `payments.paypal({ clientId, clientSecret, currency, sandbox, webhookId })`.
  Orders v2 for money in, Payments v2 for refunds, Subscriptions v1 for recurring billing, over OAuth2
  client credentials. Plain REST, no SDK, no new peer dependency.

  Multi-currency, so `currency` is required with no default, like Stripe's. Amounts go out as the
  decimal string PayPal wants with the decimal places that currency allows — `"19.90"` for USD,
  `"1990"` for JPY. HUF and TWD are refused when the amount is not a whole unit: PayPal rejects
  decimals for both even though ISO 4217 gives them two minor units. The OAuth token is cached for
  exactly as long as PayPal's own `expires_in` says and no longer, so a long-running process cannot
  hold a token past its life and start 401ing an hour into a deploy.

  **PayPal is a wallet, so `charge()` refuses more than it accepts.** A payment normally needs the
  payer to approve it on paypal.com, which no server call can stand in for: `createCheckout` is the
  entry point and returns the approval URL. `charge()` works only against an already-vaulted payment
  method (`paymentMethodId` = a Vault v3 token id) and throws otherwise, rather than fake a payment
  nobody approved. It also requires an `idempotencyKey` — it becomes the `PayPal-Request-Id` header
  PayPal documents as mandatory there, and generating one internally would defeat the point.

  **Webhook verification is an API call.** PayPal has no local HMAC: you POST the headers and the event
  to `/v1/notifications/verify-webhook-signature`, so every webhook the mounted route handles costs a
  round trip to PayPal, plus an OAuth call whenever the cached token has expired. Worth knowing before
  pointing a high-volume webhook at it. With no `webhookId` configured there is nothing to verify
  against and the event is parsed unverified, the same rule the other drivers use.

  `externalReference` maps to `custom_id` (not `reference_id`, which does not survive onto the capture)
  and is read back out of `custom_id` on `PAYMENT.CAPTURE.*` events and `custom` on the
  `PAYMENT.SALE.*` events a subscription's charges arrive as.

  **What else it refuses**: the customer methods (PayPal has no customer resource — the id is one you
  choose, created as a side effect of vaulting); `listInvoices` (no customer filter exists);
  `createSubscription` with `amount`/`cycle`/`trialDays` (all three live on the PayPal plan, so
  accepting them would report a price the gateway never charges); `cancelSubscription({ atPeriodEnd })`;
  and a subscription `description`. `updateSubscription({ amount })` does reprice at the gateway, and
  reads the subscription first so it patches the REGULAR billing cycle rather than a plan's trial.

  Written against PayPal's published API reference and covered by unit tests; it has not been run
  against a live PayPal account. Verify in sandbox before taking real money.

- [#5](https://github.com/DavideCarvalho/adonis-agora-payments/pull/5) [`1db1891`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/1db1891cad2481c468169de8398ffb307befb01a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Rename the Pix fields on `Payment` to say what they actually hold: `pixQrCodeImage` and `pixCode`.

  The two old names described the wrong things. `pixQrCode` never held a code — it held a base64 PNG
  of the QR image, so `<img src={payment.pixQrCode}>` was the only correct use of a field that read
  like a string you could copy. The value the customer _does_ copy and paste, the BR Code (EMV
  payload), was hidden behind `pixCopiaECola`, a Portuguese name in an otherwise English API.

  The normalized `Payment` now exposes:

  - `pixQrCodeImage` — base64-encoded PNG of the QR code, for rendering.
  - `pixCode` — the BR Code / EMV payload, the copy-paste string.

  **Nothing breaks.** `pixQrCode` and `pixCopiaECola` remain on the type as `@deprecated` optional
  fields, and every driver (Asaas, Woovi, AbacatePay) populates both the new and the old name with the
  same value. Existing code keeps working; move to the new names at your own pace.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add the Polar driver (`payments.polar()`) — merchant-of-record billing for software, over
  the REST API (spec version `2026-04`) with no SDK dependency.

  Polar is the legal seller of record and handles sales tax and VAT worldwide. That is a
  business arrangement the library does not model, but it decides the shape of the driver: a
  merchant of record controls the purchase surface, so **Polar has no direct charge
  endpoint**. Prices live on products you create in Polar, and money moves through Polar's
  own checkout.

  **Supports** cards (plus the wallets and local methods Polar enables per country) through
  `createCheckout()`, orders as the canonical `Payment`, full and partial refunds,
  subscriptions, and orders-as-invoices. Amounts are already integers in the currency's
  smallest unit, so nothing is converted. `currency` is required — Polar bills in whatever
  you hand it, and a default would be a guess at the app's country that succeeds when it is
  wrong. Requests pin `Polar-Version: 2026-04` so a future default flip cannot move the wire
  format underneath you.

  **Refuses**, rather than reporting a change Polar never made:

  - `charge()` — there is no charge endpoint. Polar's two-step off-session route
    (`POST /v1/orders/` then `/finalize`) is behind a preview feature flag, is paid-plan
    only and needs a saved payment method, so the driver does not present it as the general
    case. The error points at `createCheckout()`.
  - `createSubscription({ amount | cycle })` — the price and interval belong to the product;
    dropping an `amount` would bill a figure nobody chose.
  - `createSubscription({ trialDays })` — Polar sets trials on the checkout, not on the
    subscriptions endpoint.
  - `createSubscription({ card })` — there is no tokenized-card input.
  - `updateSubscription({ amount | description })` — a Polar subscription has neither field.
    A plan switch goes through `metadata.productId`.

  `createSubscription()` itself calls `POST /v1/subscriptions/`, which Polar allows **only
  for free products**; a paid plan has to go through checkout.

  `externalReference` maps to `metadata.external_reference`, which Polar copies from the
  checkout onto the order and the subscription — the only thing tying an `order.paid` back to
  your own row. `refund()` with no amount reads the order's `refundable_amount` rather than
  its total, because Polar's refund amount is the net figure and it refunds tax alongside it.

  Webhooks are verified against the Standard Webhooks scheme with a ±5 minute replay window.
  One trap worth naming: Polar's HMAC key is the **raw UTF-8 bytes of the secret**, `whsec_`
  prefix included — not the base64-decoded bytes the spec's default derivation (and Dodo
  Payments) uses. Its own SDK base64-encodes the secret before handing it to the reference
  library, which decodes it right back.

  Written against the published API reference and covered by unit tests; **not yet exercised
  against a live Polar account.** Verify in the sandbox before taking real money.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A won dispute now stops counting as lost revenue, and the two dispute events reach the diagnostics
  bus they were declared on.

  `payment.dispute_warning` and `payment.dispute_closed` existed on the bus with payload types and were
  published by **nothing at all** — the drivers emitted them, the processor's switch had no case, so
  they fell to the no-op branch. That is the same shape as the bugs this package has spent a release
  removing: declared, typed, documented, wired to nothing.

  - **`payment.dispute_closed` with `outcome: 'won'` puts the payment row back to `paid`.** A
    chargeback moves it to `disputed` and it stayed there forever; `revenue()` sums rows that are
    `paid`, so money that came back was written off permanently. Only `won` moves it. `lost` and
    `expired` are money that is gone, and `canceled` — the cardholder withdrawing — is deliberately
    **not** treated as a win: on Stripe a withdrawn dispute still has to be closed in your favour with
    evidence, so booking it would count revenue the acquirer has not returned. The row keeps its own
    amount, because a dispute's amount can differ from the charge's.
  - **A close with no `outcome` is refused.** It throws rather than defaulting, because defaulting
    would report a result the gateway never sent — a driver that cannot read the outcome is supposed to
    emit `payment.updated` instead, which both Stripe and Adyen do.
  - **`payment.dispute_warning` writes nothing.** No money has moved, so a payment that says `paid` is
    telling the truth. It publishes on the bus, carrying `reason` and `actionableUntil`, so a
    subscriber can put the alert in front of somebody while a refund still prevents the chargeback.
  - **`DisputeWebhookData` and `isDisputeWebhookData`** are exported. The guard is looser than the
    payment one on purpose: Stripe's early fraud warning object carries no amount or currency at all,
    and refusing it for that would throw away the earliest warning the library gets.

  Also documents `payment.disputed` on the diagnostics page, which the processor has published since it
  was added and the table never listed — plus a test that fails when any event on the bus is missing
  from that table.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **New driver: Razorpay** (India's dominant gateway, v1 API) — `payments.razorpay()`.

  **Not yet run against a live account.** It is written against Razorpay's published v1 API
  reference and covered by unit tests that stub the HTTP layer; nothing in it has touched a real
  Razorpay account. Verify your flow with `rzp_test_…` keys before taking real money.

  Orders, payments, refunds, payment links, native subscriptions and invoices over
  `https://api.razorpay.com/v1` via `fetch` (no SDK dependency). HTTP Basic auth with the key id
  as username and the key secret as password; `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` are the env
  fallbacks. There is no `sandbox` option, because test mode is a property of the key pair rather
  than of a different host. Multi-currency, so `currency` is required and has no default.

  ```ts
  providers: {
    razorpay: payments.razorpay({ currency: 'inr' }),
  }
  ```

  **Money stays in paise.** Razorpay's `amount` is already the integer minor unit, the same unit as
  this library's `Money`, so the driver does no conversion at all — ₹1990.00 is `199000` on both
  sides. The Brazilian drivers around it divide by 100 because their gateways want decimal reais;
  doing that here would bill a hundredth of the charge, and Razorpay would accept it.

  **`charge()` creates an order.** Razorpay has no server-side "charge this customer" call: you
  create an order and the payer settles it in Razorpay Checkout. So `charge()` returns a `pending`
  payment whose `gatewayId` is the `order_…` id you hand to Checkout, `findPayment()` accepts an
  order, payment or payment-link id, and `refund()` accepts only a `pay_…` id. `idempotencyKey`
  becomes the order's `receipt` (account-level unique, 40 characters).

  **`externalReference`** rides in `notes.external_reference` on orders and subscriptions, and as
  `reference_id` on payment links; `parseWebhook` looks for it on every entity the event carries,
  because the API reference does not state that an order's notes are copied onto its payment.

  **Webhooks** are a hex HMAC-SHA256 over the raw body in `X-Razorpay-Signature`, verified
  timing-safe and rejected when missing or wrong; skipped only when no webhook secret is
  configured, so local development works. `event.id` is Razorpay's `x-razorpay-event-id`.

  Where it refuses instead of pretending:

  - **`supportedMethods` is `['undefined']` only.** An order names no instrument, and UPI — the
    method most Indian payers use — has no member in this package's `PaymentMethodName` union.
    Mapping it onto `pix` because both are instant bank rails would put a Brazilian label on an
    Indian payment, so the driver declares nothing it cannot promise; routing `credit_card` to it
    fails at the manager and `charge({ method })` throws. Read `payment.method` off the webhook.
  - **`authorized` maps to `pending`, not `paid`.** `BillingStatus` has no name for money that is
    held but not captured, and Razorpay voids an uncaptured authorization on its own. A
    `payment.authorized` webhook normalizes to `payment.updated`. `capturePayment()` (outside the
    driver contract) finishes the job for accounts with auto-capture off.
  - **`createSubscription` refuses `amount`, `cycle`, `method` and `card`** — all four live on the
    plan or on Razorpay's hosted authorization link — and refuses a subscription with no
    `metadata.totalCount`, because Razorpay has no open-ended subscription and guessing the number
    of cycles would silently cap or over-run the customer's billing.
  - **`updateSubscription` refuses `amount` and `description`.** Plans are immutable and a
    subscription has no description; it accepts a real plan swap or quantity change through
    `metadata`, sent with `schedule_change_at: 'now'` so the answer is not the old subscription.
  - **`charge({ card | paymentMethodId })` and `charge({ split })` throw**, as does
    `createCheckout({ cancelUrl })` and `createCheckout({ planId })`.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `payments.driver('pix')` picked the provider and then told it nothing.

  Routing resolved a gateway by payment method and handed back the plain driver, so the method itself
  only reached the charge when the caller repeated it — `driver('pix').charge({ method: 'pix' })`.
  Every driver that varies by method reads it off the charge: Stripe's `payment_method_types`, Asaas'
  and AbacatePay's `billingType`. Without it the charge was created with whatever the gateway's
  dashboard defaults are. It read as working, and a charge routed as Pix could come back a card.

  `driver(method)` now returns the driver **bound to that method**, filling it in on `charge` and
  `createSubscription` — the two inputs that carry one:

  ```ts
  getPayments().driver("pix").charge({ amount: 1990 });
  // reaches the driver as { amount: 1990, method: 'pix' }
  ```

  An explicit method on the input still wins: routing is a default, not an override. A driver resolved
  by **name** comes back untouched, because `driver('stripe')` routed nothing and has nothing to
  thread. Repeated calls return the same object, so a caller can hold on to one.

  **One behavior change worth knowing about:** `driver('pix')` no longer returns the identical object
  you put in the config map — it returns a method-bound view of it. `provider`, `supportedMethods`,
  `capabilities` and every method behave exactly as before, and absent optional members stay absent
  (the binding is a Proxy for that reason: a wrapper defining every method would turn "this gateway
  cannot do that" into "it can, until you call it"). Only reference equality against the raw driver
  instance changes, and only on the method-routed path.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **New driver: Square** (Connect v2) — `payments.square()`.

  **Not yet run against a live account.** It is written against Square's published Connect v2 API
  reference and covered by unit tests that stub the HTTP layer; nothing in it has touched a real
  Square account. Verify your flow in the Square Sandbox (`sandbox: true`) before taking real money.

  Payments, refunds, customers, hosted payment links, native subscriptions and invoice search over
  `https://connect.squareup.com/v2` via `fetch` (no SDK dependency). Bearer access token,
  `SQUARE_ACCESS_TOKEN` / `SQUARE_LOCATION_ID` as env fallbacks, and a pinned `Square-Version`
  header (`2026-08-19`) so a Square release cannot change response shapes underneath the mappings.
  Multi-currency, so `currency` is required; `locationId` is required too and fails at **boot**,
  because Square's "defaults to the main location" fallback would otherwise book money against
  whichever location the account happens to list first.

  ```ts
  providers: {
    square: payments.square({ locationId: env.get('SQUARE_LOCATION_ID'), currency: 'usd' }),
  }
  ```

  **Money stays in integer minor units.** Square's `{ amount: 1990, currency: 'USD' }` is the same
  unit as this library's `Money`, so the driver converts nothing — $19.90 is `1990` on both sides,
  and ¥1990 is `1990` too, which a hardcoded `/100` would have billed as ¥19.90.

  **`idempotency_key` is a body field**, not a header, on payments, refunds, subscriptions and
  payment links; `idempotencyKey` maps straight onto it. Square requires one on payments and
  refunds, so a call without it gets a generated UUID — enough for Square's own retry, not for
  yours.

  **`externalReference`** is `reference_id` on a payment. On a checkout it goes to the order's
  `reference_id`, the order's `metadata.external_reference` and the link's `payment_note` at once,
  because a Square `PaymentLink` has no reference field of its own; `parseWebhook` reads
  `payment.reference_id` and falls back to `payment.note`. Square's published payment webhook
  examples do not show `reference_id`, so the docs page flags the hosted-link round trip as
  to-be-confirmed in Sandbox and names `event.data.orderId` as the fallback.

  **Webhooks sign `notificationUrl + rawBody`** as a base64 HMAC-SHA256 in
  `x-square-hmacsha256-signature`. The URL is part of the signed material, so the driver must be
  told its own public address: configuring `webhookSignatureKey` **without** `notificationUrl`
  throws at boot rather than rejecting every genuine webhook or quietly skipping verification.
  With neither configured, verification is skipped so local development works.

  Where it refuses instead of pretending:

  - **`charge()` requires a `source_id`.** Square has no server-side "charge this customer" call, so
    a charge without `paymentMethodId` (or `card.token`) throws instead of inventing a flow.
  - **`APPROVED` maps to `pending`, not `paid`**, and a fully refunded payment reads `refunded` even
    though Square keeps calling it `COMPLETED`. `completePayment()` (outside the driver contract)
    captures a delayed-capture payment.
  - **`cancelSubscription(id, { atPeriodEnd: false })` throws.** Square's cancel always schedules
    for the end of the billing period; reporting an immediate cancellation would be a lie.
  - **`updateSubscription` refuses `amount` and `description`.** Square will not reprice a live
    subscription — `metadata: { planVariationId }` runs a real `swap-plan`, and
    `metadata: { cardId }` changes the card on file.
  - **`createSubscription` refuses `externalReference`.** A Square subscription has no reference or
    metadata field at all, so it would be silently dropped and could never come back on
    `subscription.updated`.
  - **`createSubscription` also refuses `cycle`, `trialDays`, `method` and `card`** — the cadence and
    the free trial live on the plan variation, and a Web Payments SDK token is single-use and must
    be saved with `POST /v2/cards` first.
  - **`createCustomer({ taxId })` throws** unless `metadata.taxIdType === 'eu_vat'`: a Square
    customer has exactly one tax field and no general-purpose one.
  - **`charge({ split })` and `createCheckout({ cancelUrl | trialDays })` throw.**

  `supportedMethods` is `credit_card`, `debit_card` and `undefined` — the instrument is fixed by the
  browser token, not by the call, and a Cash App or Afterpay payment leaves `Payment.method` unset
  rather than being labelled a card.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stripe's `charge.dispute.created` fires for two different things, and the driver read both as one.

  A **chargeback** means the cardholder's bank has already pulled the money back. An **inquiry** — the
  pre-dispute phase, called a retrieval or a request for information — means the bank is asking a
  question and **no funds have been withdrawn**. Stripe distinguishes them only by a status prefix:
  an inquiry's `status` starts with `warning_`. The driver ignored the status, so an inquiry moved the
  payment row to `disputed` and took a paid payment away over a question.

  Now a chargeback stays `payment.disputed`, and an inquiry becomes **`payment.dispute_warning`** and
  moves nothing — the payment is still paid, because it is. The inquiry payload's
  `evidence_details.due_by` is carried through as `actionableUntil`, which is the whole value of the
  alert: Stripe's own guidance is that leaving an inquiry unanswered reads to the issuer as accepting
  the claim, and can produce a chargeback that is probably irreversible.

  **`radar.early_fraud_warning.created` is now a `payment.dispute_warning` too.** It was passing
  through under its raw Stripe name — visible in the ledger, but not something a handler could react
  to without knowing Stripe's event vocabulary. It is the issuer's TC40/SAFE fraud report, arriving
  before any dispute exists; Stripe's published figure is that around 80% of them become a fraud
  dispute if you do nothing. It carries no deadline — the window closes when the chargeback is filed —
  so it carries Stripe's `actionable` flag and `fraud_type` as `reason` instead.

  **`charge.dispute.closed` now carries the outcome.** It normalizes to `payment.dispute_closed` with
  `outcome: 'won' | 'lost' | 'expired'`. `warning_closed` — an inquiry that sat 120 days without
  escalating — is `expired` rather than `won`, because the networks send no explicit win for an
  inquiry: nothing was decided in your favour, the clock ran out the right way. A close whose status
  the driver cannot read stays a `payment.updated` rather than inventing a result.

  `charge.dispute.updated`, `.funds_withdrawn` and `.funds_reinstated` are unchanged: movement inside
  an open dispute, not a resolution of it.

  **If you have a handler on `payment.disputed`,** it will no longer fire for inquiries. That is the
  fix, but it is a behavior change: if you were relying on it to hear about inquiries at all, handle
  `payment.dispute_warning` as well.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Paddle, Lemon Squeezy, Polar, Dodo Payments, Mollie and Efí adopt the widened contract.
  Four of the six were telling the billing layer something that was not true, and one of
  those lies handed paying-customer entitlement to people who had stopped paying.

  **Breaking: a paused subscription is now `paused`, not `active`.** Paddle, Lemon Squeezy,
  Polar and Dodo all have a real paused state, and all four mapped it to `active` because
  `SubscriptionStatus` had no other word. It does now. A paused subscription exists and will
  bill again, but it is **not billing right now**, so reporting `active` granted access to
  someone who is not paying. Anything gating on `subscription.status === 'active'` will start
  refusing paused subscribers — that is the fix, not a regression. The gateway's own value is
  still on `subscription.payload.status` if you were relying on the old behaviour deliberately.

  **Chargebacks reach `payment.disputed`, where a gateway has one.**

  - **Paddle** has no `dispute.*` event: a chargeback _is_ an adjustment. `adjustment.created`
    with `action: 'chargeback'` — the only notification a Paddle seller gets that revenue was
    taken away — used to arrive as a bland `payment.updated`, leaving the stored payment
    saying `paid`. It is now `payment.disputed`, keyed by the transaction.
    `chargeback_warning`, `chargeback_reverse` and a later `adjustment.updated` stay
    `payment.updated`.
  - **Dodo Payments** forwards the whole dispute lifecycle even though it bears the
    liability. `dispute.opened` → `payment.disputed`, keyed by the payment, with `disputeId`,
    `disputeStage` and `disputeStatus` on `event.data` (the amount is read as cents whether
    Dodo sends a number or a decimal string). `won`, `lost`, `challenged`, `accepted`,
    `cancelled` and `expired` → `payment.updated`.
  - **Mollie** reports one two ways. On the classic webhook a chargeback re-fires the
    payment's `webhookUrl` with the same bare id and leaves `status` at `paid` — only
    `amountChargedBack` on the fetched payment says the bank pulled the money back, so the
    driver reads it and reports `payment.disputed`. On next-gen webhooks
    `chargeback.received` → `payment.disputed` and `chargeback.reversed` → `payment.updated`.
    A chargeback cannot be read back on its own (Mollie has no lookup by chargeback id), so
    an **id-only** next-gen chargeback event now throws and tells you to switch the webhook to
    the snapshot payload, rather than passing the money event through inert.
  - **Polar, Lemon Squeezy and Efí genuinely have no dispute notification**, and the drivers
    do not invent one. For the two merchants of record that is the deal, not a gap: the
    chargeback is raised against them and they absorb it, fee and representment included —
    and it is a large part of why anyone picks an MoR. Efí is Pix, which has no chargeback at
    all. Each provider page says so.

  **Mollie also fixes an event-id collision this uncovered.** Mollie's own `status` stays
  `paid` through both a refund and a chargeback, so `mollie:<id>:<status>` produced an event
  id byte-identical to the earlier `payment.succeeded` one — and the idempotency ledger
  discarded the webhook that takes the money away as a replay. Those two transitions now get
  a `:refunded` / `:chargeback` suffix.

  **`authorized` where the gateway separates authorization from capture.** Mollie's
  `authorized` payment status and Dodo's `requires_capture` both used to collapse into
  `pending`, which understated a held authorization. Dodo's `partially_captured` and
  `partially_captured_and_capturable` deliberately stay `pending`: part of the authorization
  has already settled, so "nothing captured" would be as wrong as `paid`.

  **Payment methods are categories now, and Mollie and Dodo can finally route them.**

  - **Mollie** goes from `credit_card | undefined` to `credit_card`, `bank_transfer`,
    `bank_debit`, `wallet`, `bnpl`, `voucher`, `undefined`. iDEAL, Bancontact, SEPA Direct
    Debit, PayPal, Klarna, Apple Pay, EPS, Przelewy24, BLIK, TWINT, MB WAY, Multibanco,
    Trustly, paysafecard and vouchers were all unroutable; each now sits in a category, and a
    category goes out as Mollie's own `method` **array** — which is exactly what a category
    is, since `bank_transfer` is iDEAL in the Netherlands and Bancontact in Belgium. To pin
    one brand, name it in the gateway's own field: `metadata.mollieMethod: 'ideal'`, validated
    against the category. `payment.method` comes back as the category too. `debit_card` is
    still refused, and re-checking confirmed why: Mollie folds debit cards into the single
    `creditcard` id and has no debit-only method to ask for.
  - **Dodo Payments** adds `upi`, `wallet`, `bank_transfer`, `bank_debit` and `bnpl` to
    `credit_card`, `debit_card` and `pix`, each mapping to the `allowed_payment_method_types`
    in it (plus the `credit`/`debit` fallbacks Dodo tells you to keep, because a checkout
    whose every listed method is unavailable simply fails). `payment.method` reports the
    category, so iDEAL/SEPA/Klarna/Apple Pay/UPI payments stop coming back `unknown`.
  - **Paddle** cannot route (its transaction API takes no payment-method argument, so
    `supportedMethods` stays `undefined`), but it _reports_: `method_details.type` now maps
    onto `wallet` (PayPal, Apple/Google/Samsung Pay, Alipay, WeChat Pay, the Korean wallets),
    `bank_transfer` (iDEAL, Bancontact, BLIK, MB WAY, wire), `pix` and `upi`. Only `card` had
    a name before.

  **`idempotencyKey` is honoured where it deduplicates and refused where it does not.**

  - **Mollie** sends `Idempotency-Key` on every POST it makes — now including `refund`,
    `createCustomer` and `createSubscription`, not just `charge` and `createCheckout`.
    `updateSubscription` **throws**: Mollie accepts the header on POST only, and a `PATCH` is
    repeatable by nature, so accepting a key there promised a deduplication Mollie never
    performs.
  - **Polar** sends `Idempotency-Key`, which it documents for POST, PATCH and DELETE, on
    `createCheckout`, `refund`, `createCustomer`, `createSubscription` and
    `updateSubscription`.
  - **Efí** uses the key as the **devolução id** in `PUT /v2/pix/{e2eid}/devolucao/{id}` —
    the id _is_ the deduplication on that API. BACEN allows 1–35 alphanumerics, so a key
    outside that charset throws instead of being silently replaced by a random id.
  - **Paddle, Lemon Squeezy and Dodo Payments have no deduplication mechanism at all**, so
    every entry point that takes a key now **throws** instead of accepting and dropping it.
    Paddle's `createCheckout` and Dodo's `charge`/`createCheckout` were previously accepting
    a key and ignoring it, which turned a caller's retry guarantee into a second charge. This
    is a behaviour change for anyone passing a key to those three: catch it, and deduplicate
    on your side by persisting the key before you call.

  **`listInvoices` throws on Efí** instead of answering `[]`. An empty list is
  indistinguishable from "this customer has no invoices", which is the same silent shape as
  the bugs above; `capabilities.invoices` is `false`, so `PaymentsManager.assertCapability`
  already stops the documented path and the message is for whoever reaches the driver directly.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Telescope as a debugger, not a second dashboard: three new diagnostics that answer why one
  payment behaved the way it did.

  - **`gateway.request` / `gateway.request.failed`** — every call through the shared
    `httpRequest` transport now records provider, method, host, path, redacted query, HTTP
    status and duration, including the two outcomes that previously left no trace anywhere:
    a timeout and a non-2xx. Credentials are never recorded — headers are omitted entirely,
    credential-shaped query values are replaced with `[redacted]`, and the recorded error is
    built fresh rather than reusing the thrown one (which quotes the full URL). Request and
    response bodies are opt-in and off by default behind
    `configurePaymentsDiagnostics({ recordHttpBodies: true })`, because a charge body carries
    card and CPF data.
  - **`webhook.verification`** — says whether a delivery's signature verified and under which
    scheme (`hmac-sha256`, `standard-webhooks`, `rsa-sha256`, `sha256-token-prefix`,
    `shared-token`), or that nothing verified it through the shared helpers, which is the
    usual answer to "why is my endpoint unauthenticated". Fed automatically by
    `webhook_security`'s primitives; `reportWebhookVerification()` is exported so a driver
    verifying inside its own SDK can report too.
  - **Per-delivery correlation** — the webhook route opens an `AsyncLocalStorage` trace per
    delivery attempt, and every payments event published inside it is stamped with the same
    `traceId`, so received → verified → ledgered → handler → synced reads as one chain for
    one event. `PaymentsWatcher` surfaces it, preferring the envelope's own trace id.

  `PaymentsWatcher` entries are now shaped rather than spread blindly: `event`, `traceId`,
  then the fields you scan a timeline by, then the rest of the payload.

### Patch Changes

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Two Asaas statuses meaning **the customer paid** were reading as unpaid.

  `RECEIVED_IN_CASH` — a receipt confirmed by hand in the Asaas UI, the customer paid at the counter —
  and `DUNNING_RECEIVED` — the debt settled through the credit bureau after a _negativação_ — both
  fell through the status map's `pending` default. So someone who had paid read as never having paid,
  and stayed locked out of what they bought. `PAYMENT_DUNNING_RECEIVED` also had no webhook mapping,
  which meant the one event announcing that a written-off debt came back ran no sync at all.

  The rest of the statuses Asaas has and the driver did not, now that they are all named rather than
  silently agreeing with a default:

  - `REFUND_REQUESTED` and `REFUND_IN_PROGRESS` stay **`paid`**. A refund asked for or scheduled has
    settled in neither case, and Asaas can still deny one (`PAYMENT_REFUND_DENIED`). `pending` claimed
    the charge was never paid; `refunded` would write off money still in the account.
  - `DUNNING_REQUESTED` is **`failed`** — overdue and escalated, same as `OVERDUE`.
  - `AWAITING_RISK_ANALYSIS` is **`pending`**, which the default already got right by accident and now
    says on purpose. Asaas' own guidance is to wait before releasing the product.

  New webhook mappings: `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED` and `PAYMENT_REPROVED_BY_RISK_ANALYSIS`
  → `payment.failed`. `PAYMENT_PARTIALLY_REFUNDED` → **`payment.updated`, deliberately not
  `payment.refunded`**: that handler overwrites the row's status with `refunded` and its amount with
  the refunded amount, so routing a R$10 refund on a R$100 charge there would drop R$90 of revenue
  instead of subtracting R$10. Until the billing tables carry a refunded amount, an update is the
  arithmetic-safe half. `PAYMENT_REFUND_IN_PROGRESS`, `PAYMENT_REFUND_DENIED`,
  `PAYMENT_AWAITING_RISK_ANALYSIS`, `PAYMENT_APPROVED_BY_RISK_ANALYSIS`, `PAYMENT_DUNNING_REQUESTED`,
  `PAYMENT_RECEIVED_IN_CASH_UNDONE`, `PAYMENT_DELETED` and `PAYMENT_RESTORED` are updates too — named
  rather than arriving as unrecognized types.

  **If you were compensating for this** — treating `pending` Asaas rows as possibly-paid, or polling
  `findPayment` after a dunning — you can stop. Rows that were already wrong stay wrong until the
  payment is re-synced; `payments:sync` fixes them.

- [#4](https://github.com/DavideCarvalho/adonis-agora-payments/pull/4) [`c27c81e`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/c27c81e022661b2931553fc152cb675ff7bb27c8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `node ace add` now registers the webhook-handlers Assembler hook itself, so nothing has to be added
  to `adonisrc.ts` by hand.

  The docs also overstated what that hook does. Discovery of `app/payment_handlers/` has always worked
  without it — the provider falls back to scanning the folder at boot — so a handler scaffolded with
  `make:webhook-handler` was already picked up. The hook generates a build-time barrel that removes the
  scan; it is an optimization, not a requirement, and the pages that presented it as a required step
  now say so.

  Also documents the worker that `dispatcher: 'durable'` and `'queue'` depend on (`durable:work` /
  `queue:listen`) — without it webhooks are accepted and enqueued but never processed, while the
  endpoint keeps answering `200`.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A dispute **lost** now takes the payment row off `paid`, even when no `payment.disputed` ever
  arrived.

  The processor moved the row back to `paid` on a won close and left every other outcome alone, which
  quietly assumed a chargeback event had already moved it to `disputed`. Several gateways never send
  one: Razorpay documents that it does not debit provisionally at all, PayPal's dispute opens at an
  inquiry stage that takes nothing, and Woovi only blocks the balance during a Pix MED. On those the
  sequence is `payment.dispute_warning` → `payment.dispute_closed` with `lost`, and nothing in between
  ever moved the row — so a payment whose money is definitively gone kept reading `paid`, and
  `revenue()` kept counting it.

  `expired` and `canceled` still move nothing, deliberately. Expired means the window closed with no
  verdict published; canceled means the cardholder withdrew, and on Stripe a withdrawn dispute still
  has to be closed in your favour with evidence. Neither is a statement about where the money ended up.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix: in durable mode, no webhook was ever processed

  `WebhookDispatcher` built an anonymous `class PaymentsWebhookWorkflow extends BaseWorkflow`
  at dispatch time and called its inherited static `dispatch`. That class declares no
  `static workflow = { name }` and is registered on no engine, so `@adonis-agora/durable`
  answered

  ```
  workflow class PaymentsWebhookWorkflow has no registered name — does it declare `static workflow = { name }`?
  ```

  for every event. `dispatchAll` collected the throw as a failed event, the route answered
  `500`, the gateway redelivered forever, and no payment was ever confirmed. This happened in
  every app with `@adonis-agora/durable` installed — which is precisely what the default
  `dispatcher: 'auto'` selects, so the default configuration was the broken one.

  The dispatcher now takes the app's engine (the provider wires it from the container) and
  registers a named workflow — `payments-webhook`, version `1` — before the first
  `engine.start`. The run id stays random per delivery on purpose: `engine.start` is
  idempotent by run id and returns the prior run's state for a repeat, so a run id derived
  from the event would turn the gateway's redelivery of a FAILED event into a silent no-op.
  Deduplication belongs to the ledger, which decides from the row's state.

  1125 unit tests passed over this path because nothing had ever driven it. The dispatcher
  spec now exercises durable against an engine that enforces durable's actual rule — `start`
  an unregistered name and it throws — and the fix was proven by mutation in both directions.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Say how many gateways ship, and put the gaps in the table

  The package advertised four gateways — Stripe, AbacatePay, Asaas and Woovi — while eighteen
  shipped. The count was written on four surfaces nobody edits when a driver lands (two npm
  descriptions, two docs descriptions), and ten drivers had never reached the npm keywords, so
  the package was unfindable by the name of the gateway it already supported.

  `driver_registry.spec.ts` now fails when a description stops matching the number of drivers on
  disk, and when a driver is missing from the keywords.

  The providers comparison table gained the three columns a reader was going to the source for:

  - **Charge** — `server` or `checkout only`. Four gateways (InfinitePay, Lemon Squeezy, Paddle,
    Polar) throw on `charge()` and collect through their own hosted page; that difference outranks
    every other column and was documented nowhere near the table.
  - **Disputes** — true on Stripe alone.
  - **Webhook auth** — false on Efí and InfinitePay, whose gateways sign nothing.

  All three are generated from the drivers and gated by the same spec. A new **When it is a dash**
  section turns each gap into the route through it — the one the driver's own error message names.

- [#3](https://github.com/DavideCarvalho/adonis-agora-payments/pull/3) [`0fb29c9`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/0fb29c923cec08e7d6e14d071b8d0c644aef4bba) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Docs: patterns is now a nested section with per-gateway examples — Pix and subscriptions show Asaas,
  Woovi, AbacatePay and Stripe side by side, and a new page compares the four places business logic can
  live, including a durable workflow that subscribes itself with `@OnDiagnostic`.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Three regressions from this release's own changes

  `config.methods` is written in terms of the KEYS under `config.providers`, and `driver()`
  was handing the routing check the driver's own `provider` string instead. The two are the
  same only by coincidence — `providers: { primary: payments.stripe(…) }` with
  `methods: { credit_card: 'primary' }` made `driver('credit_card').charge(...)` refuse a
  charge that was routed exactly right. Every existing routing test used a key equal to the
  provider name, which is why nothing caught it. The bound-proxy cache is now keyed by
  provider AND method for the same reason.

  `payments:health` grew from four checks to six, and its own description, docblock and
  plain-text output did not follow: it printed the disputes that carry a deadline and never
  the ones that do not — on precisely the installs the new `open_disputes` check was added
  for, since Asaas' published webhook examples never carry a deadline at all. The count fired
  naming nobody. It now names them, the description matches, and `--rejected-window` exposes
  the threshold `billingHealth` already accepted.

  Mollie's CLASSIC webhook reported `'unconfigured'`, the state that refuses to boot. There
  is no credential to configure on that flow and nothing insecure about not having one: the
  request carries only `id=tr_xxx` and the driver authenticates by reading that payment back
  with your API key. It is `'unsupported'` now, so the supported configuration boots — and
  `allowUnverifiedWebhooks` is not needed for it, which matters because reaching for it would
  also have silenced a genuinely missing next-gen secret.

- [#2](https://github.com/DavideCarvalho/adonis-agora-payments/pull/2) [`836ec88`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/836ec881c351ce737b05754ee21cbf788bcb79c3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix webhook retries, which were dead code, and deepen the docs.

  Every retry short-circuited on the idempotency ledger and silently did nothing. The first attempt
  claimed the event; when its handler threw, the row was marked `failed` — and `recordWebhookEvent`
  refused any event it had already seen, so the retry returned `false` before running anything. This
  affected the in-process dispatcher and the durable path alike: a webhook whose handler failed once
  was never processed, and it looked exactly like a webhook that was never delivered.

  An event whose previous attempt **failed** is now claimable again, so the retry re-runs it. A
  genuine redelivery — an event still in flight, or already processed — is refused exactly as before.

  Docs gain a Concepts section (money as an integer, the driver contract and routing, the payment
  lifecycle, idempotency) plus patterns, production, troubleshooting, cli and api-reference pages, and
  document `billing.dispatcher` and `billingOverview`, which shipped undocumented.

- [#6](https://github.com/DavideCarvalho/adonis-agora-payments/pull/6) [`5d2a895`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/5d2a895a41736ea924c1851c71e59a29034b299f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Woovi charges were being created for one hundredth of their amount.**

  OpenPix documents `value` as _"o valor em centavos da cobrança Pix"_ — the same integer minor unit
  this package uses everywhere. The driver ran `toDecimal()` over it on the way out and
  `fromDecimal()` on the way back, so `charge({ amount: 1990 })` sent `value: 19.9` and the gateway
  created a **20 centavo** charge. The same conversion ran on `createCheckout` and
  `createSubscription`, and in reverse when reading a charge or a webhook back — so a R$19,90 payment
  was also _reported_ as 20 centavos, which is why the two halves agreed with each other and the tests
  agreed with both.

  Nothing is converted at this boundary now. The neighbouring Brazilian drivers are genuinely the
  other way round — Asaas and AbacatePay work in decimal reais and still convert — so the driver and
  its page now say which is which rather than leaving it to look like an inconsistency.

  The unit is pinned by tests in both directions, and the old tests that asserted the converted figure
  were wrong in exactly the way the code was.

  **If you are live on Woovi, check your charges.** Anything created through this driver was for 1/100
  of the intended amount; the library cannot repair a charge the gateway already settled.

## 0.2.0

### Minor Changes

- [`c96f1cd`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/c96f1cd6f7465053c37ff65d68932d37b13a762a) - Initial release of the payments library:

  - **Multi-gateway drivers** — Stripe, AbacatePay, Asaas, Woovi (Pix Automático) with a
    provider-agnostic `PaymentsDriver` contract, `supportedMethods` routing and capability
    checks (refunds/invoices/subscriptions).
  - **Method-based routing** — `config.methods` routes `pix`/`credit_card`/`boleto` to a
    provider, with early validation of gateway support.
  - **Invoice (NFe/NFSe) emission** — attached to the charge (`invoice: true` or
    `invoice: 'tecnospeed'`), resolved by provider name independently of the payment
    gateway; Focus provider built in, custom providers via factory.
  - **Cashier-style billing** — Lucid mixins (`withBillable`, `withSubscription`),
    migrations, and an idempotent webhook processor (ledger + shape guards) that syncs
    payments/subscriptions; durable-backed dispatch when `@adonis-agora/durable` is
    installed, in-process retry otherwise.
  - **Custom providers** — exported building blocks (`httpRequest`, `toDecimal`,
    `emitInvoiceIfRequested`) so apps can implement or extend gateways/invoice providers.
  - **Diagnostics** — emits `agora:payments:*` events on `@adonis-agora/diagnostics`
    (structural slot, no dependency), observable by Telescope's generic watcher.
  - **Ace commands** — `make:billable`, `payments:webhook`, `payments:sync`.
  - **Testing kit** — `FakePaymentsDriver`, `InMemoryBillingStore`, `MutableClock` under
    `@adonis-agora/payments/testing`.
