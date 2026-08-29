---
'@adonis-agora/payments-dashboard': minor
'@adonis-agora/payments': minor
---

Add the **Disputes** screen to the billing console. `billing_disputes` had a full JSON API and no
UI, so the one table in this package with a deadline was the one you could not see.

A chargeback has a clock, and missing it loses the money **by default rather than on the merits**,
so the screen leads with the clock rather than with the log. Two panels, in this order:

- **Evidence windows closing** — `GET <api>/disputes?dueWithin=<hours>`: open disputes carrying a
  deadline, soonest first, deadline as the leading column. The countdown is in hours (`in 5 hours`),
  not days: rendering that as "today" is the difference between filing this morning and losing by
  default. The horizon picker opens on **72 h** — the same horizon `payments:health` alerts on, so
  the console and the cron agree about "soon" — and the count above the table is the server's
  unbounded `dueWithin.total`, not the page it happened to fit.
- **All disputes** — the log, newest first, filterable by status and gateway.

The work list is deliberately **not** filterable by gateway. It is the one list whose whole job is
that nothing gets missed, and narrowing it to Stripe while an Asaas window shuts tonight is exactly
the failure it exists to prevent.

Three nullable facts are rendered as the things they mean, not as missing data:

- a window **already past its deadline still appears**, marked `past due` with how long ago — it is
  still open and still unanswered, and going quiet the moment it expires reads as resolved;
- a dispute with **no deadline** is absent from the work list and says *the gateway sends no
  deadline* in the log, rather than showing a dash. Several gateways send no date, and Woovi's
  three-day rule is policy rather than a field;
- a dispute with **no amount** (Stripe's early fraud warning carries none) says so instead of
  rendering `R$ 0,00`.

`warning` does not look like a chargeback: nothing has been pulled back, a refund still prevents the
debit, and the row says *no money moved* in words rather than leaving it to a hue. The seven
`DisputeStatus` values get their own hues, and an unmodelled gateway status falls back to grey
rather than borrowing one.

**The screen is read-only and stays that way.** No "fight this", no "accept", no "refund": whether
contesting is worth it turns on margin, customer value, the dispute fee and the chargeback ratio
that puts a merchant into a card network's monitoring programme. That is a business rule that lives
in your app's code, and a console button invites someone to press it without any of that context.
The JSON API has no action route for disputes, and a test asserts the client grows no method that
implies one.

Also in the console: the health panel's fourth check (`disputes_due`) now has somewhere to go — its
button opens the Disputes screen on exactly the rows it counted — and the panel names **which**
windows are closing, with gateway, dispute id and countdown, instead of only how many.
