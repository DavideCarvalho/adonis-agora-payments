---
'@adonis-agora/payments': major
'@adonis-agora/payments-dashboard': major
---

Console list endpoints use the `@adonis-agora/filter` wire format. `GET <path>/api/{payments,subscriptions,disputes,webhook-events,customers,audit}` take `filter[field]=value` (exact, one value), an optional `sort` limited to the list's one order, and `page`/`size`, and answer `{ data, meta: { total, perPage, currentPage, lastPage, firstPage } }` with a real total. Unknown filter fields, unsupported operators and other sorts answer `400`. The payments `reference` lookup is `filter[externalReference]`, the disputes work list is `filter[dueWithin]` with its total in `meta.total`. `BillingStore` count reads take the list filters (`PaymentCountQuery`, `SubscriptionCountQuery`, `DisputeCountQuery`, `WebhookEventCountQuery`) and a new `countCustomers` is required. The bundled console builds its requests with `@adonis-agora/filter-client` and pages with the real total.
