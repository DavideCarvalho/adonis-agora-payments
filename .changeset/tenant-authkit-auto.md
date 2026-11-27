---
'@adonis-agora/payments': minor
---

`topology: 'tenant'` needs only `tenant: { providers }` when `@adonis-agora/authkit-client` is booted with its `service` configured: its `authkit.client.tenantOf('urn:agora:payments')` supplies `tenant.url`, `tenant.token` and `tenant.partition` (`url` only when no `transport` is set). Detected by shape (no dependency on authkit-client; a version without `tenantOf` counts as absent). Each field set in `tenant` wins, one by one, and `tenant: { auto: false }` turns it off. With neither, the boot of a web process or billing worker fails naming both fixes; an ace command logs it. New `agora:doctor` check `payments.tenant` shows where each field came from (`authkit-client (auto)` or `explicit`).
