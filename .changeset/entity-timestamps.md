---
"@adonis-agora/payments": minor
---

`createdAt` + `updatedAt` on every mutable billing entity. `PaymentListItem`, `CustomerListItem`, `SubscriptionListItem` and `DisputeListItem` gain an optional `updatedAt: Date | null` (the built-in Lucid and in-memory stores fill it; the in-memory store now stamps it on every write), and the console API's payment, customer, subscription and dispute rows — lists and details — expose `updatedAt` as an ISO string or `null`. `payments:payments:show` and `payments:subscriptions:show` print both timestamps, and the bundled console shows them (Created column on Customers and Subscriptions, Updated on the Disputes log, both on the payment and subscription details). No schema change: the tables already had both columns.
