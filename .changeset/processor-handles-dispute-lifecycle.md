---
'@adonis-agora/payments': minor
---

A won dispute now stops counting as lost revenue, and the two dispute events reach the diagnostics
bus they were declared on.

`payment.dispute_warning` and `payment.dispute_closed` existed on the bus with payload types and were
published by **nothing at all** — the drivers emitted them, the processor's switch had no case, so
they fell to the no-op branch. That is the same shape as the bugs this package has spent a release
removing: declared, typed, documented, wired to nothing.

- **`payment.dispute_closed` with `outcome: 'won'` puts the payment row back to `paid`.** A
  chargeback moves it to `disputed` and it stayed there forever; `revenue()` sums rows that are
  `paid`, so money that came back was written off permanently. Only `won` moves it. `lost` and
  `expired` are money that is gone, and `canceled` — the cardholder withdrawing — is deliberately
  **not** treated as a win: on Stripe a withdrawn dispute still has to be closed in your favour with
  evidence, so booking it would count revenue the acquirer has not returned. The row keeps its own
  amount, because a dispute's amount can differ from the charge's.
- **A close with no `outcome` is refused.** It throws rather than defaulting, because defaulting
  would report a result the gateway never sent — a driver that cannot read the outcome is supposed to
  emit `payment.updated` instead, which both Stripe and Adyen do.
- **`payment.dispute_warning` writes nothing.** No money has moved, so a payment that says `paid` is
  telling the truth. It publishes on the bus, carrying `reason` and `actionableUntil`, so a
  subscriber can put the alert in front of somebody while a refund still prevents the chargeback.
- **`DisputeWebhookData` and `isDisputeWebhookData`** are exported. The guard is looser than the
  payment one on purpose: Stripe's early fraud warning object carries no amount or currency at all,
  and refusing it for that would throw away the earliest warning the library gets.

Also documents `payment.disputed` on the diagnostics page, which the processor has published since it
was added and the table never listed — plus a test that fails when any event on the bus is missing
from that table.
