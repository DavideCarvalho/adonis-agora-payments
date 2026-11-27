---
"@adonis-agora/payments": patch
---

`node ace configure @adonis-agora/payments --topology=tenant` publishes `config/payments.ts` in the tenant form (`topology: 'tenant'` with `tenant.providers` and `methods`), with a note that url, token and partition come from `@adonis-agora/authkit-client` and the explicit fields commented out, and skips the gateway credential env validations a tenant never uses. Without the flag, configure is unchanged.
