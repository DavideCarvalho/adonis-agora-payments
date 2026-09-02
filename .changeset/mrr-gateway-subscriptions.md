---
'@adonis-agora/payments': minor
---

MRR counts gateway-owned subscriptions too, not just the library-managed ones.

The previous release scoped recurring revenue to managed subscriptions, arguing that a
gateway-owned one keeps its price at the gateway. True about the SOURCE and wrong about the
DATA: the drivers already normalised `amount`, and the cycle was sitting in every gateway's
payload — Asaas as `cycle`, Stripe as `price.recurring`. Nobody propagated it. Summing half a
book and calling it MRR was the bigger error.

- `Subscription` gains `cycle`, mapped by the Asaas and Stripe drivers.
- `SubscriptionWebhookData` gains `amount`, `currency` and `cycle`, so a
  `subscription.created`/`updated` delivery carries the price to the store.
- `saveSubscription` persists them. **Absent does not erase**: a `subscription.canceled`
  carries no price, and overwriting with null would drop what `created` recorded — MRR falling
  because of an event that never mentioned money.

Stripe's cycle reads `interval` **and** `interval_count`: "every 3 months" is `month` × 3, and
reading only `interval` would count it as MONTHLY and inflate MRR threefold, silently. A
combination with no name here (every 5 months) yields `undefined` and is skipped by the
calculation rather than guessed.

A subscription with no price or no known cycle is still ignored rather than assumed monthly, so
the figure stays incomplete-but-honest instead of wrong-upwards.
