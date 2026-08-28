---
'@adonis-agora/payments': minor
---

PayPal, Razorpay and Square were all reporting a pre-dispute alert as a chargeback, and none of the
four drivers here could tell you how a dispute ended. All four now speak the full dispute
vocabulary — `payment.dispute_warning`, `payment.disputed`, `payment.dispute_closed` — and carry the
response deadline as `actionableUntil`.

**PayPal.** A PayPal dispute is not a card-scheme chargeback; it has a lifecycle of its own and
PayPal decides it. `CUSTOMER.DISPUTE.CREATED` fires at two different points in that lifecycle —
PayPal's own sandbox guide has you assert `dispute_life_cycle_stage` is `INQUIRY` on one test and
`CHARGEBACK` on the next — and the driver mapped both to `payment.disputed`. An `INQUIRY` is the
buyer and seller talking in the Resolution Center with nothing adjudicated and nothing debited, so it
is now **`payment.dispute_warning`**. `CUSTOMER.DISPUTE.UPDATED` carrying a stage past `INQUIRY` is
now `payment.disputed`: PayPal sends no dedicated "escalated to a claim" event, so that is the only
notice a row that opened as a warning ever gets. `CUSTOMER.DISPUTE.RESOLVED` now closes the dispute
with the outcome from `dispute_outcome.outcome_code` — `RESOLVED_SELLER_FAVOUR` → `won`,
`RESOLVED_BUYER_FAVOUR` → `lost`, `CANCELED_BY_BUYER` → `canceled` — and stays a `payment.updated`
for the four codes that do not name who kept the money (`RESOLVED_WITH_PAYOUT` is "the merchant *or*
customer", `ACCEPTED`/`DENIED` are deprecated, `NONE` is "closed without any decision").
`seller_response_due_date` now comes through as `actionableUntil`, and the dispute's `reason` is now
spelled `reason` rather than `disputeReason`.

**Mollie.** Unchanged where it should be: Mollie has no fraud alert, no retrieval request and no
inquiry, so the driver emits no `payment.dispute_warning` and the chargeback object carries no
deadline to surface. What changed is the close — `chargeback.reversed` was a plain `payment.updated`,
which left the row stuck at `disputed` with the revenue written off. It is now
**`payment.dispute_closed` (`won`)**, and the reversal is read from `reversedAt` as well as from the
event name, because the payload is a snapshot and a redelivered `chargeback.received` carries it too.
The chargeback id is now `disputeId` rather than `chargebackId`.

**Razorpay.** `payment.dispute.created` fires for all five dispute **phases**, and two of them are
not a chargeback: `fraud` is the bank's risk-analysis alert and `retrieval` is what Razorpay itself
calls "essentially a *soft* chargeback". Both are now **`payment.dispute_warning`**. `.won`, `.lost`
and `.closed` are now `payment.dispute_closed` — `closed` maps to `canceled`, because Razorpay
defines it as a fraud case that ended after you supplied details or refunded, with no verdict and
nothing deducted. `respond_by` now comes through as `actionableUntil`, and `reason_code` and
`amount_deducted` are on the payload as `reason` and `amountDeducted`. `.under_review` and
`.action_required` stay `payment.updated`.

**Square.** The Dispute `state` now decides the event, on `dispute.created` and
`dispute.state.updated` alike. `INQUIRY_EVIDENCE_REQUIRED` and `INQUIRY_PROCESSING` are
**`payment.dispute_warning`**; `EVIDENCE_REQUIRED` and `PROCESSING` are `payment.disputed` (Square
"withholds the disputed funds from the seller's Square account balance" the moment the bank notifies
it); `WON` closes as `won` and `LOST`/`ACCEPTED` close as `lost` — accepting a dispute is Square
returning the money to the cardholder, so it is a loss. `INQUIRY_CLOSED` names no winner and stays a
`payment.updated`. `due_at` now comes through as `actionableUntil`, and the deprecated
`dispute.state.changed` and `dispute.evidence.deleted` events are recognized.

**If you have a handler on `payment.disputed`,** it no longer fires for a PayPal inquiry, a Razorpay
fraud or retrieval alert, or a Square inquiry. That is the fix — add `payment.dispute_warning` if you
want to hear about them, which you do: that is the window where a refund still stops the chargeback
being filed at all.
