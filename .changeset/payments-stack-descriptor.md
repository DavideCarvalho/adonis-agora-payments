---
'@adonis-agora/payments': patch
---

Gateway, invoice-provider and billing-store factories now describe what they use under `Symbol.for('@adonis-agora/stack')`, so telescope's Architecture page shows "payments: gateway → Stripe" and the billing connection without any app code.
