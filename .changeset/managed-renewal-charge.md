---
'@adonis-agora/payments': minor
---

`renewDue()` now returns the created charge and the `externalReference` on `charged` outcomes, so an application can deliver a Pix code or payment link to the customer.
