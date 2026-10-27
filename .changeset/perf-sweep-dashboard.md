---
"@adonis-agora/payments-dashboard": patch
---

perf: memoize the `Intl.NumberFormat`/`Intl.DateTimeFormat` instances behind the money, count and date cell formatters instead of constructing a new one per cell on every refetch (~20-50x cheaper per formatted value).
