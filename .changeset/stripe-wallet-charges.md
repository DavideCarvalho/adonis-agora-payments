---
'@adonis-agora/payments': minor
---

Google Pay (and Apple Pay) charges through Stripe, and managed cycles that actually charge.

**`ChargeInput` gains three fields**, all optional and ignored by gateways that have nothing
to say about them:

- `confirm` — confirm the charge in the call, instead of leaving the payer an intent to
  confirm. Stripe's `POST /payment_intents` without it only RESERVES the money
  (`requires_confirmation`, no webhook), so a caller that took the answer as paid recorded a
  subscription nobody paid for. Honoured only when the input names an instrument
  (`card.token` / `paymentMethodId`); otherwise the intent is created for the client to
  finish, which is the only way it can succeed.
- `offSession` — the charge happens with nobody present (a renewal). Sent with `confirm`,
  never alone: Stripe refuses an off-session confirmation that needs authentication, and
  that refusal is the correct answer.
- `setupFutureUsage` — vault the instrument, saying under which rules. A subscription's first
  charge sends `'off_session'`; without a vaulted credential the renewal has nothing to
  charge.

**`Payment.clientSecret`** carries what the BROWSER needs to finish a charge the server did
not settle (3DS, a wallet asking to authenticate). A `pending` payment with one is waiting
for the payer, not failing.

**`wallet` is now a Stripe method.** A device wallet is a `card` PaymentIntent there — the
browser returns a PaymentMethod and `payment_method_details.card.wallet.type` is what makes
it a wallet. `driver('wallet').charge({ card: { token: pm_… }, confirm: true })` charges it,
and `Payment.method` reads `wallet` off the resulting charge instead of reporting a typed
card. Gateways that take cards but no wallets (Asaas, Pagar.me, PagBank) keep refusing
`wallet`, rather than turning a Google Pay payload into an invalid card charge.

**Managed subscriptions charge their first cycle with `confirm: true` and, on every renewal,
`offSession: true`.** This is a real fix for Stripe and a no-op for the BR gateways, which
charge synchronously and have nothing to confirm.
