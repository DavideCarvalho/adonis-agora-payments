---
'@adonis-agora/payments': minor
---

The billing store is now bound in the IoC container under `'payments.billingStore'`.

`BillingStore` is an interface, so a custom store had no class to hand `@inject()` — the only way to reach one was the module-level accessor on `services/main`, fed by the provider through a `setBillingStore()` push. That is not how an AdonisJS package resolves a dependency, and it cost the two things DI is for: `@inject()` on the token, and `container.swap()` in tests instead of a package-specific setter.

AdonisJS solves the same problem the same way — `'lucid.db'` is a string alias for the `Database` singleton — so the token follows that precedent.

```ts
import { inject } from '@adonisjs/core'

@inject()
export class Cobranca {
  constructor(private store: BillingStore) {}
}

// in a test
app.container.swap('payments.billingStore', () => new InMemoryBillingStore())
```

The `LucidBillingStore` class binding and the `services/main` accessors are unchanged, so nothing that works today stops working.
