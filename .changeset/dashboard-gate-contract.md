---
"@adonis-agora/payments": minor
---

Dashboard `authorize` now takes the shared Agora dashboard-gate contract: return `boolean | { allowed, reason?: 'unauthenticated' | 'forbidden' }`. `{ allowed: false }` denies (403), `reason: 'unauthenticated'` answers 401 (access-denied page with that reason, or `{ error: 'unauthorized' }` on the API), and a throwing hook is a 403 instead of an unhandled error. A hook that already wrote a redirect still wins. `AuthorizeDecision` and `AuthorizeResult` are exported from `@adonis-agora/payments/dashboard`. The client endpoint's `authorize` accepts the same shape (`{ allowed: false }` denies with 401; `reason: 'forbidden'` is 403), so `@adonis-agora/authz`'s `authorizeByRoles` stays safe once it returns decisions.
