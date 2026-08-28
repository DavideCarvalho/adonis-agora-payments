---
'@adonis-agora/payments': patch
---

Two Asaas statuses meaning **the customer paid** were reading as unpaid.

`RECEIVED_IN_CASH` — a receipt confirmed by hand in the Asaas UI, the customer paid at the counter —
and `DUNNING_RECEIVED` — the debt settled through the credit bureau after a *negativação* — both
fell through the status map's `pending` default. So someone who had paid read as never having paid,
and stayed locked out of what they bought. `PAYMENT_DUNNING_RECEIVED` also had no webhook mapping,
which meant the one event announcing that a written-off debt came back ran no sync at all.

The rest of the statuses Asaas has and the driver did not, now that they are all named rather than
silently agreeing with a default:

- `REFUND_REQUESTED` and `REFUND_IN_PROGRESS` stay **`paid`**. A refund asked for or scheduled has
  settled in neither case, and Asaas can still deny one (`PAYMENT_REFUND_DENIED`). `pending` claimed
  the charge was never paid; `refunded` would write off money still in the account.
- `DUNNING_REQUESTED` is **`failed`** — overdue and escalated, same as `OVERDUE`.
- `AWAITING_RISK_ANALYSIS` is **`pending`**, which the default already got right by accident and now
  says on purpose. Asaas' own guidance is to wait before releasing the product.

New webhook mappings: `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED` and `PAYMENT_REPROVED_BY_RISK_ANALYSIS`
→ `payment.failed`. `PAYMENT_PARTIALLY_REFUNDED` → **`payment.updated`, deliberately not
`payment.refunded`**: that handler overwrites the row's status with `refunded` and its amount with
the refunded amount, so routing a R$10 refund on a R$100 charge there would drop R$90 of revenue
instead of subtracting R$10. Until the billing tables carry a refunded amount, an update is the
arithmetic-safe half. `PAYMENT_REFUND_IN_PROGRESS`, `PAYMENT_REFUND_DENIED`,
`PAYMENT_AWAITING_RISK_ANALYSIS`, `PAYMENT_APPROVED_BY_RISK_ANALYSIS`, `PAYMENT_DUNNING_REQUESTED`,
`PAYMENT_RECEIVED_IN_CASH_UNDONE`, `PAYMENT_DELETED` and `PAYMENT_RESTORED` are updates too — named
rather than arriving as unrecognized types.

**If you were compensating for this** — treating `pending` Asaas rows as possibly-paid, or polling
`findPayment` after a dunning — you can stop. Rows that were already wrong stay wrong until the
payment is re-synced; `payments:sync` fixes them.
