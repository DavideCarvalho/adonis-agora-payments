---
'@adonis-agora/payments': patch
---

Woovi: read the charge out of the OpenPix envelope.

`POST /api/v1/charge` answers `{ charge: { globalID, brCode, paymentLinkUrl, ... },
correlationID, brCode }`, and `charge.get` returns the same envelope. The driver read the
envelope as if it were the charge, so `globalID` was never found — every Pix payment came back
with `gatewayId: ''` — and `brCode`, a **string** at both levels, was read as
`data.brCode.brCode`, an object access on a string, which is `undefined`.

The result was a Pix charge the caller could neither identify nor show to anyone: no gateway
id to reconcile against, no BR Code to render a QR from, no link to send. `createCheckout` had
the same bug and is fixed with it.

`paymentLinkUrl` now maps to `hostedUrl`. `qrCodeImage` deliberately does **not** map to
`pixQrCodeImage`: Woovi returns a URL and that field is documented as a base64 PNG to render
directly, so a URL there would produce a broken image in every consumer that followed the
docs. `pixCode` carries the BR Code, which a QR renders from client-side.
