---
'@adonis-agora/payments': minor
---

Add a **Paddle** driver — Paddle Billing (the v2 API on `api.paddle.com`), not the deprecated
Paddle Classic vendors API. `payments.paddle({ apiKey, currency, sandbox, productId, webhookSecret })`,
REST over `fetch`, no new peer dependency.

Paddle is a merchant of record: it is the seller on your customer's statement, it remits sales tax
and VAT worldwide, and it pays you out. That is why this driver refuses more than it implements, and
the refusals are the point.

**`charge()` throws.** Paddle has no endpoint that takes money — every payment is collected by
Paddle Checkout or a Paddle-issued invoice. The closest thing, `POST /transactions`, creates an
*unpaid* record whose only route to payment is the checkout URL it returns, which is exactly what
`createCheckout()` does. Returning a `Payment` from `charge()` would advertise a capture that never
happened, so `createCheckout()` is the entry point and `charge()` says so.

**`createSubscription()` throws.** Paddle's API has no create-subscription endpoint at all: Paddle
creates one when a customer completes a checkout for a recurring price. Call
`createCheckout({ planId })` and read the id off the `subscription.created` webhook.

**`updateSubscription()` refuses `amount` and `description`.** Paddle has no editable amount on a
subscription — you swap `items[].price_id` with a `proration_billing_mode`, which the shared input
cannot express — and no description field. Only `metadata` is written, onto `custom_data`. Likewise
`trialDays` on a checkout throws (a Paddle trial lives on the price), a `taxId` on a customer throws
(Paddle keeps tax ids on a *business*), and a partial refund throws when the transaction has more
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
