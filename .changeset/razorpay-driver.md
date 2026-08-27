---
'@adonis-agora/payments': minor
---

**New driver: Razorpay** (India's dominant gateway, v1 API) — `payments.razorpay()`.

**Not yet run against a live account.** It is written against Razorpay's published v1 API
reference and covered by unit tests that stub the HTTP layer; nothing in it has touched a real
Razorpay account. Verify your flow with `rzp_test_…` keys before taking real money.

Orders, payments, refunds, payment links, native subscriptions and invoices over
`https://api.razorpay.com/v1` via `fetch` (no SDK dependency). HTTP Basic auth with the key id
as username and the key secret as password; `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` are the env
fallbacks. There is no `sandbox` option, because test mode is a property of the key pair rather
than of a different host. Multi-currency, so `currency` is required and has no default.

```ts
providers: {
  razorpay: payments.razorpay({ currency: 'inr' }),
}
```

**Money stays in paise.** Razorpay's `amount` is already the integer minor unit, the same unit as
this library's `Money`, so the driver does no conversion at all — ₹1990.00 is `199000` on both
sides. The Brazilian drivers around it divide by 100 because their gateways want decimal reais;
doing that here would bill a hundredth of the charge, and Razorpay would accept it.

**`charge()` creates an order.** Razorpay has no server-side "charge this customer" call: you
create an order and the payer settles it in Razorpay Checkout. So `charge()` returns a `pending`
payment whose `gatewayId` is the `order_…` id you hand to Checkout, `findPayment()` accepts an
order, payment or payment-link id, and `refund()` accepts only a `pay_…` id. `idempotencyKey`
becomes the order's `receipt` (account-level unique, 40 characters).

**`externalReference`** rides in `notes.external_reference` on orders and subscriptions, and as
`reference_id` on payment links; `parseWebhook` looks for it on every entity the event carries,
because the API reference does not state that an order's notes are copied onto its payment.

**Webhooks** are a hex HMAC-SHA256 over the raw body in `X-Razorpay-Signature`, verified
timing-safe and rejected when missing or wrong; skipped only when no webhook secret is
configured, so local development works. `event.id` is Razorpay's `x-razorpay-event-id`.

Where it refuses instead of pretending:

- **`supportedMethods` is `['undefined']` only.** An order names no instrument, and UPI — the
  method most Indian payers use — has no member in this package's `PaymentMethodName` union.
  Mapping it onto `pix` because both are instant bank rails would put a Brazilian label on an
  Indian payment, so the driver declares nothing it cannot promise; routing `credit_card` to it
  fails at the manager and `charge({ method })` throws. Read `payment.method` off the webhook.
- **`authorized` maps to `pending`, not `paid`.** `BillingStatus` has no name for money that is
  held but not captured, and Razorpay voids an uncaptured authorization on its own. A
  `payment.authorized` webhook normalizes to `payment.updated`. `capturePayment()` (outside the
  driver contract) finishes the job for accounts with auto-capture off.
- **`createSubscription` refuses `amount`, `cycle`, `method` and `card`** — all four live on the
  plan or on Razorpay's hosted authorization link — and refuses a subscription with no
  `metadata.totalCount`, because Razorpay has no open-ended subscription and guessing the number
  of cycles would silently cap or over-run the customer's billing.
- **`updateSubscription` refuses `amount` and `description`.** Plans are immutable and a
  subscription has no description; it accepts a real plan swap or quantity change through
  `metadata`, sent with `schedule_change_at: 'now'` so the answer is not the old subscription.
- **`charge({ card | paymentMethodId })` and `charge({ split })` throw**, as does
  `createCheckout({ cancelUrl })` and `createCheckout({ planId })`.
