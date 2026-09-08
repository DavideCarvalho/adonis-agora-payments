---
'@adonis-agora/payments': minor
'@adonis-agora/payments-dashboard': minor
---

Pagination is now `{ page, size }` everywhere, matching `@adonis-agora/filter`.

**Breaking rename.** Every list read took `{ limit?, offset? }` with a **0-based** `offset`; it now
takes `{ page?, size? }` with a **1-based** `page` (default `1`) and `size` as the page size
(default 50, capped at 200 — the same numbers as before). The 0-based SQL offset became an internal
detail computed by the store, so it can no longer leak into a public type or a query string.

The reason is ecosystem consistency, not taste: `@adonis-agora/filter` exposes `FilterInput.page`
/`.size` and resolves them to `{ page, size }`, and every `@adonis-agora/*` library is being moved
onto that one shape so an app (or a console) never has to remember which library counts from zero.
The match is **structural** — this package still depends on no filter package.

```ts
// before
await store.listPayments({ status: 'failed', limit: 20, offset: 40 })
// after — page 3 of 20, 1-based
await store.listPayments({ status: 'failed', size: 20, page: 3 })
```

What changed, concretely:

- `BillingListQuery`, `PaymentListQuery`, `WebhookEventListQuery`, `CustomerListQuery`,
  `AuditEventQuery`, `DisputeDeadlineQuery`, `OpenDisputeQuery` and
  `listWebhookEventsForPayment`'s options: `limit`/`offset` → `size`/`page`.
- `AuditEventCountQuery` is now `Omit<AuditEventQuery, 'page' | 'size'>`, and
  `countDisputesDueWithin` takes `Omit<DisputeDeadlineQuery, 'page' | 'size'>`.
- `BILLING_LIST_DEFAULT_LIMIT` → `BILLING_LIST_DEFAULT_SIZE` (still 50);
  `BILLING_LIST_MAX_LIMIT` → `BILLING_LIST_MAX_SIZE` (still 200).
- `clampLimit`/`clampOffset` → `clampSize`/`clampPage`, plus `listOffset(page, size)` for stores
  that need the SQL offset.
- Dashboard JSON API: lists read `?page=1&size=25` instead of `?limit=25&offset=0`, and echo the
  paging back under `pagination: { page, size, count, … }` instead of `page: { limit, offset, … }`.
  `count === size` is still the only "there might be more" signal.
- Dashboard SPA: `paymentsClient` list options take `{ page, size }`, the `Page` wire type is now
  `Pagination`, and the `Pager` control is page-based (`page`/`size`/`onPage`).
