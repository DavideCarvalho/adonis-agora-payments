---
"@adonis-agora/payments": minor
---

Meter usage against an application resource, read it back against a quota, and type free-plan subscriptions honestly.

- `billing_usage_events` gains `scope_type` / `scope_id` and an index on `(scope_type, scope_id, meter)`. `recordUsage` and `usageReport` take `scope: { type, id }` — a project, a workspace, a site — alongside `subscriptionId` / `customerId`, so per-resource usage no longer has to live in `metadata`. Added through the existing `createBillingTables()` upgrade path: an existing install picks the columns up on the next boot (or the next run of the published migration), no new migration to publish. Existing rows read as unscoped.
- `payments.usage()` — `record`, `total`, `remaining` and `period` — plus the standalone `usageTotal`, `usageRemaining` and `usagePeriodFor`. `period: { subscription }` derives the window from the subscription's billing cycle: the stored current period when it is current, otherwise stepped by `cycle` from its anchor, so a free row nothing renews still resets every cycle.
- `advancePeriodBy(from, cycle, count)` — anchored multi-cycle arithmetic, without the drift chained clamps accumulate.
- **Source-breaking:** `SubscriptionRow.gatewayId` (the `withSubscription()` mixin) widens to `string | null`, matching `BillingSubscription` and the column, which was always nullable. Free plans, local trials and comped subscriptions have no gateway subscription to point at. Code assigning `row.gatewayId` into a `string` needs a null check.
- `LucidBillingStore.usageReport` now applies `customerId` together with `subscriptionId` instead of dropping it, matching `InMemoryBillingStore`.
