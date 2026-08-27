---
'@adonis-agora/payments': minor
---

**Efí (formerly Gerencianet)** driver — the **Pix API** (`pix.api.efipay.com.br`) and only
that one. Efí's Cobranças API is a different product with different auth (boleto, card,
carnê, native subscriptions, no certificate); nothing there is reachable from this driver
and no flag switches it over. BRL-only, so no `currency` option.

```ts
providers: {
  efi: payments.efi({
    clientId: env.get('EFI_CLIENT_ID'),
    clientSecret: env.get('EFI_CLIENT_SECRET'),
    pixKey: env.get('EFI_PIX_KEY'),
    certificate: env.get('EFI_CERTIFICATE'),   // the .p12 from the Efí dashboard
  }),
}
```

**The certificate is the interesting part.** Efí requires mutual TLS on every request,
including the OAuth token request, and a client certificate belongs to the TLS handshake
rather than to a header — so it could not be configured the way every other gateway's key
is. `httpRequest` gained one optional `fetch` option, and the driver builds a
certificate-bearing `fetch` over `node:https` (which has accepted `pfx` forever) and passes
it through, keeping the shared error handling and adding **no new dependency**. Pass
`certificate` as a path or a Buffer, or pass your own `fetch` when a proxy holds the
certificate. Miss it and the driver refuses to boot — at boot, not at the first charge —
with the dashboard path and the config key in the message.

**The token cannot outlive itself.** The access token is cached against the `expires_in`
Efí actually returned, minus a minute of skew; concurrent charges share one token request
instead of racing to mint several, and a `401` drops the cache and retries once for the
token revoked before it expired. A cache with a lifetime of its own is how you get a driver
that works all afternoon and starts failing an hour into a deploy that stayed up — the
tests move the clock past the expiry and assert a second token is minted.

**The txid is the only reference Efí echoes.** Its notification carries `endToEndId`,
`txid`, `chave`, `valor`, `horario` and `infoPagador` — nothing else of yours. So an
`externalReference` that fits the txid charset (26–35 alphanumerics) is sent as the txid and
comes back as `event.data.externalReference`; one that does not fit is not mangled — Efí
generates the txid and you route on the returned `gatewayId`. Money crosses as a decimal
string built by shifting the integer's digits, never by dividing, so `1990` cannot leave as
`"19.89"`.

**Nothing authenticates the webhook inside the driver, and the docs say so** instead of
implying a guarantee. Efí's mechanisms are mutual TLS at your edge and an `hmac` **query
parameter** — and `parseWebhook` is handed the body and the headers, never the URL. The
provider page says where to enforce both. A batched notification (more than one Pix in the
array) is refused loudly with every txid named, rather than processing the first and
dropping money that has already arrived; the registration probe, which has no `pix` array,
is answered with an inert event so registering the webhook succeeds.

**What it refuses:** every subscription method (recurring Pix at Efí is either the Cobranças
API or Pix Automático, both different products), every customer operation (the payer is
inline on the charge), and any `method` other than `pix`. `listInvoices` returns `[]`.

Written against Efí's published Pix API reference and covered by unit tests; **it has never
presented a real certificate to a live Efí account.** Verify against homologation (`pix-h`)
with your own `.p12` before taking real money.
