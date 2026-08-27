---
'@adonis-agora/payments-dashboard': minor
'@adonis-agora/payments': minor
---

Add `@adonis-agora/payments-dashboard`, the billing console for `@adonis-agora/payments`.

A React SPA (Vite + Tailwind + TanStack Query) with three read-only screens — an overview of
`billingOverview()`'s revenue/subscription/usage aggregates over a selectable window, a payment list,
and the webhook-event ledger that surfaces `failed` rows with the handler error that caused them.
Everything is a `BillingStore` read; the console makes no gateway calls and has no control actions.

The Adonis half ships inside `@adonis-agora/payments` and mirrors `@adonis-agora/durable`'s dashboard:
a `dashboard_provider` that serves the built bundle from disk (never importing the SPA package), the
`BASE_PLACEHOLDER` rewrite that lets one bundle mount at any path, framework-light JSON handlers, and
the same optional `dashboardAuth` session gate. New entry points: `@adonis-agora/payments/dashboard`
and `@adonis-agora/payments/dashboard_provider`, plus a published `config/payments_dashboard.ts`.

The dashboard is off-able entirely (`enabled: false` registers no routes at all) and defaults to the
same safe auth posture as the durable console: open outside production, and in production a bearer
token equal to `PAYMENTS_DASHBOARD_TOKEN`, denying when it is unset.

Also adds two narrow reads to the `BillingStore` contract — `listPayments(query)` and
`listWebhookEvents(query)` — implemented in both `LucidBillingStore` and `InMemoryBillingStore`. They
return a normalized plain shape rather than the implementation's row type, so a reader never depends
on Lucid.
