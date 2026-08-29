---
'@adonis-agora/payments': minor
---

Mercado Pago now closes a dispute and carries its deadline; Pagar.me, PagBank and InfinitePay say
plainly what they cannot report.

**Mercado Pago — a chargeback that ends now ends in the ledger.** `charged_back` collapsed into
`payment.disputed` whatever `status_detail` said, so a dispute the seller *won* sat at `disputed`
forever — and `revenue()` sums rows that say `paid`, so it wrote off money that had come back.
`status_detail` is Mercado Pago's own outcome: `reimbursed` is *"decision in favor of the seller,
money refunded to the seller's account"* and now closes the dispute as **`won`** (which moves the row
back to `paid`); `settled` is *"decision against the seller, money withdrawn"* and closes it as
**`lost`**. `in_process` — and any detail the driver does not recognize — stays `payment.disputed`,
because an open dispute has no result to report. `in_mediation` is unchanged.

**The evidence deadline was there and unread.** It lives on the chargeback *case*, not on the
payment, so a `topic_chargebacks_wh` notification now also fetches `GET /v1/chargebacks/{data.id}`
and carries `date_documentation_deadline` as **`actionableUntil`**, the case's `reason`, and the case
id as `disputeId`. That second call fails soft: the money question is already answered by the
payment, and throwing would turn a chargeback the driver read correctly into a 400 and a redelivery.

Mercado Pago publishes no pre-dispute alert — the first thing you hear is the chargeback — so no
`payment.dispute_warning` is emitted, and `topic_claims_integration_wh` stays unmapped because its
`data.id` is a claim id with no payment beside it. Whether funds move when a chargeback opens or only
when it settles is not stated in the reference; the mapping was left where it was rather than
downgraded on a guess, and that is now written on the provider page.

**Pagar.me — `chargeback.received` is still not mapped, and now that is a documented decision.**
`charge.chargedback` is deprecated with a migration deadline of **2026-09-30**, and its replacement
exists in Pagar.me's event list with a one-sentence description and no published payload, no example
and no field list. Mapping it on the guess that `data` is a dispute object would file
`payment.disputed` against an id that may be the dispute's rather than the charge's. It now passes
through **untouched** instead of being run through the charge mapper, which was fabricating a
`{ gatewayId: '', amount: 0 }` for any handler registered on it. `charge.chargedback` →
`payment.disputed` is unchanged. Pagar.me's dispute lifecycle and its `responseDeadline` live in the
separate Disputes API, which is not on the driver contract — so there is no `actionableUntil` and no
`payment.dispute_closed` for this gateway, and the provider page says so.

**PagBank and InfinitePay have no dispute vocabulary to map.** PagBank's Orders API has no chargeback
status: a chargeback is the legacy form-encoded `notificationType=transaction` notification (status
9, "Retenção temporária"), a different API with different credentials that the driver already refuses
loudly. InfinitePay documents one webhook, fired only on approval, and no dispute resource at all —
contested sales are handled in the app, so the first you hear of one is the debit. Both are now
pinned by tests asserting no dispute type can be emitted, and stated on their provider pages rather
than left for the reader to discover.
