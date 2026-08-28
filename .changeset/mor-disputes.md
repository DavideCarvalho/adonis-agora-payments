---
'@adonis-agora/payments': minor
---

The dispute vocabulary on the four merchant-of-record gateways — Paddle, Lemon Squeezy, Polar and
Dodo Payments. On an MoR the gateway is the seller on the cardholder's statement, so the dispute is
legally the gateway's and not yours. That changes what the events mean, and it turns out to change it
differently on all four. All four keep `capabilities.disputes: false`, now declared rather than
implied.

**Paddle: `chargeback_warning` is not a funds-untouched warning, and it now moves the row.** Paddle
Billing has no `dispute.*` event at all — the whole dispute vocabulary is the `action` field on an
adjustment. Both `chargeback` and `chargeback_warning` are now **`payment.disputed`**, which runs
opposite to the Stripe and Adyen pre-dispute alerts on purpose: Paddle is the merchant of record and
acts on the early warning instead of forwarding it, so "the disputed amount is refunded" the moment
that adjustment is created. Mapping it to `payment.dispute_warning` writes nothing to the payment row
and would leave it saying `paid` over money Paddle has already returned to the buyer. Paddle
therefore sends **no** funds-untouched pre-dispute notification, and this driver does not invent one.

`chargeback_reverse` and `chargeback_warning_reverse` now close the dispute as
**`payment.dispute_closed` with `outcome: 'won'`** — both put the amount back, and leaving the row at
`disputed` writes off money that returned. Every dispute event now carries the adjustment id as
`disputeId` and the adjustment's `reason`. Only `adjustment.created` is a dispute moment;
`adjustment.updated` stays `payment.updated`, because it fires for the approval lifecycle of an
adjustment that already exists.

**There is no `actionableUntil` on Paddle, and that is the finding, not a gap.** "The Paddle team
contests chargebacks for you", and the defense "is fully automated, and additional evidence submitted
by sellers is not required or accepted". No response window belongs to you and no adjustment field
carries one.

**Dodo: the whole lifecycle now has outcomes.** `dispute.won` → `won`, `dispute.lost` and
`dispute.accepted` → `lost` (accepting without contest is a loss, not a cancellation),
`dispute.expired` → `expired`, `dispute.cancelled` → `canceled`. `dispute.challenged` stays
`payment.updated` — movement inside an open dispute. A `dispute.*` event whose `payload_type` is not
`Dispute` degrades to `payment.updated` rather than a close the processor would throw on for carrying
no outcome. The dispute's `remarks` now comes through as `reason`.

`dispute.opened` stays `payment.disputed` at **every** `dispute_stage`, including `pre_dispute`.
Dodo's reference says "Cardholder initiates dispute; funds are held" without qualifying it by stage,
so downgrading a `pre_dispute` open to a warning would leave the row saying `paid` over money Dodo
says it has already held. The stage travels on `event.data.disputeStage`.

Dodo is the one MoR here where the fight and the clock are yours — ten days, evidence through the
Dodo dashboard — but it sends **no deadline field**, so there is no `actionableUntil`. The driver
deliberately does not derive `created_at + 10 days`: that would put a date the library invented into
the one field an operator is meant to trust. The rule is documented on the provider page instead.

**Lemon Squeezy and Polar send nothing at all, now proven rather than asserted.** Neither catalogue
has a dispute or chargeback event; Lemon Squeezy has no `order_updated` either, so the `fraudulent`
order status it uses for a charged-back order can never reach a webhook handler, and Polar's Order
status enum has no charged-back value. Both gateways manage the dispute themselves and bill you the
$15 network fee. Each driver now has a test asserting that **no** event it can receive produces
`payment.disputed`, `payment.dispute_warning` or `payment.dispute_closed`, so a well-meaning future
mapping cannot quietly invent one. Worth knowing on Polar: Rapid Dispute Resolution auto-refunds a
dispute, so a chargeback genuinely can reach you as an ordinary `refund.created` — it stays
`payment.refunded`, because that is what happened to the money.

**If you have a handler on `payment.disputed`,** it now also fires for a Paddle `chargeback_warning`.
That is the fix.
