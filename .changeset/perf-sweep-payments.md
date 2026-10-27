---
"@adonis-agora/payments": patch
---

perf: dedupe concurrent PayPal OAuth token mints (a burst of calls on a cold or just-expired cache now shares one `/v1/oauth2/token` request, like the Efí driver already did); the console's disputes "due within" and subscriptions endpoints run their independent page/count reads in parallel instead of sequentially; `createBillingTables` adds `billing_subscriptions_external_reference_idx` so `listSubscriptions({ externalReference })` is an indexed lookup instead of a full table scan.
