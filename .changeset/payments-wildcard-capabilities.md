---
'@adonis-agora/payments': patch
---

Control plane: service-token capabilities now match with the Agora-wide wildcard rule. A `*` segment matches exactly one segment and a trailing `*` matches any further segments (`*`, `payments:*` keep working as before). New `capabilityAllows(granted, required)` export; `hasCapability` delegates to it.
