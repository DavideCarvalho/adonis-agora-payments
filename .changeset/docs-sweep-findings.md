---
'@adonis-agora/payments': minor
---

A documentation sweep across every page, and the six code bugs it turned up. The docs were read
against the source rather than against themselves, which is the only way this kind of thing surfaces.

**AbacatePay created checkouts and subscriptions for 1/100 of their amount.** AbacatePay documents it
outright — "valores monetários são sempre em centavos" — and `charge()` passed the integer straight
through, while `createCheckout` and `createSubscription` ran `toDecimal`. The driver disagreed with
itself on two paths nobody had compared: R$19,90 went out as `19.9` and became a 19-centavo
checkout. Same bug as Woovi's, found the same way.

**`withBillable` was not exported from the package root**, so every model `node ace make:billable`
has ever scaffolded failed to compile — the stub imports it from `@adonis-agora/payments` and the
root exported only the model classes. `withSubscription` and `withPayment` were unreachable too. A
new test reads every published stub and fails when it imports a symbol the package does not export.

**A failing invoice provider rejected `charge()` after the gateway had taken the money.** The caller
saw a failed call over a real charge, and the obvious response to a failed charge is to charge again.
The charge and the invoice are two different facts; `charge()` now returns the true one and publishes
**`invoice.failed`** with the payment's gateway id. Subscribe to it: in Brazil an NFS-e is a legal
obligation and nothing else will tell you.

**`billing.dispatcher: 'queue'` never existed.** It was in the config type, the docs and the
dispatcher's own comments; `queueDispatch` was declared and never read, so the mode fell through and
silently ran durable-or-in-process. Splitting `billing.role` across api/worker was *permitted* on it,
which produced an api process doing all the work and a worker sitting idle. It is refused at boot
with a named error, and `'durable'` is now the only mode a deployment can be split on.

**`autoCreateSchema: false` did not reach a store the app built itself.** `billing.store: () =>
lucidBillingStore({ paymentModel: MyPayment })` constructs the store before the provider reads the
config, so the flag was skipped and DDL ran against exactly the shared database it was set to
protect.

**`payment.failed` never published its `reason`.** The field was on the payload type from the
beginning, so a subscriber could not see it even on the gateways that normalize one — and "why" is
the only question anyone asks of a failed payment.

Smaller: the routing error listed five payment methods when there are eleven (the union is derived
from a list now, so the message cannot go stale again); the dashboard's `422` told operators to run a
migration that no longer exists; and a dozen doc comments still named the collapsed migration files.
