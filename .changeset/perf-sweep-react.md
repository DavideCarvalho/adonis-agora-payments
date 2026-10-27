---
"@adonis-agora/payments-react": patch
---

perf: `usePaymentStatus` no longer re-renders the consumer on every poll that returns the same snapshot (e.g. still `pending`); the previous state object is kept so React bails out.
