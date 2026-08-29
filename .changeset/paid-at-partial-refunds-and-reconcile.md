---
'@adonis-agora/payments': minor
---

Six ways the billing tables recorded the wrong amount of money — a won dispute vanishing from
revenue, a partial refund never recorded at all, and a reconcile that moved historic revenue into
the current month. Every one of them was silent.

**`savePayment` no longer erases `paid_at` on a write that omits it.** The column was written
unconditionally (`payment.paidAt ? ... : null`), while three of the processor's own handlers —
`payment.refunded`, `payment.disputed`, `payment.dispute_closed` — call it without one, because a
refund or dispute payload carries no settlement date. `revenue()` filters
`status = 'paid' AND paid_at >= from AND paid_at < to`, so a dispute closed as **won** restored
`status = 'paid'` with `paid_at = NULL` and the recovered money dropped out of every windowed
revenue figure, permanently — `paid_at` is the only record of when a charge landed. Absent now means
"not stated" and leaves the stored value alone, exactly like `externalReference`; pass `null` to
clear it. `refundedAmount` follows the same rule. **If you have run a dispute to a won close, or a
refund, on an earlier version, those rows have `paid_at = NULL` and are missing from your monthly
revenue** — `payments:sync` can repair them from the gateway, or set the column from
`billing_payments.payload` by hand.

**New column: `billing_payments.refunded_amount`** (integer minor units, same units as `amount`,
nullable). Added by `createBillingTables`' post-ship `ALTER` phase, so an existing install picks it
up on the next boot with no new migration; it is also on the read side, as
`PaymentListItem.refundedAmount`. Net revenue for a row is `amount - refunded_amount` — never a
division.

**`payment.updated` has a built-in sync.** It used to reach `default: return Promise.resolve()`, so
the ledger row went to `processed` and nothing happened. On Asaas that is where a **partial refund**
arrives (`PAYMENT_PARTIALLY_REFUNDED`) — deliberately, because `payment.refunded` writes the whole
charge off — along with a deleted charge, a restored one, a denied refund and an undone cash
receipt. It now keeps status, amount, refunded amount and settlement date current on a row that
already exists, and publishes the `payment.updated` diagnostic that was declared and published by
nothing. It never creates a row, and it never moves one out of `disputed`: only
`payment.dispute_closed`, which carries an outcome, resolves a chargeback. `PaymentWebhookData`
gains optional `status`, `paidAt` and `refundedAmount` for drivers that can normalize them; the
Asaas driver now does, summing only refunds Asaas reports as settled.

**`payment.succeeded` prefers the gateway's own settlement date** (`data.paidAt`) over the webhook's
arrival time, so a redelivered or replayed confirmation is still filed in the month it was earned.

**Asaas webhooks are deduplicated on Asaas' event id.** `parseWebhook` synthesized
`` `${event}-${paymentId}` ``, which is a (payment, event-type) identity rather than an event
identity — so the SECOND `PAYMENT_UPDATED` for a payment was silently discarded by the idempotency
ledger as a replay of the first, and a partial refund arrives as exactly that type. Its
`Math.random()` fallback also disabled deduplication entirely for any payload naming neither a
payment nor a subscription. The driver now reads the `id` Asaas sends on the notification body, and
falls back — only when there is none — to a SHA-256 digest of the raw body, which is deterministic:
a genuine redelivery still deduplicates, two different notifications no longer collide.

**Asaas `charge()` honours `idempotencyKey` instead of silently ignoring it.** Every other Asaas
method refuses the key loudly ("Asaas has no idempotency mechanism … deduplicate before you call,
e.g. by looking the record up by `externalReference` first"); `charge()` alone quietly repurposed it
as an `externalReference` fallback, so an app passing `idempotencyKey: order.id` on the one call
that moves money got no protection and no warning. The driver now performs that documented lookup
itself: with a key, it searches `GET /payments?externalReference=…&customer=…` first and returns the
existing charge — Pix code attached — instead of creating a second one. A deduplicated call emits no
fiscal invoice and publishes no `charge.created` diagnostic, because nothing was charged. It is one
request, not a lock: two concurrent calls with the same key can still both create.

**Asaas `listInvoices` pages.** It issued `GET /payments?customer=…` with no `limit`/`offset` and no
loop, while Asaas pages that endpoint — so `payments:sync` printed a confident "N invoice(s) synced"
covering only the newest page and left older charges unreconciled with no way to tell. It now
follows `hasMore` to the end, and throws rather than truncating if a gateway never stops.

**`payments:sync` reconciles in both directions, and stops inventing settlement dates.** It wrote
`status: 'paid'` and counted everything else as "skipped (non-paid)", so a local row saying `paid`
while the gateway said refunded or charged back could never be corrected — the exact drift a
gateway-is-truth reconcile exists for. It also stamped `paidAt: new Date()`, so running it in two
months counted the same charge in both. It now asks the gateway's payment resource (which speaks
`BillingStatus`, unlike `Invoice.status`, whose vocabulary has no `refunded`) and writes that status
in either direction, using the gateway's own settlement date or none at all, and never overwriting a
`paid_at` already recorded. **One local state is never overwritten from the gateway: `disputed`** —
the gateway's payment resource usually still reports a disputed charge as received, so reconciling it
back to `paid` would re-count money the bank has pulled back. Those rows are reported and left alone.
The per-customer output now reads `reconciled / already current / undecidable` rather than
`synced / skipped`.
