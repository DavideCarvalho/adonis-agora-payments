---
'@adonis-agora/payments': minor
---

The Brazil-first gateways get the dispute vocabulary — and for two of them the answer was that
their reference does not have one.

**Asaas closes a won dispute.** `PAYMENT_AWAITING_CHARGEBACK_REVERSAL` is documented as "Disputa
vencida, aguardando repasse da adquirente" — Asaas' own English wording is "Dispute won, awaiting
acquirer settlement" — and it was being flattened into a `payment.updated`, so a successful defense
reached nobody and the row stayed at `disputed` while the money was coming back. It is now a
**`payment.dispute_closed` with outcome `won`**, and the payment status map follows it:
`AWAITING_CHARGEBACK_REVERSAL` reads as `paid` rather than `disputed`, so `findPayment` and the
webhook stop describing the same gateway state two different ways. `PAYMENT_CHARGEBACK_DISPUTE`
stays a `payment.updated` — documents submitted is movement inside an open dispute, not a
resolution.

**Asaas' deadline was sitting unread.** The payment's `chargeback` object carries
`deadlineToSendDisputeDocuments`, the only response deadline Asaas publishes anywhere; it now comes
through as `actionableUntil`, with `chargeback.id` as `disputeId` and `chargeback.reason` as
`reason`. Every field is read defensively: Asaas' webhook reference points at the
`GET /payments/{id}` schema for the notification's payment object, where `chargeback` lives, but no
published example shows it — an absent one is an event without a deadline, never a malformed one.

`PAYMENT_CHARGEBACK_REQUESTED` **stays** `payment.disputed`. Asaas does not publish when the balance
is actually debited — its developer reference says nothing about the money, and its help centre
describes the debit as happening on a LOSS while also describing a win as the value *returning* to
the balance. The chargeback has been filed either way, so the mapping stands and the ambiguity is
written down on the docs page instead of guessed at. Asaas also sends no dispute-lost webhook and no
pre-chargeback warning of any kind; both absences are now documented and pinned by a test.

**Efí: a Pix cannot be charged back, but it can be taken back.** BACEN's MED (*Mecanismo Especial de
Devolução*) returns money to a payer who reported fraud, and it arrives on the Pix webhook this
driver already parses — as an ordinary `devolução`, distinguished from a refund you made only by its
`natureza`. The driver was calling it `payment.refunded`, which says the merchant chose to give the
money back: the one thing that did not happen. A `devolução` whose `natureza` is `MED_FRAUDE`,
`MED_OPERACIONAL` or `MED_PIX_AUTOMATICO` is now **`payment.disputed`** when it is `DEVOLVIDO` and
**`payment.dispute_warning`** while it is `EM_PROCESSAMENTO`; `NAO_REALIZADO` took nothing and stays
out of the dispute vocabulary, and `ORIGINAL`/`RETIRADA`/absent are still your refund. `findPayment`
agrees: a charge settled by a Pix that was MED-returned reads back as `disputed`. Efí sends no
notification when a MED is *opened* and its devolução object has no deadline field, so no
`actionableUntil` is invented.

**Woovi maps all four dispute events.** `OPENPIX:DISPUTE_CREATED` is a **`payment.dispute_warning`**,
not a `payment.disputed`: Woovi documents that the balance is *blocked* while a MED is analysed, and
a block is not a withdrawal. `DISPUTE_REJECTED` closes it as `won`, `DISPUTE_ACCEPTED` as `lost`,
`DISPUTE_CANCELED` as `canceled` — meanings that come from Woovi's help centre rather than its API
reference, which is said plainly on the docs page. A dispute payload names the Pix and nothing else,
so `gatewayId` on these events is the **`endToEndId`**, and `OPENPIX:CHARGE_COMPLETED` now carries
`metadata.endToEndId` so an app can store the link and join the two.

**Woovi also matched none of its own event names.** Real payloads are prefixed —
`OPENPIX:CHARGE_COMPLETED`, not `CHARGE_COMPLETED` — and the driver's map was written against the
bare names, so a live webhook fell through as an unrecognized event and the payment was ledgered
without ever being synced. Both spellings are accepted now.

**AbacatePay has no dispute vocabulary beyond "opened", and none was invented.** `checkout.disputed`
and `transparent.disputed` stay `payment.disputed`; its published event list has nothing before a
dispute and nothing after it, so there is no warning to map and no outcome to report, and its
reference says neither whether the funds are withdrawn nor what the deadline to respond is. The
driver says so in a comment, the docs page says so in a callout, and a test keeps a later edit from
inventing either event.
