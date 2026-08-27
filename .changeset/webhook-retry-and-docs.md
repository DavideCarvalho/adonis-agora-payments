---
'@adonis-agora/payments': patch
---

Fix webhook retries, which were dead code, and deepen the docs.

Every retry short-circuited on the idempotency ledger and silently did nothing. The first attempt
claimed the event; when its handler threw, the row was marked `failed` — and `recordWebhookEvent`
refused any event it had already seen, so the retry returned `false` before running anything. This
affected the in-process dispatcher and the durable path alike: a webhook whose handler failed once
was never processed, and it looked exactly like a webhook that was never delivered.

An event whose previous attempt **failed** is now claimable again, so the retry re-runs it. A
genuine redelivery — an event still in flight, or already processed — is refused exactly as before.

Docs gain a Concepts section (money as an integer, the driver contract and routing, the payment
lifecycle, idempotency) plus patterns, production, troubleshooting, cli and api-reference pages, and
document `billing.dispatcher` and `billingOverview`, which shipped undocumented.
