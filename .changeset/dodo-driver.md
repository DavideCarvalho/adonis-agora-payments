---
'@adonis-agora/payments': minor
---

Add the Dodo Payments driver (`payments.dodo()`) — merchant-of-record billing for SaaS,
over the REST API with no SDK dependency.

Dodo is the legal seller of record: it registers for, calculates, files and remits sales
tax and VAT across 220+ regions, carries chargeback liability and PCI scope, and pays you
net. The library does not model any of that, but one consequence lands directly in the
driver: **there is no amount-only endpoint anywhere in the Dodo API.** Every charge names a
product you created in Dodo, and an arbitrary amount is honored only on a product with Pay
What You Want enabled. `charge()` therefore requires `metadata.productId`, and refuses
rather than guessing.

**Supports** cards worldwide and **Pix in Brazil** — the charge's `method` becomes
`allowed_payment_method_types`, which is the field that restricts the hosted checkout
(`pix` keeps the card methods as a fallback, because a checkout whose every listed method
is unavailable simply fails). **Boleto is not advertised**: it exists in Dodo's raw
processor-level enum but is absent from its supported-methods documentation. A Pix charge
returns `hostedUrl` and no `pixCode` — Dodo's API returns neither field; the payer gets the
QR on Dodo's page.

Also: customers, checkout sessions (`POST /checkouts`, the non-deprecated route),
subscriptions, full refunds, and payments-as-invoices with the PDF on `hostedPdfUrl`.
Amounts are integers in the currency's smallest unit throughout, so nothing is converted.
`currency` is required and is sent as Dodo's `billing_currency`.

**Refuses**, rather than reporting a change Dodo never made:

- `refund(paymentId, amount)` — a partial refund. Dodo's `POST /refunds` has no top-level
  amount; partial refunds are per line item and need the product id of the line, which this
  contract's single `amount` cannot address. A full refund works normally.
- `createSubscription({ amount | cycle })` — the recurring price and interval belong to the
  product.
- `createSubscription({ card })` — there is no tokenized-card input.
- `updateSubscription({ amount | description })` — a Dodo subscription has neither field. A
  plan switch goes through `metadata.productId` and `POST /subscriptions/{id}/change-plan`.
- `updateCustomer({ taxId })` — a Dodo customer has no tax id; it belongs to an individual
  B2B purchase.
- `charge()` with no `metadata.productId`, or with no billing country from
  `metadata.billingCountry` / `metadata.billing` / the driver's `billingCountry` option —
  Dodo requires a country on every payment.

`charge()` returns a **pending** payment: `POST /payments` hands back a payment link the
customer still has to pay on, and settlement arrives as a `payment.succeeded` webhook.
Cancelling is a `PATCH` either way — Dodo has no `DELETE /subscriptions/{id}` — and Dodo has
no `subscription.created` event, so `subscription.active` is what maps onto it.

Webhooks are verified against the Standard Webhooks scheme with a ±5 minute replay window.
The HMAC key is the secret with `whsec_` stripped and the rest **base64-decoded** — the
spec default, which Dodo's docs never state outright but its SDK's dependency on the
`standardwebhooks` reference library settles. Note this is the opposite of the Polar driver
added alongside it.

Written against the published API reference and covered by unit tests; **not yet exercised
against a live Dodo Payments account.** Verify in test mode before taking real money.
