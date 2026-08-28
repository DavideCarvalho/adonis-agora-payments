---
'@adonis-agora/payments': minor
---

Paddle, Lemon Squeezy, Polar, Dodo Payments, Mollie and Efí adopt the widened contract.
Four of the six were telling the billing layer something that was not true, and one of
those lies handed paying-customer entitlement to people who had stopped paying.

**Breaking: a paused subscription is now `paused`, not `active`.** Paddle, Lemon Squeezy,
Polar and Dodo all have a real paused state, and all four mapped it to `active` because
`SubscriptionStatus` had no other word. It does now. A paused subscription exists and will
bill again, but it is **not billing right now**, so reporting `active` granted access to
someone who is not paying. Anything gating on `subscription.status === 'active'` will start
refusing paused subscribers — that is the fix, not a regression. The gateway's own value is
still on `subscription.payload.status` if you were relying on the old behaviour deliberately.

**Chargebacks reach `payment.disputed`, where a gateway has one.**

- **Paddle** has no `dispute.*` event: a chargeback *is* an adjustment. `adjustment.created`
  with `action: 'chargeback'` — the only notification a Paddle seller gets that revenue was
  taken away — used to arrive as a bland `payment.updated`, leaving the stored payment
  saying `paid`. It is now `payment.disputed`, keyed by the transaction.
  `chargeback_warning`, `chargeback_reverse` and a later `adjustment.updated` stay
  `payment.updated`.
- **Dodo Payments** forwards the whole dispute lifecycle even though it bears the
  liability. `dispute.opened` → `payment.disputed`, keyed by the payment, with `disputeId`,
  `disputeStage` and `disputeStatus` on `event.data` (the amount is read as cents whether
  Dodo sends a number or a decimal string). `won`, `lost`, `challenged`, `accepted`,
  `cancelled` and `expired` → `payment.updated`.
- **Mollie** reports one two ways. On the classic webhook a chargeback re-fires the
  payment's `webhookUrl` with the same bare id and leaves `status` at `paid` — only
  `amountChargedBack` on the fetched payment says the bank pulled the money back, so the
  driver reads it and reports `payment.disputed`. On next-gen webhooks
  `chargeback.received` → `payment.disputed` and `chargeback.reversed` → `payment.updated`.
  A chargeback cannot be read back on its own (Mollie has no lookup by chargeback id), so
  an **id-only** next-gen chargeback event now throws and tells you to switch the webhook to
  the snapshot payload, rather than passing the money event through inert.
- **Polar, Lemon Squeezy and Efí genuinely have no dispute notification**, and the drivers
  do not invent one. For the two merchants of record that is the deal, not a gap: the
  chargeback is raised against them and they absorb it, fee and representment included —
  and it is a large part of why anyone picks an MoR. Efí is Pix, which has no chargeback at
  all. Each provider page says so.

**Mollie also fixes an event-id collision this uncovered.** Mollie's own `status` stays
`paid` through both a refund and a chargeback, so `mollie:<id>:<status>` produced an event
id byte-identical to the earlier `payment.succeeded` one — and the idempotency ledger
discarded the webhook that takes the money away as a replay. Those two transitions now get
a `:refunded` / `:chargeback` suffix.

**`authorized` where the gateway separates authorization from capture.** Mollie's
`authorized` payment status and Dodo's `requires_capture` both used to collapse into
`pending`, which understated a held authorization. Dodo's `partially_captured` and
`partially_captured_and_capturable` deliberately stay `pending`: part of the authorization
has already settled, so "nothing captured" would be as wrong as `paid`.

**Payment methods are categories now, and Mollie and Dodo can finally route them.**

- **Mollie** goes from `credit_card | undefined` to `credit_card`, `bank_transfer`,
  `bank_debit`, `wallet`, `bnpl`, `voucher`, `undefined`. iDEAL, Bancontact, SEPA Direct
  Debit, PayPal, Klarna, Apple Pay, EPS, Przelewy24, BLIK, TWINT, MB WAY, Multibanco,
  Trustly, paysafecard and vouchers were all unroutable; each now sits in a category, and a
  category goes out as Mollie's own `method` **array** — which is exactly what a category
  is, since `bank_transfer` is iDEAL in the Netherlands and Bancontact in Belgium. To pin
  one brand, name it in the gateway's own field: `metadata.mollieMethod: 'ideal'`, validated
  against the category. `payment.method` comes back as the category too. `debit_card` is
  still refused, and re-checking confirmed why: Mollie folds debit cards into the single
  `creditcard` id and has no debit-only method to ask for.
- **Dodo Payments** adds `upi`, `wallet`, `bank_transfer`, `bank_debit` and `bnpl` to
  `credit_card`, `debit_card` and `pix`, each mapping to the `allowed_payment_method_types`
  in it (plus the `credit`/`debit` fallbacks Dodo tells you to keep, because a checkout
  whose every listed method is unavailable simply fails). `payment.method` reports the
  category, so iDEAL/SEPA/Klarna/Apple Pay/UPI payments stop coming back `unknown`.
- **Paddle** cannot route (its transaction API takes no payment-method argument, so
  `supportedMethods` stays `undefined`), but it *reports*: `method_details.type` now maps
  onto `wallet` (PayPal, Apple/Google/Samsung Pay, Alipay, WeChat Pay, the Korean wallets),
  `bank_transfer` (iDEAL, Bancontact, BLIK, MB WAY, wire), `pix` and `upi`. Only `card` had
  a name before.

**`idempotencyKey` is honoured where it deduplicates and refused where it does not.**

- **Mollie** sends `Idempotency-Key` on every POST it makes — now including `refund`,
  `createCustomer` and `createSubscription`, not just `charge` and `createCheckout`.
  `updateSubscription` **throws**: Mollie accepts the header on POST only, and a `PATCH` is
  repeatable by nature, so accepting a key there promised a deduplication Mollie never
  performs.
- **Polar** sends `Idempotency-Key`, which it documents for POST, PATCH and DELETE, on
  `createCheckout`, `refund`, `createCustomer`, `createSubscription` and
  `updateSubscription`.
- **Efí** uses the key as the **devolução id** in `PUT /v2/pix/{e2eid}/devolucao/{id}` —
  the id *is* the deduplication on that API. BACEN allows 1–35 alphanumerics, so a key
  outside that charset throws instead of being silently replaced by a random id.
- **Paddle, Lemon Squeezy and Dodo Payments have no deduplication mechanism at all**, so
  every entry point that takes a key now **throws** instead of accepting and dropping it.
  Paddle's `createCheckout` and Dodo's `charge`/`createCheckout` were previously accepting
  a key and ignoring it, which turned a caller's retry guarantee into a second charge. This
  is a behaviour change for anyone passing a key to those three: catch it, and deduplicate
  on your side by persisting the key before you call.

**`listInvoices` throws on Efí** instead of answering `[]`. An empty list is
indistinguishable from "this customer has no invoices", which is the same silent shape as
the bugs above; `capabilities.invoices` is `false`, so `PaymentsManager.assertCapability`
already stops the documented path and the message is for whoever reaches the driver directly.
