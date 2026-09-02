---
'@adonis-agora/payments': patch
---

`FakePaymentsDriver` declares the capabilities it implements.

It declared none, which was invisible until the manager started checking: the capability
guards read `capabilities?.x === true`, so an absent block means "cannot". The moment
`subscriptions().cancel()` began asserting the gateway can cancel, every consumer's test that
cancelled through the fake failed on a limitation the fake does not have — it records the call
and returns a subscription, exactly as before. A test double that refuses what it implements
fails tests about the application for a reason that lives in the double.

Everything is on by default except `cardTokenization`, which stays off so the "gateway that
tokenizes in the browser" path is still the default shape. A test ABOUT a gateway limitation
now spells it out — `new FakePaymentsDriver({ capabilities: { disputes: false } })` — instead
of relying on absence, and the override is merged over the defaults so it says only what it
means.
