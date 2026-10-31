---
'@adonis-agora/payments': minor
---

Managed subscriptions now renew by card, and renew at all on Asaas and Woovi.

- **The card token is kept.** `createManagedSubscription` stores `card.token` in the new `billing_subscriptions.payment_method_id` column (never serialized) and every renewal charges it as `paymentMethodId`. Before, a renewal went out with no token. Run the billing schema migration again to add the column.
- **Fix: a renewal returned the first cycle's charge on Asaas.** The driver looked for duplicates by `externalReference`, which every cycle shares, so nothing new was charged. Woovi's `correlationID` had the same collision. When a charge has both `externalReference` and `idempotencyKey`, the gateway field now carries `<reference>|k:<hash>`; webhooks hand back the plain reference, so routing does not change. Code reading the raw field at the gateway sees the suffix.
- **Fix: the Lucid store dropped `lastRenewalError`, `lastRenewalAttemptAt` and `renewalFailureCount`** on update.
- **Failed renewals back off.** They wait 1h, 6h, 24h, then 72h instead of retrying every tick; override with `renewDue({ retryDelaysHours })`. A charge the gateway answers as `failed` now counts as a failure instead of advancing the period. `failed` outcomes carry `failureCount` and `externalReference`.
- **New `subscriptions().updatePaymentMethod(id, token)`** replaces the saved card. A subscription in a failure streak becomes due at once; a healthy one keeps its date.
