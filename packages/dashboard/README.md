# @adonis-agora/payments-dashboard

The billing console for [`@adonis-agora/payments`](https://www.npmjs.com/package/@adonis-agora/payments) — a
React SPA served by a thin AdonisJS provider that ships inside the main package.

Five screens, all driven by the `BillingStore` the app already resolved. Only two things in the whole
console leave your app — refunding a payment and retrying a failed webhook event:

- **Overview** — `billingHealth()` first, then `billingOverview()` for a selectable window: revenue,
  active subscriptions (which includes `trialing`), and metered usage per meter.
- **Payments** — a page of `billing_payments`, newest first, filterable by status and gateway.
  Refund from here.
- **Subscriptions** — opens on `past_due`: whose payment is failing and whose access is about to
  lapse. `paused` is rendered as its own state, never as a shade of `active`.
- **Disputes** — the evidence windows closing soonest first, then the full chargeback log. **Read
  only, deliberately**: whether a dispute is worth contesting or cheaper to refund is a business
  rule that belongs in your app's code, so there is no button for it here (and no API route behind
  one). The screen exists so nobody misses a window.
- **Webhook events** — the idempotency ledger. A `failed` row means a handler threw and the
  dispatcher gave up, so the event's effect never happened; the handler's error is shown in full.
  Retry from here.

## Install

You do not install this package directly. `@adonis-agora/payments` bundles the built SPA and serves it
from disk; this package only exists so the bundle is built in the workspace and versioned on its own.

```sh
node ace configure @adonis-agora/payments
```

That registers `@adonis-agora/payments/dashboard_provider` and publishes `config/payments_dashboard.ts`.

## Configuration

```ts
// config/payments_dashboard.ts
import { defineConfig } from '@adonis-agora/payments/dashboard'

export default defineConfig({
  enabled: true,               // false => no routes are registered at all
  path: '/payments-dashboard', // the SPA mounts here; the JSON API at <path>/api
  currency: 'BRL',             // how the edge formats the integer cents it receives
})
```

**Auth defaults to the same posture as `@adonis-agora/durable`'s console**: open outside production;
in production it requires a bearer token equal to `PAYMENTS_DASHBOARD_TOKEN`, and denies everything
when that variable is unset. Replace `authorize` with your own guard, and/or add the optional
`dashboardAuth` session gate (a built-in login page and/or an "open the console from your app"
endpoint) on top of it.

## Money

Amounts are integer cents everywhere — in the store, in `billingOverview()`, and on the wire. The only
division by 100 in the whole console is in `src/app/money.ts`, at render.

## Mounting anywhere

`vite build` bakes a placeholder base (`/__PAYMENTS_DASHBOARD__/`) into the asset URLs, which the
AdonisJS provider rewrites at serve time to whatever `path` is configured. One built bundle mounts at
any prefix with no rebuild.
