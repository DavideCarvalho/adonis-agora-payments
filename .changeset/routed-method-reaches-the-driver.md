---
'@adonis-agora/payments': minor
---

`payments.driver('pix')` picked the provider and then told it nothing.

Routing resolved a gateway by payment method and handed back the plain driver, so the method itself
only reached the charge when the caller repeated it — `driver('pix').charge({ method: 'pix' })`.
Every driver that varies by method reads it off the charge: Stripe's `payment_method_types`, Asaas'
and AbacatePay's `billingType`. Without it the charge was created with whatever the gateway's
dashboard defaults are. It read as working, and a charge routed as Pix could come back a card.

`driver(method)` now returns the driver **bound to that method**, filling it in on `charge` and
`createSubscription` — the two inputs that carry one:

```ts
getPayments().driver('pix').charge({ amount: 1990 })
// reaches the driver as { amount: 1990, method: 'pix' }
```

An explicit method on the input still wins: routing is a default, not an override. A driver resolved
by **name** comes back untouched, because `driver('stripe')` routed nothing and has nothing to
thread. Repeated calls return the same object, so a caller can hold on to one.

**One behavior change worth knowing about:** `driver('pix')` no longer returns the identical object
you put in the config map — it returns a method-bound view of it. `provider`, `supportedMethods`,
`capabilities` and every method behave exactly as before, and absent optional members stay absent
(the binding is a Proxy for that reason: a wrapper defining every method would turn "this gateway
cannot do that" into "it can, until you call it"). Only reference equality against the raw driver
instance changes, and only on the method-routed path.
