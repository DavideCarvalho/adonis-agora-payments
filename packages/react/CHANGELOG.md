# @adonis-agora/payments-react

## 1.0.0-rc.0

### Major Changes

- [#220](https://github.com/DavideCarvalho/adonis-agora-payments/pull/220) [`198495f`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/198495f227b18603e0082687d1d7b116eccac4f5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - 1.0. The 0.x aliases are removed. See "Migrating to 1.0" in the docs.
  
  - `@adonis-agora/payments`: `Payment.pixQrCode` is removed. Use `Payment.pixQrCodeImage`.
  - `@adonis-agora/payments`: `Payment.pixCopiaECola` and `CheckoutSession.pixCopiaECola` are removed. Use `pixCode`. No driver sets the old names any more.
  - `@adonis-agora/payments`: the `billing.durable` config option is removed. Use `billing.dispatcher` (`true` → `'durable'`, `false` → `'in-process'`). A config that still sets `durable` fails at boot with a message naming the replacement. The `configure` stub now writes `dispatcher: 'auto'`.
  - `@adonis-agora/payments`: the payments client endpoint's default `authorize`/`owner` read only `ctx.auth.user`; the `ctx.auth.getUser()` probe (old authkit-client) is removed. Pass your own `authorize`/`owner` for any other auth shape.
  - `@adonis-agora/payments`: `PROVIDER_SCAN_CAP` is no longer exported from `@adonis-agora/payments/dashboard`.
  - `@adonis-agora/payments-dashboard`: the SPA no longer reads the `window.__PAYMENTS_BASE__` / `__PAYMENTS_API__` / `__PAYMENTS_CURRENCY__` / `__PAYMENTS_AUTH__` globals; config comes only from the provider's JSON data block. Without a block it falls back to `/payments`, the server's default mount (was `/payments-dashboard`).
  - `@adonis-agora/payments-dashboard`: the `react` / `react-dom` peers are dropped. The console ships prebuilt with React bundled.
  - The optional `@adonis-agora/durable` peer is widened to `>=0.1.0 <2.0.0 || >=1.0.0-rc.0 <2.0.0`.
  - All packages require Node `>=24` (tested on 24 and 26).

## 0.2.1

### Patch Changes

- [#179](https://github.com/DavideCarvalho/adonis-agora-payments/pull/179) [`6968caf`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/6968cafa9897c05669886d0472f35ca82111c228) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - perf: `usePaymentStatus` no longer re-renders the consumer on every poll that returns the same snapshot (e.g. still `pending`); the previous state object is kept so React bails out.

## 0.2.0

### Minor Changes

- [#148](https://github.com/DavideCarvalho/adonis-agora-payments/pull/148) [`2ae630b`](https://github.com/DavideCarvalho/adonis-agora-payments/commit/2ae630b7393c4e251ce47049b3467282a335326b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Drop Node 20, which reached end-of-life on 2026-04-30, and Node 22, which AdonisJS 7 does not support (it requires Node >=24): `engines.node` is now `>=24`. The supported Node lines are 24 and 26, and CI runs the test suite on each of them.
