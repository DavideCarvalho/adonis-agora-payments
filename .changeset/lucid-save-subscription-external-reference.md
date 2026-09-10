---
'@adonis-agora/payments': patch
---

**Bug:** `LucidBillingStore.saveSubscription` accepted `externalReference` and never wrote it.

Shipped in 0.13.0. The field was added to the `BillingStore` contract, to `SubscriptionListItem`, to the `listSubscriptions` filter and to `InMemoryBillingStore` — and not to the Lucid store's `saveSubscription`. So on Postgres every subscription persisted with a null `external_reference` and became **unfindable by the app that created it**, through the very query added to find it. `listSubscriptions({ externalReference })` returned nothing, always.

Anything deriving subscription state from the store instead of mirroring it in an app column — the pattern 0.13.0 exists to enable — was silently broken.

Nothing caught it because nothing round-tripped a real save: the store's tests mock the model, and `InMemoryBillingStore` had the field, so the in-memory half of every test passed. `test/lucid_save_subscription_fields.spec.ts` now asserts what got assigned to the row, including the absent-preserves / explicit-null-clears rule that `subscription.canceled` depends on.
