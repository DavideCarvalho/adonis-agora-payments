---
"@adonis-agora/payments-dashboard": minor
"@adonis-agora/payments": patch
---

Dashboard: survives a strict CSP, fits on a phone, has URLs, and no longer links to a 404.

- **Every API request 404 under a nonce CSP — fixed.** The provider used to hand the SPA its
  mount/API base as an inline `<script>` setting `window.__PAYMENTS_*__`. A host with
  `script-src 'self' 'nonce-…'` (`@adonisjs/shield`'s `@nonce`) drops that script silently; the SPA
  then fell back to `/payments-dashboard/api` and every request from a console that rendered fine
  answered 404. The config now travels as a `<script type="application/json">` data block, which
  is never executed and so cannot be refused. Nothing to change on the host. The globals are still
  honoured as a fallback for tests/embedding.

- **Hash routes.** The current screen lives in the URL fragment (`#/webhooks`,
  `#/webhooks?status=failed`, `#/payments?customer=cus_…`, `#/payments/<gatewayId>` for one payment
  open in full), so the back button works, a reload comes back to the same screen, and a view can be
  pasted into a ticket. The health panel's buttons write the same hashes they used to set in state.
  A fragment rather than a path because the provider deliberately registers no SPA catch-all.
- **Mobile.** Every pill row (the tab bar, the status filters) scrolls sideways instead of pushing
  the page wider than the viewport; the detail and confirm dialogs no longer overflow on a long
  gateway id; tighter page padding under `sm`.
- **Sign out only where it can work.** The config block now carries the auth surface
  (`auth: { modes } | null`), and the SPA shows the Sign out link only
  when `dashboardAuth` is configured — that is the only configuration that registers
  `<path>/logout`; on every other deployment the link was a 404 one click away.
- **Favicon.** Inline SVG icon, so the browser's automatic `/favicon.ico` probe stops 404ing in the
  host app's log.

`renderIndexHtml` gains an optional fifth argument (`InjectedAuth`) and now emits the JSON block instead of the globals; `CONFIG_ELEMENT_ID`/`InjectedConfig` are exported. Existing callers are unaffected.
