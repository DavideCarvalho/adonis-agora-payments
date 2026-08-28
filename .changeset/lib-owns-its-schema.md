---
'@adonis-agora/payments': minor
---

**The library creates its own tables now. There is no migration to run.**

Every other library in this ecosystem owns its schema — `@adonis-agora/durable` exports
`createDurableTables`, `@adonis-agora/authz` exports `createAuthzTables`, both auto-create by
default with an off switch. This package did not, and the cost compounded in one release: each
column added after 0.2.0 became another migration file with hand-written `hasColumn` / `hasTable`
guards, and adopting the library meant publishing and running **three** files before taking a single
payment.

`billing.autoCreateSchema` is on by default. The store calls `createBillingTables` once on first
use; the DDL is idempotent, so an install that already ran the 0.2.0 migration gets no-ops, and the
cost is one round trip on the first query of a process.

**It is an upgrade path, not just a first-install convenience.** `CREATE TABLE IF NOT EXISTS` cannot
carry a new column to a table that already exists, so columns added after their table shipped are
applied as guarded `ALTER TABLE`s — which is precisely what `add_billing_external_reference` was
doing by hand. Upgrading the package is now a deploy, not a deploy plus a migration.

**To own the DDL yourself** — a shared database, a team that reviews every schema change, a deploy
that runs migrations as their own step:

```ts
// config/payments.ts
billing: { autoCreateSchema: false }
```

and run the migration `configure` publishes. It calls the same `createBillingTables`, so the two
paths cannot drift. `createBillingTables`, `dropBillingTables` and `BILLING_TABLES` are exported for
seeders and test bootstraps.

**Three published stubs became one.** `add_billing_external_reference` and `add_billing_disputes` are
gone; their work is in the function. Files already published into your app keep working — they are
your migrations now, and re-running them is harmless.

The gate that makes this safe is a test, not a convention: `lucid_store_schema.spec.ts` enumerates
every public method on `LucidBillingStore` and fails when one of them queries without creating the
schema first. A lazily-created schema that most methods wait for is worse than none — it works in
development, where something writes before anything reads, and fails in production on whichever call
happens to be first.

---

Two ordering bugs in this function were found by the integration suite against a real Postgres, and
both would have shipped: an `ALTER TABLE` running two statements above its own `CREATE TABLE`, and
an index on a column an older install does not have until the ALTER adds it. Either one fails the
whole call, so the schema is half-built on every boot and the only symptom is a query error
somewhere else. The DDL is now three explicit phases — create, then late columns, then indexes —
and a test asserts that order rather than trusting it.

Separately, and found by the same suite: **`billing_payments.amount` was arriving as a string.** The
column is `BIGINT` and node-postgres returns bigints as strings rather than guess past 2^53, so a
row read back held `'1990'` while its declared type said `number`. Adding a fee to it concatenated.
Both `BillingPayment.amount` and `BillingDispute.amount` now coerce on read; `Number()` is safe for
these columns specifically, because 2^53 minor units is ninety trillion reais.
