---
'@adonis-agora/payments': minor
---

**Chargebacks, held funds and retry keys in the five card-first gateways** — Stripe, Adyen,
Square, Razorpay and PayPal now use the words the shared contract grew, and refuse where a
gateway cannot keep the promise.

**Stripe's webhooks are normalized at all.** The driver passed `event.type` and the raw
Stripe object straight through, and the processor switches on the canonical names — so it
recognized *nothing* Stripe sent: every event was ledgered as processed and
`billing_payments` stayed empty. A chargeback cannot move a row that was never written, so
this is where the dispute work had to start. `payment_intent.*`, `charge.refunded`,
`charge.dispute.*`, `checkout.session.*` and `customer.subscription.*` now map onto the
canonical types; everything else still passes through under its Stripe name with the raw
object as `event.data`. **This is a behavior change for existing Stripe handlers**: one
registered on `'payment_intent.succeeded'` should now be registered on `'payment.succeeded'`.
A rename only happens when the canonical payload can actually be built — the built-in
handlers throw on a malformed payload, and a throw inside the webhook route is a 500 Stripe
retries forever.

**`payment.disputed` is mapped in all five.** Only the opening event, in every case; the
resolution — won, lost, funds withdrawn, evidence filed — stays `payment.updated`, because a
canonical type no driver emits is worse than none.

- **Stripe** — `charge.dispute.created`, keyed on the PaymentIntent (`payment_intent` is
  nullable on the Dispute object, so the charge id is the fallback).
- **Adyen** — `NOTIFICATION_OF_CHARGEBACK` **and** `CHARGEBACK`. Both, because an ACH return
  goes straight to `CHARGEBACK` with no notification and cannot be defended at all — mapping
  only the notification would miss exactly the disputes nobody can fight.
  `REQUEST_FOR_INFORMATION` and `NOTIFICATION_OF_FRAUD` deliberately stay updates: no money
  moves on either, and treating them as chargebacks would take a live payment away over a
  question.
- **Square** — `dispute.created`, keyed on `disputed_payment.payment_id` (nested, not a
  top-level field).
- **Razorpay** — `payment.dispute.created`, keyed on `dispute.payment_id` with the
  **disputed** amount, not the charged one.
- **PayPal** — `CUSTOMER.DISPUTE.CREATED` (and the deprecated `RISK.DISPUTE.CREATED`), keyed
  on `seller_transaction_id` — the capture id; `buyer_transaction_id` would find no row.

**`authorized` — funds held, money not moved.**

- **Stripe** `requires_capture` was falling through to **`failed`**: a live authorization
  reported as a dead payment. It is `authorized`, and `requires_confirmation` — which fell
  there with it — is `pending`.
- **Razorpay** `authorized` was `pending` by a documented decision, taken when nothing better
  existed. It is `authorized` now. The `payment.authorized` webhook stays `payment.updated`:
  there is no canonical authorized event, and settling on it would report an order the
  merchant has not been paid for.
- **Square** `APPROVED` was `pending` — the status of a payment nobody has attempted, for one
  whose money is reserved with a clock against it.
- **Adyen** gains a **`captureMode`** option, because `Authorised` means two different things
  and the Checkout API will not say which: `captureDelay` is a Management API field and both
  modes answer `/payments` identically. With `'automatic'` (the default, and Adyen's) the
  capture follows on its own and **no CAPTURE webhook is sent**, so `Authorised` is `paid`
  and `AUTHORISATION` is `payment.succeeded`. With `'manual'` it is `authorized`,
  `AUTHORISATION` is only an update, and `CAPTURE` is what settles it.
- **PayPal** creates `intent: 'CAPTURE'` orders, so it produces no held authorization of its
  own; `PAYMENT.AUTHORIZATION.CREATED`/`.VOIDED` are now recognized as updates carrying
  `status: 'authorized'` instead of falling through as unknown.

**`paused` no longer entitles anyone.** Stripe's `paused` mapped to **`active`**, which
granted access to a subscriber nobody is billing. Square's `PAUSED`, Razorpay's `paused` and
PayPal's `SUSPENDED` mapped to `past_due`, which said the subscriber owed money they did not.
All four say `paused`.

**Idempotency reaches the calls that grew a key — or throws.**

- **Stripe** sends `Idempotency-Key` on `refund`, `createCustomer`, `createSubscription` and
  `updateSubscription` as well as the two it already had. Stripe accepts it on every POST, so
  nothing here has to refuse.
- **Square**'s key is a body field, and `refund`, `createCustomer` and `createSubscription`
  were generating a UUID and dropping yours — which made Square's own retry safe and a
  retried **job** double-refund. `updateSubscription` **throws**: neither the PUT nor
  `swap-plan` takes one.
- **Adyen** sends `Idempotency-Key` on `refund` too, capped at the documented 64 characters.
- **PayPal** sends `PayPal-Request-Id` on `refund` and `createSubscription`; every site now
  goes through one guard capping the key at the 38 characters PayPal's own guidance names.
  `updateSubscription` **throws** — `PATCH /v1/billing/subscriptions/{id}` documents no such
  header.
- **Razorpay** has no general idempotency header at all. `refund` honours the one mechanism
  that exists — **`X-Refund-Idempotency`**, validated (≥10 chars, `[A-Za-z0-9_-]`) before the
  round trip, because a key Razorpay rejects is a key that does not deduplicate.
  `createCustomer`, `createSubscription` and `updateSubscription` **throw**: dropping a key
  there would turn a retry into a second customer, or a second live subscription billing the
  same person every month.

**Payment methods are named by category.**

- **Square** widens `supportedMethods` to `wallet`, `bank_debit` and `bnpl` alongside the
  card pair: the Web Payments SDK mints Cash App, ACH and Afterpay tokens, and they all reach
  `POST /v2/payments` through the same `source_id`. `source_type` maps to those categories
  instead of leaving everything but `CARD` unset.
- **PayPal** widens to `wallet`: `charge()` charges `payment_source.paypal.vault_id` and
  nothing else, which is a stored-balance wallet by definition. `createCheckout()` stays
  `undefined`. A charge routed as anything but the wallet now throws.
- **Razorpay** stays `['undefined']`, and the reason was never the missing `upi` name:
  **`POST /v1/orders` has no `method` field**, so `charge()` cannot produce a UPI payment on
  request — Checkout method restriction is a browser option. On the way back it is different,
  and `upi`, `wallet`, `bank_transfer` (netbanking) and `bnpl` (paylater, cardless EMI) are
  reported as themselves. A UPI payment used to come back unlabelled.
- **Stripe** and **Adyen** keep their `supportedMethods` — neither has a single API field for
  "a bank transfer", only iDEAL, Bancontact, EPS, P24, BLIK and a new one each quarter — but
  both now report the category on `Payment.method`. Adyen's was hardcoded to `card`, which
  labelled a SEPA mandate or an iDEAL transfer a card payment.
