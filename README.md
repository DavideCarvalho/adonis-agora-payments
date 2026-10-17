# `@adonis-agora/payments`

[![npm version](https://img.shields.io/npm/v/@adonis-agora/payments)](https://www.npmjs.com/package/@adonis-agora/payments) [![npm downloads](https://img.shields.io/npm/dm/@adonis-agora/payments)](https://www.npmjs.com/package/@adonis-agora/payments) [![CI](https://github.com/DavideCarvalho/adonis-agora-payments/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/DavideCarvalho/adonis-agora-payments/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@adonis-agora/payments)](https://www.npmjs.com/package/@adonis-agora/payments)

> Payments and billing for **AdonisJS** — 18 gateways behind one driver contract, a
> Cashier-style subscription layer, idempotent webhook processing and invoice emission. Part of
> the [Agora](https://davidecarvalho.github.io/agora/) ecosystem.

**Gateways:** Asaas, AbacatePay, Woovi, Pagar.me, PagBank, Efí, InfinitePay, Mercado Pago ·
Stripe, Adyen, PayPal, Mollie, Razorpay, Square · Paddle, Lemon Squeezy, Polar, Dodo Payments.

## Install

```sh
node ace add @adonis-agora/payments
```

## Use

Configure gateways in `config/payments.ts` and route each payment method to one:

```ts
import env from '#start/env'
import { defineConfig, payments } from '@adonis-agora/payments'

export default defineConfig({
  default: 'asaas',
  providers: {
    asaas: payments.asaas({
      apiKey: env.get('PAYMENTS_ASAAS_KEY'),
      webhookToken: env.get('PAYMENTS_ASAAS_WEBHOOK_TOKEN'),
    }),
  },
  methods: { pix: 'asaas', credit_card: 'asaas' },
})
```

Then charge through the routed driver:

```ts
import { getPayments } from '@adonis-agora/payments/services/main'

const payments = getPayments()

const customer = await payments.driver('pix').createCustomer({
  name: 'Jane Doe',
  email: 'jane@example.com',
  taxId: '123.456.789-00',
})

const payment = await payments.driver('pix').charge({
  customerId: customer.id,
  amount: 1990, // integer cents: R$ 19,90
  externalReference: order.id, // your own row; comes back on every webhook for this charge
})

// payment.pixCode → the copy-paste BR code to show the customer
```

## Documentation

Gateways, webhooks, subscriptions and billing, invoices, testing and production notes:
**https://davidecarvalho.github.io/agora/docs/payments**

## License

MIT
