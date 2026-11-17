---
"@adonis-agora/payments": minor
"@adonis-agora/payments-dashboard": minor
---

The console's lists page by cursor, so a deep page costs what the first one does and no page counts the whole table.

- `GET <api>/payments`, `/subscriptions`, `/customers`, `/webhook-events`, `/audit` and `/disputes` (the log) accept `first`/`after` and answer `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`. They seek past `(created_at, id)` with no `COUNT(*)`. `page`/`size` keep the offset envelope and its `meta.total`. Subscriptions sends its two status counts (`past_due`, failing renewals) on the first page only. The Disputes work list (`dueWithin`) keeps `page`/`size`.
- `BillingStore` list queries take an optional `keyset: { after }`: newest first by `(createdAt, id)`, `size + 1` rows. Both built-in stores implement it. The offset order now breaks ties on `created_at` by `id` too, so rows written in the same instant no longer repeat or go missing across pages.
- The console pages with Previous/Next and keeps the walked cursors in the URL (`#/payments?after=…`), so back/forward and shared links still work. The lists no longer show a row total.
- New migration `add_billing_list_indexes` (published by `configure`), plus `createBillingListIndexes` / `dropBillingListIndexes`. It adds `(created_at, id)` on audit events, customers, disputes and subscriptions, and `(status, created_at)` on disputes, built `CONCURRENTLY` on Postgres. Opt-in: run it once on existing installs (see Production → Indexes).
- Fix: `node ace configure @adonis-agora/payments`, `make:billable` and `make:webhook-handler` failed to render their stubs: unescaped backticks in the comments broke the stub template. A spec now renders every stub through the real engine.
