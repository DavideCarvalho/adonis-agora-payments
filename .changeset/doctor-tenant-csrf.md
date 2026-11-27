---
"@adonis-agora/payments": patch
---

`agora:doctor` no longer reports "Webhook route passes CSRF" as an error on a payments tenant: a tenant mounts no `/payments/webhook/:provider` route (gateways deliver to the control plane), so `payments.webhook-csrf` now skips there.
