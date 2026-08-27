---
'@adonis-agora/payments': minor
---

**New driver: InfinitePay** (CloudWalk, Brazil) — `payments.infinitepay()`. **It does checkout
links and nothing else, because that is all InfinitePay documents.**

**Not yet run against a live account.** It is written against InfinitePay's published checkout
documentation and covered by unit tests that stub the HTTP layer; nothing in it has touched a real
InfinitePay account. Create a link, pay it, and confirm the `checkPayment()` step end to end before
taking real money.

InfinitePay's only currently documented developer API is the Checkout / Payment Link API: create a
link, redirect the payer, receive a per-link webhook when the payment is approved. There is no
documented server-side charge API, no refund endpoint, no customer resource, no subscription API,
and no list or search endpoint of any kind. So this driver implements `createCheckout`,
`parseWebhook` and a driver-specific `checkPayment()` — and **`charge()`, `refund()`,
`createCustomer()`, `findCustomer()`, `updateCustomer()`, `findPayment()`, `listInvoices()` and
every subscription method throw** a `[payments]` error naming the gap. They do not return an empty
result and they do not call an endpoint that is not there. (A v2 transactions API did exist and is
still referenced by CloudWalk's abandoned WooCommerce and Magento plugins, but its documentation
host is gone and its credentials were handed out by email; the driver deliberately does not build
on an archive.)

```ts
providers: {
  infinitepay: payments.infinitepay({
    handle: env.get('INFINITEPAY_HANDLE'),
    webhookUrl: env.get('INFINITEPAY_WEBHOOK_URL'),
  }),
}
```

**The credential is a `handle`, not a secret.** The checkout endpoint is public and takes no
credentials at all; the handle (your InfiniteTag) is what identifies the merchant. "Checkout
Integrado" must be enabled in the InfinitePay app first. Amounts are integer centavos on both
sides — no conversion — and being BRL-only it takes no `currency` option. `supportedMethods` is
`['pix', 'credit_card']`: what the hosted page settles with. **No boleto.**

**The webhook is unauthenticated, and the driver says so rather than implying otherwise.**
InfinitePay documents no signature, no HMAC and no shared token for the checkout webhook — its own
security advice is to re-check the payment instead. `parseWebhook` therefore verifies nothing: an
event out of it means *somebody claimed a payment happened*. Confirm it with `checkPayment()`
(`event.raw` carries the three ids it needs) before crediting anything, and put an unguessable
segment in the `webhookUrl` you configure. `webhook_url` is sent **per link** — there is no global
registration — so without `webhookUrl` no webhook ever arrives.

**`findPayment` throws; `checkPayment` replaces it.** `POST /payment_check` needs all three of
`order_nsu`, `transaction_nsu` and `slug`, and the last two only exist once the payment does. A
pending link is invisible to the API, so one id is not enough and the driver refuses instead of
guessing.

`createCheckout` returns the gateway's `url`; since the response carries no link id, the session's
`id`/`gatewayId` is the `order_nsu` the call sent — the only id the webhook and `checkPayment`
speak in, and therefore where `externalReference` goes. It is the one field InfinitePay echoes
back, and it returns on `event.data.externalReference`. `cancelUrl` is ignored (a link has one `redirect_url`), `planId`/`trialDays` are refused,
and `metadata.items` passing a real cart must add up to `amount` or the call throws.
