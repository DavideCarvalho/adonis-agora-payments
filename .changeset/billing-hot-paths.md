---
'@adonis-agora/payments': minor
'@adonis-agora/payments-dashboard': patch
---

Faster, race-free webhook ledger and indexed console reads.

- **Concurrent duplicate deliveries no longer answer `500`.** The ledger claim is now the `INSERT` on the unique `gateway_event_id`: when a gateway redelivers while the first attempt is still running, exactly one delivery runs and the others answer as redeliveries instead of failing on the constraint (which made the gateway retry yet again). Re-claiming a `failed` event is a conditional `UPDATE`, so two concurrent retries cannot both re-run it. A new `payment.succeeded` delivery takes 4 database round trips instead of 6.
- **Payment timeline is an indexed lookup.** `billing_webhook_events` gains `payment_gateway_id` (added automatically, or by re-running the published migration), filled from the normalized event's `gatewayId` on `payment.*` events. `listWebhookEventsForPayment` matches on it; rows recorded before the column existed are still found by the payload substring scan. The dashboard reports `events.matchedBy: 'payment-gateway-id'`. A delivery that is about another payment but whose payload merely mentions this one is no longer listed.
- **Indexes.** Usage indexes now end in `recorded_at` (and `(recorded_at, meter)` serves the overview), so `usage().remaining()` reads only the window instead of every row the owner ever recorded; the three superseded usage indexes are dropped. New indexes on `status`/`created_at` (payments, webhook events, subscriptions), `created_at`, and `(status, paid_at)` for revenue.
- **Dashboard correctness.** `?provider=` is applied by the store on the payments, subscriptions and webhook-event pages, so rows older than the 1000 newest are no longer missing (`meta.truncated` is always `false`). A payment's disputes are read with the new `listDisputes({ paymentGatewayId })` filter instead of being picked out of the newest 50 disputes.
- **Fewer gateway calls on redelivery.** Mercado Pago and Mollie (next-gen) drivers implement the new optional `webhookEventIds()`: with a webhook secret configured, a redelivery of an event the ledger already holds is answered without fetching the resource again.
- Woovi's RSA public key is parsed once per key instead of on every webhook.
- **SQLite: ids stay uuids.** The default models now set `selfAssignPrimaryKey`, so Lucid keeps the uuid their `beforeCreate` hook generates instead of replacing it with the rowid SQLite's INSERT reports. On SQLite every later `where id = ?` used to miss, so a webhook was never marked `processed` or `failed`. Postgres and MySQL already kept the uuid and are unchanged.
