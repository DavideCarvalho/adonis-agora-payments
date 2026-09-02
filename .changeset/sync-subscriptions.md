---
'@adonis-agora/payments': minor
---

`payments:sync --subscriptions` — backfill and drift-correct subscription price, cycle and status.

A subscription's price only reaches the store when a `subscription.created`/`updated` delivery
carries it. Every subscription created before that shipped therefore has no `amount`/`cycle` on
its row, and recurring-revenue maths skips it until the gateway happens to send an update —
which for a healthy subscription nobody edits is never.

This is the backfill. Afterwards it is the drift correction: an amount changed in the gateway's
own dashboard produces no webhook on some gateways, and a reconcile is the only thing that
would notice.

Two kinds of row are skipped, for opposite reasons. **Managed** ones: the library owns that
recurrence, the gateway has never heard of it, and "correcting" it from a gateway answer would
overwrite the only authority there is. **Rows with no gateway id**: a free plan or an admin
courtesy, with nothing to ask about.

A subscription the gateway does not recognise is reported and left alone — never cancelled. A
rotated API key and a wrong environment both produce exactly that answer, and cancelling in bulk
from it would be worse than the problem this command solves.

The reconcile is exported as `reconcileSubscriptions(manager, store, { provider, log })`, so it
can be driven from a job or a test without an ace kernel.
