---
'@adonis-agora/payments': patch
---

Fix: in durable mode, no webhook was ever processed

`WebhookDispatcher` built an anonymous `class PaymentsWebhookWorkflow extends BaseWorkflow`
at dispatch time and called its inherited static `dispatch`. That class declares no
`static workflow = { name }` and is registered on no engine, so `@adonis-agora/durable`
answered

```
workflow class PaymentsWebhookWorkflow has no registered name — does it declare `static workflow = { name }`?
```

for every event. `dispatchAll` collected the throw as a failed event, the route answered
`500`, the gateway redelivered forever, and no payment was ever confirmed. This happened in
every app with `@adonis-agora/durable` installed — which is precisely what the default
`dispatcher: 'auto'` selects, so the default configuration was the broken one.

The dispatcher now takes the app's engine (the provider wires it from the container) and
registers a named workflow — `payments-webhook`, version `1` — before the first
`engine.start`. The run id stays random per delivery on purpose: `engine.start` is
idempotent by run id and returns the prior run's state for a repeat, so a run id derived
from the event would turn the gateway's redelivery of a FAILED event into a silent no-op.
Deduplication belongs to the ledger, which decides from the row's state.

1125 unit tests passed over this path because nothing had ever driven it. The dispatcher
spec now exercises durable against an engine that enforces durable's actual rule — `start`
an unregistered name and it throws — and the fix was proven by mutation in both directions.
