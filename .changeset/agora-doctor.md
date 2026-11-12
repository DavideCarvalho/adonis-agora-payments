---
"@adonis-agora/payments": minor
---

`node ace agora:doctor` (and `payments:doctor`). The commands barrel now ships the shared Agora health check, and the payments provider registers its checks into the `'agora.doctor'` registry: `payments.webhook-secret`, `payments.webhook-csrf`, `payments.console-gate`, and with `--deep` `payments.tables` and `payments.health` (the `payments:health` report). The new `@adonis-agora/payments/doctor` entry serves `--no-boot`.
