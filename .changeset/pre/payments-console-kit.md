---
'@adonis-agora/payments': minor
'@adonis-agora/payments-dashboard': minor
---

The payments console now runs on the shared Agora console kit, with the same look as the other Agora consoles.

- Shell: a left sidebar grouped into MONITOR (Overview, Activity), BILLING (Payments, Subscriptions, Customers, Disputes) and INTEGRATIONS (Webhook events). It becomes a drawer at phone width. The topbar holds the page title, the organization picker and ⌘K search. The footer shows the signed-in user, a light/dark toggle and sign-out. The centered max-width layout is gone, and the accent is cyan `#22d3ee`. Viewing a single organization still hides Activity and Webhook events.
- Pages: each page has a header, metric cards, and tables on the kit's DataTable with skeleton rows, empty states and pagers. Error boundaries wrap every page and region. Payment and subscription details open as a side sheet, and refund and dispute outcome use the kit dialogs. Light mode works. The fonts (Sora and JetBrains Mono) are bundled, so there are no Google Fonts requests.
- Server: the page's data block gains `search`, `viewer` and `signOut`. A new `viewer(ctx)` config option sets the user row, and without it the console reads `ctx.auth.user`. A new `signOut` option sets the sign-out, and without it the console uses the sign-out authkit announces on the `agora.consoles` registry. A POST sign-out carries `request.csrfToken`. `renderIndexHtml` takes these shell fields as its fifth argument, and a bare switcher config still works there.
