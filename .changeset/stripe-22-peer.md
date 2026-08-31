---
'@adonis-agora/payments': minor
'@adonis-agora/payments-dashboard': patch
---

Stripe SDK 19–22 accepted as a peer (`^17 || ^18 || ^19 || ^20 || ^21 || ^22`)

Stripe 22 widened `Invoice.Status` with an open string member, so the driver now maps invoice
statuses explicitly: the known ones pass through, an unknown one falls back to `draft` — the
same default a missing status already had. Nothing narrows for apps still on 17 or 18.

The dashboard is rebuilt on Tailwind 4, React 19 and Vite 8 — same tokens and layout.
