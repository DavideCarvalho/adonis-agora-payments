# @adonis-agora/payments-react

React hook for [`@adonis-agora/payments`](https://www.npmjs.com/package/@adonis-agora/payments).

A Pix QR code (or a boleto) is not paid until the gateway's webhook confirms it, which lands
seconds to days later. This is the polling loop every app that takes Pix otherwise writes by
hand — with backoff, a stop condition, and no polling in a background tab.

```tsx
import { usePaymentStatus } from '@adonis-agora/payments-react'

function PixPanel({ reference }: { reference: string }) {
  const { status, isSettled, error } = usePaymentStatus(reference)

  if (error) return <p>{error.message}</p>
  if (isSettled && status === 'paid') return <p>Paid.</p>
  return <p>Waiting for the payment…</p>
}
```

It polls `GET /payments/client/status?reference=…`, mounted by
`@adonis-agora/payments/payments_client_provider` from `config/payments_client.ts` — an
opt-in endpoint that resolves the caller first and answers only for payments that caller
owns. Point `path` at your own route to poll a hand-rolled endpoint instead.

It does **not** wrap any gateway's card SDK: Stripe, Mercado Pago and Adyen ship their own.

Full documentation: <https://agora.goflip.ai/docs/payments/client>

MIT © Davi Carvalho
