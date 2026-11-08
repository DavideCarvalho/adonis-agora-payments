---
'@adonis-agora/payments': patch
---

The Stripe driver sends a customer's CPF/CNPJ as a TaxID object instead of a plain `tax_id` string.

`tax_id` is not a field Stripe accepts on a customer — the request failed, and the customer
was created without the tax id, which only shows up when the fiscal side of the checkout runs.
A new customer now carries `tax_id_data` with `br_cpf` (11 digits) or `br_cnpj` (14), and an
update adds the id through the TaxID resource, because `tax_id_data` is create-only there and
Stripe silently ignores it on an update.
