---
'@adonis-agora/payments': minor
---

Subscriptions: say what the gateway can actually do, and offer to own the recurrence instead.

**`capabilities.subscriptionLifecycle`.** `subscriptions: boolean` could only ask "recurring
billing, yes or no", which is not the shape of reality. Woovi/OpenPix creates subscriptions and
cannot cancel or update one — its API is `create` and `get`. Declaring `subscriptions: true` was
true about the only question it could answer and misleading about the two that decide whether an
app can offer a cancel button, so every caller rediscovered the limitation the same way: by
calling cancel and reading the exception. Drivers may now declare
`subscriptionLifecycle: { create, update, cancel }`; omitting it keeps following `subscriptions`,
so existing drivers are unchanged. `PaymentsManager.assertGatewaySubscriptionOperation()` refuses
early and names the way out.

**`subscriptions.mode: 'gateway' | 'managed'`.** Who owns the recurrence is now a choice, at
three levels — globally, per provider, and `managed` on a single call, narrowest winning, default
`'gateway'` so nothing changes until asked. Plenty of teams want the gateway to own everything
and administer it in the gateway's dashboard; others want the plan, the price and the cancel
button in their own application. Forcing either on the other is what makes a billing library get
ripped out — and on a gateway that cannot cancel, `'managed'` is the only way to have a cancel
button at all, while the same app's card subscriptions stay gateway-owned.

In managed mode the library never asks for a gateway subscription, only for a charge — which
every gateway can do. Cancelling becomes "stop issuing charges" and re-pricing becomes "the next
one is a different number", both local writes. Each cycle's charge carries the app's own
`externalReference`, so a renewal routes through the ordinary webhook path with no per-gateway
lookup.

- `payments.subscriptions()` — `create`, `cancel`, `update`, `due`, `renewDue`, branching on mode
  internally so no call site has to.
- `node ace payments:renew [--limit] [--dry-run]` charges what is due. **Nothing renews on its
  own** — point a cron or durable schedule at it. Each cycle is keyed idempotently by
  subscription and period start, so an overlapping run asks for the same charge rather than a
  second one. A failed charge does not advance the period and does not stop the pass; dunning
  stays the application's policy.
- `billing_subscriptions` gains `managed`, `amount`, `currency`, `cycle`, `method`, `description`,
  `external_reference`, `current_period_start`, `current_period_end`, `next_charge_at`,
  `cancel_at_period_end`, plus an index for the renewal query. Added through the existing
  `createBillingTables()` upgrade path — no new migration to publish.
- `BillingSubscription.gatewayId` and `SubscriptionListItem.gatewayId` widen to `string | null`.
  The column was always nullable; only the type disagreed, which blocked the managed case and the
  free-plan/courtesy case alike.

`BillingSubscription.amount` consumes through `Number()`, like `billing_payments.amount`:
`BIGINT` comes back from node-postgres as a string, and without it the renewal runner handed
`'9900'` to `driver.charge({ amount })` — a string in the request that moves money.

Month arithmetic clamps rather than rolls over: a subscription starting 31 January renews 28
February, not 3 March.
