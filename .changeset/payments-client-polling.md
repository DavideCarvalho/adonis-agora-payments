---
'@adonis-agora/payments': minor
---

Add the browser-facing payment status endpoint, plus a new `@adonis-agora/payments-react` package with the `usePaymentStatus` hook that polls it.

A Pix QR code (or a boleto) is not paid until the gateway's webhook confirms it, seconds to days later. Every app that takes Pix hand-writes the same polling loop, and most write it without backoff, without a stop condition, and without cleanup on unmount.

**Server.** A new opt-in config (`config/payments_client.ts`) and provider (`@adonis-agora/payments/payments_client_provider`) mounting one route:

```
GET /payments/client/status?reference=<reference>
-> { status, amount, currency, paidAt }
```

Disabled by default — unlike the dashboard, this endpoint is reachable by every logged-in browser. The response is deliberately four fields: no payload, no customer, no gateway ids.

Ownership is enforced ahead of the lookup. `authorize` decides whether the request may exist (default: a user resolved structurally off `ctx.auth`, so authkit, `@adonisjs/auth` and a custom guard all work and none is a dependency), `owner` says who is asking, and `authorizeReference` decides whether that caller may see this payment. The default `authorizeReference` checks the payment's gateway customer against the one the owner holds in `billing_customers`; an app that never recorded that mapping is **denied** with a message telling it to use `ensureCustomer({ store, owner })` or supply its own hook — never silently allowed. Every answer carries `Cache-Control: no-store` and costs one indexed read, with no gateway call.

**Browser.** `usePaymentStatus(reference)` polls with backoff (2s, growing, capped at 30s) and stops on a terminal status, on unmount, while the tab is hidden (resuming on focus), and on a `401`/`403`. Errors are surfaced, never thrown. No context provider and no data-fetching dependency.

It does **not** wrap any gateway's card SDK — Stripe, Mercado Pago and Adyen ship their own.

See the new [Client polling](https://agora.goflip.ai/docs/payments/client) page, including how to write your own `authorize`/`owner`/`authorizeReference` and how to build the endpoint from scratch as an ordinary controller.
