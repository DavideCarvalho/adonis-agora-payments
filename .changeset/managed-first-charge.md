---
'@adonis-agora/payments': patch
---

Fix: when the first charge of a managed subscription failed, its row stayed `active` and was charged again one period later, debiting a customer whose signup had failed. The row is now closed before the error propagates.
