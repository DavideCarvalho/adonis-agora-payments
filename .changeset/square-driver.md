---
'@adonis-agora/payments': minor
---

**New driver: Square** (Connect v2) — `payments.square()`.

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
