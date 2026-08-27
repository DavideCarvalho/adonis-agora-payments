---
'@adonis-agora/payments': minor
---

**New gateway: Mercado Pago** — `payments.mercadopago({ accessToken, currency, webhookSecret })`.
Pix, boleto and card through the Checkout API (`POST /v1/payments`), Checkout Pro preferences for
hosted checkout, and preapprovals for subscriptions. Plain REST, no SDK, no new peer dependency.

It is the first **multi-currency** driver after Stripe, and it takes `currency` the same way: as a
required option with no default. Mercado Pago runs seven country sites (BR, AR, MX, CL, CO, PE, UY)
and bills in whatever it is handed, so a default would be a guess at which one — and the wrong guess
charges instead of failing. `transaction_amount` crosses the boundary as a decimal, converted with
the currency in hand: `clp` has no cents, and dividing a Chilean amount by 100 bills 1% of it while
the gateway accepts it happily.

`idempotencyKey` goes out as the `X-Idempotency-Key` header Mercado Pago requires, not as a body
field. `externalReference` maps to `external_reference` on payments, preferences and preapprovals,
and the driver rejects a reference outside Mercado Pago's 64-character alphanumeric shape up front
instead of letting the gateway answer with an opaque 400.

**A Mercado Pago notification carries the id of the changed resource and nothing else** — no amount,
no status, no `external_reference`. So `parseWebhook` verifies the `x-signature` HMAC (over
`id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, read out of Mercado Pago's own SDK because the
docs page no longer publishes it) and then fetches the resource, returning the real event with its
status, amount and your `externalReference`. That fetch is one API call per notification, and a
failed one throws so the route answers 400 and Mercado Pago retries — reporting a status the gateway
did not confirm would be worse than a retry. `subscription_authorized_payment` is the exception: its
`/authorized_payments/{id}` shape is unverified against the reference, so it stays `payment.updated`
with the id rather than mapped from guessed field names.

**What it refuses**, rather than fake: `listInvoices` (Mercado Pago has no invoices for a customer —
`authorized_payments` are a subscription's charges, keyed by a different id space);
`cancelSubscription({ atPeriodEnd: true })` (a preapproval cancel is immediate and irreversible); a
subscription `startDate` with no end date (Mercado Pago silently ignores it); and a card charge with
no brand in `metadata.paymentMethodId`.

Written against Mercado Pago's published API reference and covered by unit tests; it has not been
run against a live Mercado Pago account. Verify in sandbox before taking real money.
