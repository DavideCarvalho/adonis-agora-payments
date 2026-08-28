---
'@adonis-agora/payments': minor
---

Store the two things the library's own story depended on and never kept: the app's
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
