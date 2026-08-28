---
'@adonis-agora/payments': minor
---

Stripe's `charge.dispute.created` fires for two different things, and the driver read both as one.

A **chargeback** means the cardholder's bank has already pulled the money back. An **inquiry** — the
pre-dispute phase, called a retrieval or a request for information — means the bank is asking a
question and **no funds have been withdrawn**. Stripe distinguishes them only by a status prefix:
an inquiry's `status` starts with `warning_`. The driver ignored the status, so an inquiry moved the
payment row to `disputed` and took a paid payment away over a question.

Now a chargeback stays `payment.disputed`, and an inquiry becomes **`payment.dispute_warning`** and
moves nothing — the payment is still paid, because it is. The inquiry payload's
`evidence_details.due_by` is carried through as `actionableUntil`, which is the whole value of the
alert: Stripe's own guidance is that leaving an inquiry unanswered reads to the issuer as accepting
the claim, and can produce a chargeback that is probably irreversible.

**`radar.early_fraud_warning.created` is now a `payment.dispute_warning` too.** It was passing
through under its raw Stripe name — visible in the ledger, but not something a handler could react
to without knowing Stripe's event vocabulary. It is the issuer's TC40/SAFE fraud report, arriving
before any dispute exists; Stripe's published figure is that around 80% of them become a fraud
dispute if you do nothing. It carries no deadline — the window closes when the chargeback is filed —
so it carries Stripe's `actionable` flag and `fraud_type` as `reason` instead.

**`charge.dispute.closed` now carries the outcome.** It normalizes to `payment.dispute_closed` with
`outcome: 'won' | 'lost' | 'expired'`. `warning_closed` — an inquiry that sat 120 days without
escalating — is `expired` rather than `won`, because the networks send no explicit win for an
inquiry: nothing was decided in your favour, the clock ran out the right way. A close whose status
the driver cannot read stays a `payment.updated` rather than inventing a result.

`charge.dispute.updated`, `.funds_withdrawn` and `.funds_reinstated` are unchanged: movement inside
an open dispute, not a resolution of it.

**If you have a handler on `payment.disputed`,** it will no longer fire for inquiries. That is the
fix, but it is a behavior change: if you were relying on it to hear about inquiries at all, handle
`payment.dispute_warning` as well.
