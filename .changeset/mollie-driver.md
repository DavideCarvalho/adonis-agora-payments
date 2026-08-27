---
'@adonis-agora/payments': minor
---

Add a Mollie driver — `payments.mollie({ apiKey, currency })`, on Mollie's v2 REST API with no SDK
dependency.

Cards and a hosted checkout page in any currency, native subscriptions, and refunds:
`supportedMethods` is `credit_card` and `undefined`, `capabilities` is
`{ refunds: true, invoices: false, subscriptions: true }`. `currency` is required — Mollie settles
in whatever you hand it, so a default here would be a guess at the app's country, and the wrong
guess still takes money. Mollie's money is a decimal string in the currency's own scale (`"19.90"`
for EUR, `"1990"` for JPY, `"1.990"` for KWD); the conversion happens only at the HTTP boundary,
through `formatDecimal`/`fromDecimal`.

**The webhook is a bare id, and the fetch is what authenticates it.** Mollie POSTs
`id=tr_5B8cwPMGnU6qLbRvo7qEZo`, form-encoded, unsigned, with no status — deliberately, so a forged
call cannot make you think a payment succeeded. `parseWebhook` reads the id, fetches the payment
with your API key, and builds the event entirely from what that authenticated call returned; nothing
in the request body is trusted beyond the id. It returns a promise, which the driver contract allows
and the mounted `/payments/webhook/:provider` route awaits, so Mollie webhooks mark payments paid
through the normal route with no extra wiring. A failed fetch **throws**: the route answers 400 and
Mollie retries, which is the right outcome for a payment nobody could confirm. Event ids are
`mollie:<paymentId>:<status>`, stable per transition, so a redelivery dedupes while the next status
still gets through. Set `webhookSecret` and the driver also verifies Mollie's next-gen
`X-Mollie-Signature` (HMAC-SHA256 hex over the raw body) fail-closed, before fetching anything — a
signature proves who sent the event, not what the payment is worth.

**`supportedMethods` is short because the shared union has no room.** `PaymentMethodName` is
`pix | credit_card | debit_card | boleto | undefined`, so iDEAL, Bancontact, SEPA Direct Debit,
PayPal, Klarna, Apple Pay, EPS, Przelewy24, BLIK, TWINT and the rest of Mollie's catalogue cannot be
declared or routed by name. They still work — omit `method` and Mollie's hosted page offers whatever
the profile has enabled, which is what `'undefined'` means. `debit_card` is absent for the same
reason: Mollie has no debit-only method to ask for.

`idempotencyKey` is sent as Mollie's `Idempotency-Key` request header on `charge` and
`createCheckout` — the only thing Mollie deduplicates on. It is not copied into `metadata`, where it
would be echoed back and protect nothing.

**What it refuses, rather than reporting a success Mollie never performed:**
`split` (Mollie Connect routes
are absolute amounts against organization ids); `trialDays` on a subscription (Mollie has no trial —
pass `startDate`); `planId`/`trialDays` on a checkout; a charge with no redirect URL; a `method`
Mollie has no id for; and `listInvoices`, because Mollie's Invoices API returns the monthly invoices
Mollie issues to *you* for its fees, not documents you issue to your customers.

Every Mollie subscription endpoint is nested under a customer while the driver contract passes only
the subscription id, so `cancelSubscription`/`updateSubscription`/`findSubscription` resolve the
customer from the subscription they created, or from Mollie's account-wide list — and throw rather
than guess when neither finds it. Pass `"cst_xxx/sub_xxx"` to skip the lookup.

Written against Mollie's published v2 API reference and covered by unit tests; it has not been
exercised against a live Mollie account. Verify in sandbox (a `test_` key) before taking real money.
