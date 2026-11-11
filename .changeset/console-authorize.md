---
"@adonis-agora/payments": major
---

Dashboard `authorize` adopts the shared Agora console contract, and the console behaves like every other Agora console.

- `authorize` takes an inline function, an authorizer class (built through the container, so `@inject()` works), or a lazy import `() => import('#policies/console_access')`. An authorizer may answer `{ redirectTo }`: a `302` for page navigations, `401 { error: 'unauthenticated', redirectTo }` for API calls. A throw is a `403`.
- With `authorize` omitted the console is open outside production and answers every request with `403` in production, and the app logs one warning at boot: ``[@adonis-agora/payments] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/payments_dashboard.ts.``
- `PAYMENTS_DASHBOARD_TOKEN` is removed, with the `x-payments-token` header and the `?token=` query param, and `defaultAuthorize` is no longer exported. For token access use the new `authorizeByToken({ token: env.get('CONSOLE_TOKEN') })`, which checks `Authorization: Bearer <token>` in constant time and answers `401` otherwise. An empty token throws when the config loads.
- API denials from `authorize` answer `{ error: 'forbidden' }` (`403`) or `{ error: 'unauthenticated' }` (`401`, was `'unauthorized'`). The `dashboardAuth` session `401` is unchanged.

Exported from `@adonis-agora/payments/dashboard`: `ConsoleAuthorize`, `ConsoleAuthorizer`, `ConsoleAuthorizerClass`, `ConsoleAuthorizeResult`, `resolveConsoleAuthorize`, `authorizeByToken`. `ResolvedPaymentsDashboardConfig['authorize']` is now `ConsoleAuthorize | null`. The payments client endpoint (`config/payments_client.ts`) and payment-driver tokens are unchanged.
