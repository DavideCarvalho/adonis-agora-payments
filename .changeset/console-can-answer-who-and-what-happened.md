---
'@adonis-agora/payments': minor
'@adonis-agora/payments-dashboard': minor
---

Seven things a real operator could not see once money was flowing. Each was found by asking a
question of a running install and discovering the console had no way to answer it.

**"Did THIS student's payment land?" had no answer.** `listPayments` returned
`externalReference` — the app's own join key, the one id an operator actually holds — and the
dashboard's payments handler dropped it before serialising, so the screen showed the gateway's
`pay_…` instead. There was no lookup by reference or by gateway id anywhere: the handler filtered
on `status`/`provider`, and so did the client. `PaymentListQuery` now carries
`externalReference`, `gatewayId` and `customerId` (all EXACT — `order-4` must never return
`order-42`), `GET <dashboard>/api/payments` takes `?reference=` / `?gatewayId=` / `?customerId=`,
the row payload carries `externalReference` and `refundedAmount`, and the screen has one search
box that tries the app's reference first and the gateway id second, because an operator pasting
from a support ticket does not know which of the two they are holding.

**There was no customers endpoint at all**, though `billing_customers` has held
`owner_type`/`owner_id` — written by every app calling `ensureCustomer` — since the first
release. That mapping is the only thing tying a payment to a person: the payment row carries
`cus_…` and nothing else. `GET <dashboard>/api/customers` lists it with `ownerType`/`ownerId`/
`gatewayId`/`provider` filters, the store gained `listCustomersByGatewayIds` so a page of payments
resolves its owners in one read rather than one query per row, and every payment row now carries
an `owner`. A gateway customer nobody mapped reads as **unmapped**, not as a blank — it means
charges are landing that this console can never attribute.

**No per-payment view, and the ledger could not be filtered.** `BillingListQuery` had no event
`type`, so "did a refund event ever arrive?" was unaskable. It does now, and `GET /api/providers`
reports the event types an install has actually received so the filter is built from data rather
than from the twenty types the package can emit. `GET /api/payments/:gatewayId` assembles what IS
knowable about one charge: current state, owner, the disputes filed against it, the ledger rows
whose stored delivery names it, and who refunded it. **It is not a history, and it does not claim
to be** — `billing_payments` is a single mutable row upserted in place, so what it used to be is
recorded nowhere. The ledger strand is a `CAST(payload AS TEXT) LIKE` scan and says so on the wire
(`events.matchedBy`) and on screen: it is unindexed, it can over-match, and it cannot see a
delivery that never stored the id. No history table was invented. The honest fix is a
`payment_gateway_id` column the **processor** fills on the way in, which is a write path this
change does not touch.

**The dispute-deadline check was structurally dead on a real install.** `disputes_due` was the
only dispute check, and both reads behind it require `evidence_due_by IS NOT NULL` — a column that
can only ever be filled by a gateway that publishes a deadline. On Asaas it comes from
`chargeback.deadlineToSendDisputeDocuments`, which the driver's own comments note no published
webhook example even contains. So a chargeback could be open with the money already pulled back
and `payments:health` reported healthy. A new **`open_disputes`** check counts every unanswered
dispute (`warning`, `open`, `under_review`) with no deadline required and **no threshold that can
turn it off** — an open chargeback is money already out of the account, so there is no horizon at
which it stops mattering. `BillingHealth` gained `openDisputes` (oldest first, because with no
deadline, age is the only priority left) and the health panel names them.

**A lost Asaas dispute could never be closed, so the alarm stayed red forever.** Asaas publishes
no lost-dispute event and the driver hardcodes `outcome: 'won'` on close, so `billing_disputes`
sat at `open` indefinitely; `listDisputesDueWithin` counts past-deadline rows on purpose, so the
check stayed red and a fifteen-minute cron logged the same failure until nobody read it — burying
every other finding with it. `POST <dashboard>/api/disputes/:gatewayId/resolve` records how a
dispute ENDED: a finished status (`lost`/`won`/`expired`/`canceled`), an outcome, a note, and WHO
said so. It sends nothing to a gateway, and the dialog says so twice: the decision was made at the
bank, this writes down which way it went. There is still no "fight" and no "accept" — that is a
business rule and it stays in the app's code.

**A rejected delivery left no record and no check covered it.** A bad signature, an unparsable
body or an unknown provider is answered `400` with nothing written anywhere, so a rotated webhook
token was invisible: zero events, zero failures, every check green. `unconfirmed_payments`
eventually fires at 2 h, but only for charges the app itself created — refund, chargeback and
dispute-closure deliveries produce no pending payment and simply vanished. A new
`billing_audit_events` table records them, a **`rejected_deliveries`** check counts them over 24 h,
and `GET <dashboard>/api/audit` surfaces them. **The rejection itself happens in
`providers/payments_provider.ts`, which this change does not touch: the endpoint must call
`store.recordAuditEvent({ action: 'webhook.rejected', provider, message })` on each `400` path for
the check to see anything.** Until it does, the store, the check and the screen are in place and
the count is zero.

**And a refund issued from the console left no audit trail.** The only record was a diagnostic
carrying a gateway id, a provider and an amount — and no actor, even though the dashboard's own
`enforce()` had already verified exactly who authorised the request. `enforce()` now returns that
user, `Deps.actor` carries it per request, and a successful refund writes an audit row naming the
person, the amount asked for and whether it was partial. A refund the gateway REFUSED writes
nothing: an audit of refunds that never happened is an audit nobody can trust. A console with no
`dashboardAuth` records `actor: null` — "unattributed", never an invented "system".

`billing_audit_events` is a new TABLE, so it needs nothing from the schema module's post-ship
ALTER phase: `CREATE TABLE IF NOT EXISTS` carries it to an existing install exactly as well as to a
fresh one. An install that upgrades the package before running the migration keeps working — every
audit write is additional to an action that already happened, so a missing table skips the note and
answers `null` rather than failing a refund the gateway already accepted.

The console gained two screens (**Customers** and **Activity**) and a per-payment detail view.
1261 unit tests, 109 integration tests against real Postgres, 119 dashboard tests, typecheck and
lint clean. Every fix proven by mutation, including the JSONB cast — `jsonb LIKE text` is not an
operator in Postgres, and the in-memory store would have gone on passing without it.
