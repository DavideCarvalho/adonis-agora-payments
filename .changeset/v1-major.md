---
"@adonis-agora/payments": major
"@adonis-agora/payments-dashboard": major
"@adonis-agora/payments-react": major
---

1.0. The 0.x aliases are removed. See "Migrating to 1.0" in the docs.

- `@adonis-agora/payments`: `Payment.pixQrCode` is removed. Use `Payment.pixQrCodeImage`.
- `@adonis-agora/payments`: `Payment.pixCopiaECola` and `CheckoutSession.pixCopiaECola` are removed. Use `pixCode`. No driver sets the old names any more.
- `@adonis-agora/payments`: the `billing.durable` config option is removed. Use `billing.dispatcher` (`true` → `'durable'`, `false` → `'in-process'`). A config that still sets `durable` fails at boot with a message naming the replacement. The `configure` stub now writes `dispatcher: 'auto'`.
- `@adonis-agora/payments`: the payments client endpoint's default `authorize`/`owner` read only `ctx.auth.user`; the `ctx.auth.getUser()` probe (old authkit-client) is removed. Pass your own `authorize`/`owner` for any other auth shape.
- `@adonis-agora/payments`: `PROVIDER_SCAN_CAP` is no longer exported from `@adonis-agora/payments/dashboard`.
- `@adonis-agora/payments-dashboard`: the SPA no longer reads the `window.__PAYMENTS_BASE__` / `__PAYMENTS_API__` / `__PAYMENTS_CURRENCY__` / `__PAYMENTS_AUTH__` globals; config comes only from the provider's JSON data block. Without a block it falls back to `/payments`, the server's default mount (was `/payments-dashboard`).
- `@adonis-agora/payments-dashboard`: the `react` / `react-dom` peers are dropped. The console ships prebuilt with React bundled.
- The optional `@adonis-agora/durable` peer is widened to `>=0.1.0 <2.0.0 || >=1.0.0-rc.0 <2.0.0`.
- All packages require Node `>=24` (tested on 24 and 26).
