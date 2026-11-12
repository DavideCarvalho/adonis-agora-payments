---
'@adonis-agora/payments': minor
---

`billing.connection` and `billing.schema` put the billing tables on their own Lucid connection and in their own Postgres schema (MySQL: database), e.g. `"billing"."billing_payments"` while the app stays in `public`. Every statement names the schema: the DDL, the column checks, the store's reads and writes (so the dashboard, account console and dev MCP reads too), the published migration and `agora:doctor`. Nothing relies on `search_path`, so this is safe behind PgBouncer in transaction mode. The schema is created on first use (or by the migration), the name is validated at boot, and SQLite with a `schema` fails the boot. `billingStores.lucid(...)` inherits both options; `createBillingTables`/`dropBillingTables`/`truncateBillingTables` take `{ schema }`. Without either option, behaviour is unchanged.
