---
'@adonis-agora/payments': minor
---

The console can see — and be trusted about — library-managed subscriptions.

Managed subscriptions shipped without the console catching up, and the gap was widest exactly
where it matters: a managed row has no `gatewayId`, so there is no gateway dashboard to fall
back to. The console WAS the fallback, and it showed a null id and nothing else.

**A dead renewal cron is now visible.** `renewDue` only runs because something calls it; if the
cron stops, nothing renews, nothing fails, and nothing says so — the revenue just stops. New
health check `overdue_renewals` counts active managed subscriptions whose next charge came due
over 2 h ago (configurable via `overdueRenewalAfter`).

**A failing renewal is now visible.** A failed cycle deliberately changes nothing on the row —
the period does not advance, so it retries — which is also why it was invisible: one failing for
a week looked identical to one due for the first time. The runner now records
`lastRenewalError`, `lastRenewalAttemptAt` and `renewalFailureCount` (a streak, reset on the
first success), surfaced as the `failing_renewals` check and in the subscriptions list. The two
checks are separate because the causes are opposite: one is the cron stopped, the other is the
cron running and the gateway saying no.

**The subscriptions list carries the recurrence.** `amount`, `currency`, `cycle`,
`currentPeriodEnd`, `nextChargeAt`, `cancelAtPeriodEnd` and the renewal-failure fields, plus a
`managed` flag so an operator knows there is nothing to open at the gateway.

**MRR.** `subscriptionAmountByCycle` groups active managed subscriptions by cycle and the new
`monthlyRecurringRevenue()` normalises to a month. Managed only — a gateway-owned subscription
keeps its price at the gateway, and summing both would present half the truth as the total. An
unknown cycle is skipped rather than counted as monthly: an MRR wrong upwards is worse than an
incomplete one, because nobody audits a number that looks good.

**No more buttons that cannot work.** `GET <api>/providers` now returns per-provider
capabilities, and `refundable` on a payment row accounts for them. Every paid Woovi/OpenPix Pix
row offered a Refund the gateway has no API for; the operator found out by clicking. With no
reachable manager the action is still offered — the previous behaviour, and better than hiding a
working button because a lookup was unavailable.

`BillingCountQuery` gains `managed`, `nextChargeBefore` and `minRenewalFailures`.
