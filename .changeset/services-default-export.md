---
'@adonis-agora/payments': minor
---

`import payments from '@adonis-agora/payments/services/payments'` — the service shape every first-party AdonisJS package uses.

```ts
// before
import { getPayments } from '@adonis-agora/payments/services/main'
const status = await getPayments().arrears({ externalReference: clinic.id })

// now
import payments from '@adonis-agora/payments/services/payments'
const status = await payments.arrears({ externalReference: clinic.id })
```

Compare with the first-party packages, which are identical to each other and different from what this one did:

```ts
import db from '@adonisjs/lucid/services/db'
import drive from '@adonisjs/drive/services/main'
import mail from '@adonisjs/mail/services/main'
```

Each exports a resolved **instance**, obtained from the **container** inside `app.booted()`. This package exported a getter fed by a `setPayments()` push from the provider — so you called a function to fetch the thing instead of importing the thing, and the container binding was decorative: nothing resolved through it, so nothing could be substituted through it either.

`'payments.manager'` is now an alias for the `PaymentsManager` singleton (`'lucid.db'` is the same idea), and `services/payments` resolves it. `services/billing_store` does the same for `'payments.billingStore'`.

`services/main` keeps its named accessors unchanged — this package's own providers and testing helpers import them, and those must work *before* the app is booted, which a top-level `await app.booted()` cannot do. That is also why the new modules are separate files rather than a new export on the old one.
