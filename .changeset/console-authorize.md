---
"@adonis-agora/payments": major
---

Dashboard `authorize` adopts the shared Agora console contract. It now takes an inline function, an authorizer class (built through the container, so `@inject()` works), or a lazy import `() => import('#policies/console_access')`, and an authorizer may answer `{ redirectTo }` (a `302` for page navigations, `401` for API calls). A throw is still a `403`. Exported from `@adonis-agora/payments/dashboard`: `ConsoleAuthorize`, `ConsoleAuthorizer`, `ConsoleAuthorizerClass`, `ConsoleAuthorizeResult`, `resolveConsoleAuthorize`.

With `authorize` omitted the console stays open outside production and closed in production unless `PAYMENTS_DASHBOARD_TOKEN` is set; with neither, every request is a `403` and the app now logs a warning at boot telling you to set `authorize`.

Breaking for typed code: `ResolvedPaymentsDashboardConfig['authorize']` is now `ConsoleAuthorize` (function, class or lazy import), not only a function. The payments client endpoint (`config/payments_client.ts`) is unchanged.
