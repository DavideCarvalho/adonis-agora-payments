---
'@adonis-agora/payments': minor
---

A dispute has a deadline, and now something stores it.

The three dispute events landed and the processor reacted to all of them, but nothing was
persisted: `evidence_due_by` arrived on a webhook, went out on the diagnostics bus, and was gone.
"Which disputes are open, and which windows close this week" could only be answered by opening every
gateway's own dashboard, one at a time — and a window that closes unanswered loses the money by
default rather than on the merits.

**New `billing_disputes` table**, published as `add_billing_disputes` (guarded by `hasTable`, so a
fresh install gets it from `create_billing_tables` and this one does nothing) and declared in the
create migration too. It keeps the dispute's own gateway id (unique — the idempotency key), the
payment's gateway id (indexed — the join back to `billing_payments`), status, reason, amount,
`evidence_due_by`, the outcome, and the opened/closed timestamps.

**New reads on `BillingStore`**: `saveDispute`, `findDisputeByGatewayId`,
`findOpenDisputeByPayment`, `listDisputes`, `countDisputes`, and the two that earn the table —
`listDisputesDueWithin({ withinHours })` and `countDisputesDueWithin(...)`, the open disputes whose
window closes soonest, in deadline order rather than arrival order. A deadline already **past**
stays in the list: the dispute is still open and still unanswered, and dropping it the moment it
expires would make the alert go quiet at exactly the moment it became true. A dispute the gateway
sent no deadline for is never in it — `null` there means "the gateway told us nothing", not "no
hurry".

**The processor writes them.** Each of `payment.dispute_warning`, `payment.disputed` and
`payment.dispute_closed` now persists a dispute row *in addition* to what it already did — a warning
still moves no money, a chargeback still moves the payment to `disputed`, a won close still puts it
back to `paid`, and a close with no outcome still throws. Rows are keyed on the dispute's own gateway
id; where a gateway sends none, on `dispute:<provider>:<payment gateway id>`, so the later events of
one dispute land on the row its opening event created instead of accumulating one row per webhook.

**`node ace payments:health` gained a fourth check**: an open dispute whose evidence window closes
within 72 hours (`--dispute-window` in hours). It exits non-zero like the others and names each
closing window — the dispute, the payment and the deadline — because a count sends nobody anywhere.

**A read-only disputes panel** in the dashboard API: `GET <path>/api/disputes` for the log, and
`?dueWithin=<hours>` for the work list, with the full closing-window total beside the page. No
action buttons, deliberately: whether to fight a dispute or refund it turns on the fee, the evidence
your app holds and the chargeback ratio that triggers network monitoring, and that decision stays in
your code.

An install that upgrades the package before running the migration keeps taking webhooks: the dispute
write is skipped and the dispute reads answer empty, rather than failing every gateway delivery with
`relation "billing_disputes" does not exist`.
