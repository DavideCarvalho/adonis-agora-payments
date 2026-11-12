---
"@adonis-agora/payments": minor
---

New `GET <path>/api/subscriptions/:id` in the payments console API: one subscription, by its id or its gateway id, with its current state, the customer it bills, the payments charged for it, the webhook events naming those payments and its audit rows. Scoped to the viewer's organizations like every other read (another organization's subscription is `404`). `GET <path>/api/subscriptions` also takes `customerId`. The billing store's `listSubscriptions` takes `id` and `listPayments` takes `subscriptionId` (exact matches; a custom store that ignores them still answers correctly in the console), and with organizations on, a subscription's audit rows are visible to a viewer who can see the subscription.
