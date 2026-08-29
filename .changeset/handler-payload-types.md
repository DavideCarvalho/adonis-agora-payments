---
'@adonis-agora/payments': minor
---

Export the webhook payload types an app handler actually needs

`WebhookEvent` was exported; the shapes drivers normalize `event.data` onto were not. Every
app writing a handler had to re-declare them as an inline cast — a type that agrees with
nothing and drifts silently when a field is added. `PaymentWebhookData`,
`SubscriptionWebhookData` and `DisputeWebhookData` are now exported from the package root,
along with the `isPaymentWebhookData` / `isDisputeWebhookData` / `isSubscriptionWebhookData`
guards.

`DisputeWebhookData` also gained `externalReference`. Gateways that build a dispute event
out of the payment resource carry it — Asaas nests `chargeback` on the payment and spreads
the payment's fields — and an app routing a chargeback back to its own order needs it as
much as a `payment.succeeded` handler does. It was on the wire and hidden by the type.

The `make:webhook-handler` stub now uses those types (and is in English; it was writing
Portuguese comments into other people's apps).

The gate that checks published stubs against the package's exports could not see any of
this: it matched `import {` and not `import type {`, so a stub importing a type that does
not exist passed. Fixed, and proven by mutation in both directions.
