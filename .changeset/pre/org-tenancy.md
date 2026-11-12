---
"@adonis-agora/payments": minor
"@adonis-agora/payments-dashboard": minor
---

Organizations as tenants. With tenancy on in `@adonis-agora/context` (payments' new `tenancy` option defaults to `'inherit'`; nothing changes while it is off): `ensureCustomer` with a store and no `owner` records the active organization as the owner; `payments.currentOwner()` / `payments.currentCustomer()` answer the active organization's customer, else the signed-in user's (`userOwnerType`, default `'User'`); metered usage with no `customerId` is the current customer's; `payments.scopedStore()` confines reads to the current organization; app webhook handlers run inside the organization that owns the customer. The console's `authorize` may answer `tenants: '*' | string[]`; reads are confined to the viewer's organizations, `?tenant=` picks one (a pick outside the grant reads as empty and is audited), and the SPA gains an Organization picker. Store reads accept `owners` (custom stores opt in with `ownerScoping: true`). `payments:sync` gains `--tenant`, `--backfill-owner`, `--owner-id` and `--owner-key`.
