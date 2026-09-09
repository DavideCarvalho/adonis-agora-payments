---
'@adonis-agora/payments': minor
---

**Breaking, and only one day old:** `arrears()` no longer takes the store as its first argument.

```ts
// before (0.13.x)
const status = await arrears(store, { externalReference: clinic.id })

// now — the store comes from config, like every other service in an Adonis app
const status = await getPayments().arrears({ externalReference: clinic.id })
```

The old shape followed this package's own convention for derived reads (`billingHealth(store, ...)`, `billingOverview(store, ...)`), but that convention is not how an Adonis application is written: you resolve a service, you do not thread a dependency through every call site. Handing the store to the caller also meant every app repeated the same `findBillingStore()` dance before it could ask a question the library already knows how to answer.

`arrears({ store, externalReference })` still exists for tests and for callers holding a store directly — the store is a named field now, not a positional first parameter.
