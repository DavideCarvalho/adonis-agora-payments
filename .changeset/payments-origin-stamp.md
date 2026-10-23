---
'@adonis-agora/payments': patch
---

The durable `payments-webhook` workflow is now registered with `origin: '@adonis-agora/payments'`, so its runs are stamped with the package name and the durable console's ORIGIN facet separates them from the app's own runs. Engines older than `@adonis-agora/durable` 0.36 ignore the option.
