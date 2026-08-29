---
'@adonis-agora/payments': minor
---

**PagBank (PagSeguro)** driver — the Orders API v4 (`api.pagseguro.com/orders`), Bearer
token, Pix, credit and debit card, and boleto. BRL-only, so like the other Brazilian
gateways it takes no `currency` option; there is nothing to choose.

```ts
providers: {
  pagbank: payments.pagbank({
    token: env.get('PAGBANK_TOKEN'),
    notificationUrls: [`${env.get('APP_URL')}/payments/webhook/pagbank`],
  }),
}
```

Money is **integer centavos on both sides**. PagBank's `amount.value` is already the
currency's smallest unit, so unlike the Asaas and Woovi drivers this one converts nothing —
`1990` in your code is `1990` on the wire. Pix uses PagBank's current flow, where the charge
carries `payment_method.type: 'PIX'` and the BR Code comes back on `charges[].qr_code.text`;
the older order-level `qr_codes` shape is still read when one arrives.

**Which id it reconciles on.** PagBank gives the same money an order id (`ORDE_…`) and a
charge id (`CHAR_…`), and the webhook delivers the *order*. The driver therefore uses the
order id as `gatewayId` everywhere — keying on the charge id would file the charge you
created and the webhook confirming it under two different ids, and nothing would reconcile.
`refund()` and `findPayment()` take either id and resolve the other themselves.
`externalReference` is the order's `reference_id`, echoed on every notification, and
`idempotencyKey` goes out as the `x-idempotency-key` header PagBank honours for 48 hours.

**The webhook check is stated plainly rather than implied.** PagBank's `x-authenticity-token`
is `sha256("<your API token>-<raw body>")`. The driver verifies it timing-safe on every
notification and rejects anything missing, wrong, or computed over altered bytes — but it is
**not an HMAC**. It is a secret prefix hashed with SHA-256, the textbook setup for a
length-extension forgery (what saves it in practice is that the forged body carries binary
padding in the middle, which `JSON.parse` refuses), and the secret is the API credential
itself, so rotating one rotates the other. The provider page says so in as many words.
`verifyWebhooks: false` exists for exactly one reason — PagBank's sandbox does not always
send the header — and it leaves the endpoint open to anything that can reach it.

**What it refuses,** loudly, with a `[payments]` message naming what to use instead:
subscriptions (that is PagBank's separate Assinaturas API), every customer operation (the
Orders API has no customer resource — the payer travels inline, and `customer: { name,
email, taxId }` is required on every charge), and the legacy form-encoded
`notificationCode` notifications, which are a different API with no authenticity token at
all. `listInvoices` returns `[]`: orders are indexed by their own id, not by customer.

Written against PagBank's published API reference and covered by unit tests; **it has never
talked to a live PagBank account.** Verify in the sandbox before taking real money.
