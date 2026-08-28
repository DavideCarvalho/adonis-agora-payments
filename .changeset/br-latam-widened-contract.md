---
'@adonis-agora/payments': minor
---

Adopt the widened payments contract in the Brazil/LatAm drivers — Asaas, AbacatePay,
Pagar.me, PagBank and Mercado Pago.

**Chargebacks stop being invisible.** `payment.disputed` is a canonical event now, and each
of these gateways gets its dispute-opening event mapped onto it: Asaas
`PAYMENT_CHARGEBACK_REQUESTED`, AbacatePay `checkout.disputed` / `transparent.disputed`,
Pagar.me `charge.chargedback`, and Mercado Pago's `topic_chargebacks_wh` topic plus the
`charged_back` / `in_mediation` payment statuses. Three of those were previously reported
as something else and were actively wrong: AbacatePay's disputes arrived as
`payment.failed` (a chargeback filed as a payment that never happened) and Mercado Pago's
as `payment.refunded` (indistinguishable from a refund the seller chose to make). The later
steps of a dispute stay `payment.updated`: the contract deliberately has no resolution
event, because no two gateways report one the same way.

**PagBank has no dispute event to map**, and its docs page now says so plainly. A PagBank
chargeback arrives only as a legacy form-encoded `notificationType=transaction`
notification (transaction status 9, "Retenção temporária"), resolved against the v3 XML API
with legacy credentials — a different API this driver does not speak, and refuses rather
than half-parses.

**`authorized` is told apart from paid and from pending** wherever the gateway separates
authorization from capture: Asaas `AUTHORIZED` (`authorizeOnly: true`), PagBank
`AUTHORIZED` ("pré-autorizada"), Mercado Pago `authorized` / `pending_capture`, and
Pagar.me — which has no `authorized` charge status at all, so the driver reads
`last_transaction.status === 'authorized_pending_capture'` behind a charge that still says
`pending`. Previously all of these collapsed into `pending`, understating a hold the issuer
had already granted.

**Mercado Pago's `paused` preapprovals** map to `paused` instead of `past_due`. Billing has
stopped and the subscription is alive; nothing failed, and it must not entitle the payer.

**Idempotency is honoured where the gateway documents it and refused where it does not.**
Mercado Pago's `refund()` now takes the caller's key instead of always generating one (the
random fallback stays for callers who pass none — a key derived from the payment id would
collapse two deliberate partial refunds into one). PagBank's `refund()` sends
`x-idempotency-key`. Pagar.me's `charge()` sends the `Idempotency-key` header its docs
specify for order creation, which is new — the key previously only doubled as the order
`code`. Everywhere else the key is **refused with a clear error** rather than accepted and
dropped: Asaas and AbacatePay document no idempotency mechanism at all, Pagar.me documents
one only for `POST /orders`, and Mercado Pago only for payments and refunds. Silently
dropping a key turns a caller's retry guarantee into a second refund.

**PagBank's `listInvoices` throws** instead of returning `[]`. `capabilities.invoices` is
false, the Orders API has no invoice resource, and `GET /orders` accepts only `charge_id` —
an empty array said "this customer has no invoices", which PagBank never told us.

No `supportedMethods` changed: pix, boleto and card are named categories already, and the
new `wallet` / `bank_transfer` / `bank_debit` / `upi` / `bnpl` / `voucher` entries describe
nothing these five gateways produce from `charge()`.
