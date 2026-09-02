---
'@adonis-agora/payments': minor
---

`payments.subscriptions().resume(id)` — undo a cancel-at-period-end.

The counterpart of `cancel({ atPeriodEnd: true })`, and the reason that flag is a flag rather
than a terminal state: an application offering "you can change your mind until the period
ends" needs a way to act on it. Without this the only route back was creating a second
subscription, which charges again for a period already paid.

Managed mode only. A gateway-owned subscription cancelled at the gateway is gone, and there is
no portable un-cancel across gateways to hide behind the name — it refuses and says so rather
than working on one provider and silently doing nothing on the next.

Refuses a subscription that is no longer active: `cancelAtPeriodEnd` is a decision that can be
reversed, but a `canceled` one has stopped, and quietly restarting it would put a customer back
on a recurring debit they finished.
