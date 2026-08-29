---
'@adonis-agora/payments': patch
---

A dispute **lost** now takes the payment row off `paid`, even when no `payment.disputed` ever
arrived.

The processor moved the row back to `paid` on a won close and left every other outcome alone, which
quietly assumed a chargeback event had already moved it to `disputed`. Several gateways never send
one: Razorpay documents that it does not debit provisionally at all, PayPal's dispute opens at an
inquiry stage that takes nothing, and Woovi only blocks the balance during a Pix MED. On those the
sequence is `payment.dispute_warning` → `payment.dispute_closed` with `lost`, and nothing in between
ever moved the row — so a payment whose money is definitively gone kept reading `paid`, and
`revenue()` kept counting it.

`expired` and `canceled` still move nothing, deliberately. Expired means the window closed with no
verdict published; canceled means the cardholder withdrew, and on Stripe a withdrawn dispute still
has to be closed in your favour with evidence. Neither is a statement about where the money ended up.
