---
'@adonis-agora/payments': minor
'@adonis-agora/payments-dashboard': minor
---

Revenue was reported gross with nothing saying so, and a partial refund was invisible in it.

`billing_payments.refunded_amount` landed in the previous release precisely so a PARTIAL refund
could be recorded without mangling `amount` or `status`: a R$10 refund on a R$100 charge leaves the
row `paid` at `amount: 10000, refundedAmount: 1000`, and the net is one subtraction. But every
aggregate went on summing `amount` alone. `revenue()` and `billingOverview`'s revenue metric counted
that charge at its full R$100, the console printed it under the single word **Revenue**, and nothing
on the screen admitted the number was gross. Money that had already gone back to the cardholder was
being reported as earned.

**`revenue()` is unchanged and still gross.** It was the only revenue figure this library had for
two releases and apps read it; redefining it in a release that already carries breaking changes
would have moved numbers on other people's screens with no error to announce it. Gross and net are
both legitimate — gross is what you collected, net is what you kept — so the fix publishes both.

**`store.netRevenue({ from, to })` is new**, on the `BillingStore` SPI and on BOTH implementations
(`LucidBillingStore` and the `InMemoryBillingStore` in `/testing`). It takes exactly the rows and
the window `revenue()` takes — `status = 'paid'`, windowed on `paid_at` — and sums
`amount - COALESCE(refunded_amount, 0)` instead of `amount`. Integer minor units throughout, never a
division. Two details it has to get right, both proven against real Postgres: `refunded_amount` is
`NULL` on every row written before the column existed and `amount - NULL` is `NULL` in SQL, which
`SUM` spreads across the whole window — so one legacy row would report zero net revenue for an
install that took a million; and a `BIGINT` sum arrives from node-postgres as a **string**, so it is
consumed through `Number` like every other amount in the store. On an install whose table predates
the column, `netRevenue()` answers exactly what `revenue()` does, because no refund was ever
recorded to subtract.

**`billingOverview` now returns two money metrics**, `revenue` (label `Revenue, gross (cents)`) and
`net_revenue` (label `Revenue, net of refunds (cents)`). The `revenue` key keeps its key, its
position and its value; only its label gained the word "gross". If you render the metric list by
key, add `net_revenue` to whatever you treat as money — a money metric rendered as a plain count is
the figure wrong by 100×.

**The console shows both**, as **Revenue (gross)** ("Paid payments settled in this window. Refunds
NOT subtracted.") and **Revenue (net)** ("The same payments, minus what was refunded. This is what
you kept."), each labelled in words so neither can be read as the other.

Nothing else that reports money inherited the blindness: `billingHealth` and `payments:sync` report
counts, not amounts, and the payments list and per-payment view already showed `refundedAmount`
beside the charge. `meteredBill`'s `total` is a projected overage charge rather than settled
revenue, so refunds do not apply to it.
