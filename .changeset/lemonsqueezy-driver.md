---
'@adonis-agora/payments': minor
---

Add a **Lemon Squeezy** driver — the v1 REST API on `api.lemonsqueezy.com`.
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
