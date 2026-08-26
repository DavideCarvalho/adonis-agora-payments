---
'@adonis-agora/payments': minor
---

Initial release of the payments library:

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
