---
'@adonis-agora/payments': minor
---

Woovi: actually create a Pix Automático subscription, and let `externalReference` reach it.

`WooviDriver` documents itself as Pix Automático and translates the `PIX_AUTOMATIC_*`
webhooks, but the body it sent had neither `type: 'PIX_RECURRING'` nor `pixRecurringOptions`.
`POST /api/v1/subscriptions` serves two products, and without those fields it creates the
ordinary one — the kind that mails a payment link every cycle instead of debiting the payer's
bank. Those webhooks only fire for `PIX_RECURRING`, so every event the driver knew how to
handle was an event the gateway had no reason to send. Nothing failed loudly: the subscription
existed, the dashboard showed it, and the recurring debit simply never happened.

`correlationID` was the other half. The API accepts it and echoes it at the root of every
`PIX_AUTOMATIC_COBR_*` delivery, but the SDK's `CreatePayload` type does not declare the field,
so the driver dropped it. Woovi then assigned its own, and an application routing webhooks by
its own reference could not recognise its own renewals — they arrived looking like a payment
for an unknown order.

`createSubscription` now sends `type`, `pixRecurringOptions`, `correlationID`, `name`,
`comment` (the adoption-contract text, truncated to the gateway's 30-character cap),
`frequency` in the spelling `PIX_RECURRING` uses — it differs from the ordinary product's
`TRIMONTHLY`/`SEMIANUALY`/`ANNUALY` — plus `dayDue` and the payer's address.

- `CreateSubscriptionInput.customer` gains optional `phone` and `address`. Woovi **requires**
  the address for `PIX_RECURRING`: a recurring mandate carries it, and the subscription is
  refused without one. It is never defaulted or faked — an address the payer never gave is
  wrong data on a bank mandate.
- Journey and retry default to `PAYMENT_ON_APPROVAL` and `NON_PERMITED` (no silent re-debits);
  override via `metadata.journey`, `metadata.retryPolicy`, `metadata.minimumValue`,
  `metadata.dayDue`.
- `metadata.pixAutomatic: false` keeps the previous link-per-cycle behaviour.

Note for existing callers: a Woovi subscription created before this now becomes a real
recurring authorization, and the payer's address becomes required.
