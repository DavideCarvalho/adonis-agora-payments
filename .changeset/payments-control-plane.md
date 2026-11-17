---
'@adonis-agora/payments': minor
---

`topology: 'control-plane' | 'tenant'`: one app (the Agora Hub) holds the gateway credentials, the webhooks, the billing store and the console; tenant apps keep calling `getPayments().driver(...)`, `subscriptions()` and `ensureCustomer()`, and each call runs on the control plane over HTTP (`POST /_payments/rpc`) or the Redis bus. Processed webhooks are forwarded to the app that owns the payment/subscription and run through that app's own handlers. One gateway customer per account (`CreateCustomerInput.account`, `getPayments().hub().customer()`), per-app ownership enforced on every call, replay-safe call ids, `verifyTenant` on every message. `standalone` stays the default: nothing changes for an app that does not set `topology`. The managed renewal pass now stops (without counting a failure) when the control plane is unreachable.
