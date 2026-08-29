---
'@adonis-agora/payments': minor
---

Add the Polar driver (`payments.polar()`) — merchant-of-record billing for software, over
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
