---
'@adonis-agora/payments': minor
---

The billing store answers the operational questions, and two bugs that only a real database could
show are fixed.

**Every insert failed on Postgres.** The published migration declares `uuid('id')` with no
database-side default and the four billing models never assigned one, so `billing_payments`,
`billing_subscriptions`, `billing_webhook_events` and `billing_usage_events` all rejected every
insert with `null value in column "id" violates not-null constraint` — the idempotency ledger
included, which is the first write of every webhook. Fixed with a `@beforeCreate()` hook that
generates the uuid on the model: it works on every dialect (unlike `gen_random_uuid()`) and needs no
new migration.

**Every aggregate returned zero.** A Lucid model query hydrates rows into model instances, and a
value with no matching column — `count(*) as total` — goes into `$extras`, not onto the instance. So
`rows[0].total` was `undefined`, `Number(undefined ?? 0)` returned a confident `0`, and `revenue()`
and `countActiveSubscriptions()` reported zero against any real database. Every aggregate query now
goes through `.pojo()`.

Both were invisible to the existing suite, which only ever exercised the in-memory store. There is
now an integration suite (`pnpm test:integration`) that runs against a throwaway Postgres via
testcontainers, on the **real published migration stub** rather than a copy of the schema.

New reads on `BillingStore`, so nothing has to reach around it into the tables:
`findWebhookEventByGatewayEventId(id)`, `countPayments(query)`, `countWebhookEvents(query)` and
`webhookEventBreakdown(query)`, filtered by `status` and a `createdBefore`/`createdAfter` window.

New `billingHealth(store)` and `node ace payments:health` report the three silent failures of a
billing install — events claimed and never finished, events the dispatcher gave up on, and charges
created that never confirmed. The command exits non-zero when any is non-zero, so a scheduler can
page on it.

`payments:sync` now uses the **configured** store rather than always constructing a Lucid one (an app
with a custom `billing.store` had its reconcile write somewhere the rest of the billing layer never
reads), no longer reports an unreadable `billing_customers` as "empty", and no longer imports the
database service at module scope.
