---
'@adonis-agora/payments': minor
---

**New gateway: PayPal** — `payments.paypal({ clientId, clientSecret, currency, sandbox, webhookId })`.
Orders v2 for money in, Payments v2 for refunds, Subscriptions v1 for recurring billing, over OAuth2
client credentials. Plain REST, no SDK, no new peer dependency.

Multi-currency, so `currency` is required with no default, like Stripe's. Amounts go out as the
decimal string PayPal wants with the decimal places that currency allows — `"19.90"` for USD,
`"1990"` for JPY. HUF and TWD are refused when the amount is not a whole unit: PayPal rejects
decimals for both even though ISO 4217 gives them two minor units. The OAuth token is cached for
exactly as long as PayPal's own `expires_in` says and no longer, so a long-running process cannot
hold a token past its life and start 401ing an hour into a deploy.

**PayPal is a wallet, so `charge()` refuses more than it accepts.** A payment normally needs the
payer to approve it on paypal.com, which no server call can stand in for: `createCheckout` is the
entry point and returns the approval URL. `charge()` works only against an already-vaulted payment
method (`paymentMethodId` = a Vault v3 token id) and throws otherwise, rather than fake a payment
nobody approved. It also requires an `idempotencyKey` — it becomes the `PayPal-Request-Id` header
PayPal documents as mandatory there, and generating one internally would defeat the point.

**Webhook verification is an API call.** PayPal has no local HMAC: you POST the headers and the event
to `/v1/notifications/verify-webhook-signature`, so every webhook the mounted route handles costs a
round trip to PayPal, plus an OAuth call whenever the cached token has expired. Worth knowing before
pointing a high-volume webhook at it. With no `webhookId` configured there is nothing to verify
against and the event is parsed unverified, the same rule the other drivers use.

`externalReference` maps to `custom_id` (not `reference_id`, which does not survive onto the capture)
and is read back out of `custom_id` on `PAYMENT.CAPTURE.*` events and `custom` on the
`PAYMENT.SALE.*` events a subscription's charges arrive as.

**What else it refuses**: the customer methods (PayPal has no customer resource — the id is one you
choose, created as a side effect of vaulting); `listInvoices` (no customer filter exists);
`createSubscription` with `amount`/`cycle`/`trialDays` (all three live on the PayPal plan, so
accepting them would report a price the gateway never charges); `cancelSubscription({ atPeriodEnd })`;
and a subscription `description`. `updateSubscription({ amount })` does reprice at the gateway, and
reads the subscription first so it patches the REGULAR billing cycle rather than a plan's trial.

Written against PayPal's published API reference and covered by unit tests; it has not been run
against a live PayPal account. Verify in sandbox before taking real money.
