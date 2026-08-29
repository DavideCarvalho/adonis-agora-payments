---
'@adonis-agora/payments': minor
---

A chargeback has a deadline, and until now nothing in the library knew it.

`payment.disputed` moved the payment row off `paid`, which stopped the worst version of the bug —
revenue counted twice while the money was already going back. But a dispute is not one moment, it is
three, and the library had a name for only the middle one. The two that decide the outcome were
missing: the **warning** that arrives before a chargeback exists, when refunding is still cheaper
than losing, and the **close** that carries whether you won.

**The contract.** `Dispute` and `DisputeEvidence` are shared types now, and the driver contract
carries `capabilities.disputes` plus optional `findDispute` and `submitDisputeEvidence`. `Dispute`
leads with `evidenceDueBy` and `canSubmitEvidence` because those are the two fields an operator acts
on — every network gives a fixed window to respond, and missing it loses the money by default rather
than on the merits. Both methods are optional: a gateway with no dispute API declares
`disputes: false` and the router refuses before a call is made, rather than a driver returning an
empty object that reads like "no disputes".

**Two new canonical webhook types.** `payment.dispute_warning` and `payment.dispute_closed` join
`WEBHOOK_EVENT_TYPES`, and the diagnostics bus publishes them with the fields that make them
actionable — `actionableUntil` on the warning, `outcome` on the close. **No driver maps them yet**;
they are declared so the drivers can be wired one at a time against real gateway payloads without
each one inventing its own name for the same event. Today Adyen's `NOTIFICATION_OF_FRAUD` still
flattens to `payment.updated` and Stripe's `radar.early_fraud_warning.created` lands in the ledger
as an unknown type. Both are tracked in the roadmap.

**What this deliberately does not do:** decide. The library carries evidence to the gateway and tells
you a window is closing. Whether a dispute is worth fighting or cheaper to refund depends on margin,
customer value and fraud history — that is a business rule, and it stays in your code.
