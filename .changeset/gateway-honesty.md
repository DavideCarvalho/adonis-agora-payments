---
'@adonis-agora/payments': minor
---

Three gateway calls that reported a success the gateway never performed now do the real thing, or
refuse.

**Stripe sends the idempotency key as a request header.** `idempotencyKey` was written into the
PaymentIntent's metadata, which Stripe does not deduplicate on — a retried charge created a second
PaymentIntent while the docs promised it could not. `charge` and `createCheckout` now pass it as the
SDK's `idempotencyKey` request option (the `Idempotency-Key` header), the two inputs that carry a
key. The metadata copy stays: Stripe never echoes the header back on the object, so it is the only
thing that lets `payment.payload` trace a charge to the key that created it.

**Stripe creates the payment method the charge asked for.** `charge()` never sent
`payment_method_types`, so a charge routed as Pix was created with whatever the account's dashboard
defaults are — while `supportedMethods` advertised `pix` and `boleto`. The charge's `method` now maps
onto the intent (`pix` → `pix`, `boleto` → `boleto`, `credit_card` → `card`), and a Pix or boleto
intent comes back with what the payer needs: `pixCode` (the BR Code) and `hostedUrl` (Stripe's
instructions or voucher page), read off `next_action`. A charge with no `method` still falls back to
Stripe's dynamic payment methods. Note that routing alone does not carry the method —
`payments.driver('pix')` picks the provider, `method: 'pix'` on the charge picks the method.

**Woovi refuses a subscription update instead of faking one.** `updateSubscription` fetched the
subscription, merged the new amount into a local copy and returned it, so the caller got back a
`Subscription` showing the new amount while OpenPix kept charging the old one. OpenPix subscriptions
are immutable — the API creates and reads them and nothing else — so the driver now throws a
`[payments]` error telling you to cancel and recreate, or to keep the change on your own record.
This is a behavior change for anyone who was calling it and believing the result.
