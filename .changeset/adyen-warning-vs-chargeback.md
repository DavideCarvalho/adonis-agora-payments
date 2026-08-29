---
'@adonis-agora/payments': minor
---

Adyen's `NOTIFICATION_OF_CHARGEBACK` was moving a paid payment to `disputed` before Adyen had taken
anything.

Adyen's webhook reference is explicit about which dispute events withdraw funds, and three of them
do not: `NOTIFICATION_OF_FRAUD` (the issuer's TC40/SAFE alert), `REQUEST_FOR_INFORMATION` (the scheme
asking a question) and `NOTIFICATION_OF_CHARGEBACK` (a chargeback announced, not yet taken). The
driver mapped the third to `payment.disputed`, so the payment row stopped saying `paid` over money
still sitting in the account. All three are now **`payment.dispute_warning`**.

`NOTIFICATION_OF_CHARGEBACK` is also the only event carrying `additionalData.defensePeriodEndsAt` —
the deadline that makes a dispute actionable at all. It now comes through as `actionableUntil` on the
normalized event, alongside the dispute's own `pspReference` as `disputeId`. Flattening the event
into one with no room for a deadline was throwing that field away.

`CHARGEBACK` — the debit itself — stays `payment.disputed`, and stands alone rather than assuming a
notification came first: an ACH return goes straight there with no warning and cannot be defended.

**The resolution is now named.** `CHARGEBACK_REVERSED` and `PREARBITRATION_WON` close a dispute as
`won`; `SECOND_CHARGEBACK` and `PREARBITRATION_LOST` close it as `lost`.
`DISPUTE_DEFENSE_PERIOD_ENDED` means "expired or liability accepted" and the event code does not say
which, so the driver reads `additionalData.disputeStatus` — `Won` → `won`, `Lost` / `Accepted` /
`Undefended` → `lost`, `Expired` → `expired` — and stays a `payment.updated` when it recognizes
nothing, rather than reporting a loss that might be a win. `INFORMATION_SUPPLIED` is a
`payment.updated`: movement inside an open dispute, not a resolution.

Adyen does not treat `CHARGEBACK_REVERSED` as final — pre-arbitration can follow with a second close
carrying the opposite outcome. It is reported anyway, because the alternative was emitting nothing
for a successful defense.

**If you have a handler on `payment.disputed`,** it no longer fires for a notification of chargeback.
That is the fix; add `payment.dispute_warning` if you were relying on hearing about the defense
period there.
