---
'@adonis-agora/payments': patch
'@adonis-agora/payments-dashboard': patch
---

Console: the webhook events "Type" filter is a select with autocomplete (type `refund` to find `payment.refunded`), over the event types the ledger has received. Adds the kit's `ComboSelect` / `ComboMultiSelect`.
