---
"@adonis-agora/payments-dashboard": minor
---

Console filters now live in the URL, so a filtered view can be shared, bookmarked and reloaded, and back/forward step through it: status, gateway and page on Payments, Subscriptions, Disputes, Webhook events and Activity, the Payments lookup, the Customers gateway and owner id, the webhook event type, the Disputes horizon and the Overview period. They sit in the hash's query next to the `status`/`customer` seeds the health panel already wrote (`#/payments?status=failed&provider=asaas&page=2`); a value at its default is left out, so existing links open as before, and opening a payment or a subscription keeps the list's filters.
