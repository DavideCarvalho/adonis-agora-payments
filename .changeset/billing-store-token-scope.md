---
'@adonis-agora/payments': patch
---

Corrects what the `'payments.billingStore'` binding actually gives you.

The 0.15.0 note showed `container.swap('payments.billingStore', ...)` as the testing seam. That is wrong twice, and both matter to anyone who tried it:

1. `container.swap()` is typed for **class** tokens only. A string binding is replaced by re-registering it.
2. Re-registering it does **not** reach `PaymentsManager`. The manager takes its store as a thunk built at boot (`() => getBillingStore()`), reading the module-level accessor — so `payments.arrears()` and every other manager read keep using the store the provider resolved.

The token is for code that receives a store by injection. For the manager path, the seam is still `setBillingStore()` from `services/main`. Documented on the binding itself so the next reader does not have to find this out from a failing test.
