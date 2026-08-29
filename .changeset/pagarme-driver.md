---
'@adonis-agora/payments': minor
---

**New driver: Pagar.me** (Stone's Brazilian gateway, Core API v5) — `payments.pagarme()`.

**Not yet run against a live account.** It is written against Pagar.me's published v5 API reference
and covered by unit tests that stub the HTTP layer; nothing in it has touched a real Pagar.me
account. Verify your flow in test mode (an `sk_test_…` key) before taking real money.

Pix, boleto, credit and debit card, native subscriptions, payment links and marketplace splits,
over `https://api.pagar.me/core/v5` via `fetch` (no SDK dependency). Authenticated with HTTP
Basic: the secret key is the username and the password is empty. `PAGARME_SECRET_KEY` is the env
fallback; there is no sandbox host, because a `sk_test_…` key is what puts the account in test
mode.

```ts
providers: {
  pagarme: payments.pagarme({ secretKey: env.get('PAGARME_SECRET_KEY') }),
}
```

**Money stays in centavos.** Asaas, AbacatePay and Woovi take decimal reais, so those drivers
divide by 100 — Pagar.me's `amount` fields are already integer centavos, the same unit as this
library's `Money`, and the driver does no conversion at all. R$ 19,90 is `1990` on both sides,
including a `fixedValue` split share. Being BRL-only, it takes no `currency` option.

**A charge is an order carrying one payment.** `POST /orders` with a single `items[]` line and one
`payments[]` entry; the first charge the gateway creates is what comes back as the `Payment`, and
that `ch_…` id is what `findPayment` and the `charge.*` webhooks then talk about.
`externalReference` is sent as the order's `code` *and* as `metadata.external_reference` — order
metadata is repeated on every charge, which is what makes the reference survive into the webhook.
On a checkout it becomes the payment link's `order_code`, which Pagar.me stamps as the `code` of
every order the link produces; either way it comes back out on `event.data.externalReference`.

**Webhooks are authenticated by Basic credentials, or not at all.** Pagar.me signs nothing; the
dashboard offers optional HTTP Basic credentials on the webhook endpoint and no HMAC. Set
`webhookUser`/`webhookPassword` (or `PAGARME_WEBHOOK_USER`/`PAGARME_WEBHOOK_PASSWORD`) and the
driver rejects, timing-safe, any request that does not carry them.

Three places where the driver refuses instead of pretending:

- **`updateSubscription` throws.** A Pagar.me subscription has no amount or description of its own
  — the price lives on its *items*, changed through the subscription-item sub-resource. No request
  means what the contract's `{ amount, description }` means, so it refuses rather than returning a
  subscription the gateway never changed. Cancel and recreate, or edit the item.
- **`supportedMethods` excludes `'undefined'`.** An order must name its `payment_method`, so "let
  the customer choose" exists only on a payment link, never on a charge. A charge with no `method`
  is refused rather than left to the account's dashboard defaults.
- **A split rule naming both `percentualValue` and `fixedValue` throws.** A Pagar.me rule carries
  exactly one `type`, so there is no honest mapping for both.

`cancelSubscription` cancels immediately — there is no period-end flag in the API. `atPeriodEnd:
true` sends `cancel_pending_invoices: false`, which leaves the current cycle's already-issued
invoices payable; it does not keep the subscription running. `createCheckout` creates a payment
link and ignores `cancelUrl`, because a link has only `flow_settings.success_url`. Chargebacks
(`charge.chargedback`) normalize to `payment.updated`, since the contract has no dispute event —
`event.raw.type` still names the original.
