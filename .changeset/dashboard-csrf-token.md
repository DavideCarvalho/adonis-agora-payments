---
'@adonis-agora/payments-dashboard': patch
---

The console's two actions now echo the host app's CSRF token

The dashboard is mounted inside a host application, and an AdonisJS app running
`@adonisjs/shield` guards every state-changing route with CSRF. The SPA sent no token, so
`POST …/refund` and `POST …/webhook-events/:id/retry` were rejected before they reached the
dashboard's own authorization — the button did nothing, and nothing on screen said why.

Shield publishes the token as an `XSRF-TOKEN` cookie for exactly this purpose. Both POSTs
now read it and send `x-xsrf-token`. No cookie means no header, which is the right answer
for a host that does not run shield: an empty token would be worse than none.

Reads are untouched — CSRF only guards mutations.
