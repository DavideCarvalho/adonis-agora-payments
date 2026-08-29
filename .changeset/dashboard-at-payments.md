---
'@adonis-agora/payments': minor
---

**The dashboard mounts at `/payments` now, not `/payments-dashboard`.**

It shares that prefix with the machine endpoints — `POST /payments/webhook/:provider` and
`GET /payments/client/status` — and the old default existed because that looked dangerous: a console
guard sitting in front of a gateway's delivery endpoint is how a webhook ends up answering `403` to
Stripe.

It is not dangerous, because every route the dashboard provider registers is an **exact** path:
`/payments`, `/payments/assets/:file`, `/payments/api/…`, and the login routes. There is no SPA
catch-all, so the guard cannot reach a delivery it was never routed. The test that used to assert
"no dashboard route starts with `/payments`" now asserts the invariant that actually matters — no
wildcard, and nothing dynamic directly under the prefix, either of which would swallow
`:provider` and `client`.

**To keep the old URL**, set it explicitly:

```ts
// config/payments_dashboard.ts
export default defineConfig({ path: '/payments-dashboard' })
```

Also: `assertCapability` accepts `'disputes'`. The capability has been on the driver contract since
disputes landed and was read by nothing, so an app could call `submitDisputeEvidence` on a gateway
that had already declared it does not support it.
