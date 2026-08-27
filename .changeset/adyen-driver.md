---
'@adonis-agora/payments': minor
---

Add an Adyen driver — `payments.adyen({ apiKey, merchantAccount, currency })`, on Adyen's Checkout
API v71 over REST with no SDK dependency.

Stored-token card charges (`paymentMethod.type: 'scheme'`), Pay by Link for hosted checkout, and
refunds: `supportedMethods` is `credit_card` and `undefined`, `capabilities` is
`{ refunds: true, invoices: false, subscriptions: false }`. The API key travels as `X-API-Key`;
`currency` and `merchantAccount` are both required and checked at boot. Live traffic goes to a
per-customer host (`https://{prefix}-checkout-live.adyenpayments.com/checkout/v71`), so booting live
without `liveUrlPrefix` fails at boot rather than as a DNS error on the first charge. Adyen's money
is already an integer in the currency's minor units, so nothing is converted in either direction.

`externalReference` is **required** on `charge` and `createCheckout`: it becomes Adyen's `reference`,
which every webhook echoes as `merchantReference` — the routing key, and one of the eight fields the
HMAC covers.

**Webhook verification is pinned to Adyen's own test vector.** The signature is HMAC-SHA256, base64,
over `pspReference:originalReference:merchantAccountCode:merchantReference:amount.value:amount.currency:eventCode:success`
under the **hex-decoded** Customer Area key, and it arrives in `additionalData.hmacSignature`. Two
things are easy to get subtly wrong and both are covered by tests: signing with the key's characters
instead of its bytes, and escaping `:` as `\:`. The escaping rule belongs to Adyen's classic
HPP/dictionary signature — Adyen's own Node, PHP, Java and Python libraries all join the eight
webhook fields unescaped, and so does this driver, so a `merchantReference` containing a colon
verifies instead of being rejected as a forgery. Set `hmacKey` and verification is mandatory; leave
it unset and it is skipped, so local development works without Customer Area setup.

Adyen batches notifications in a `notificationItems` array while `parseWebhook` returns one event.
JSON/HTTP POST webhooks send one item per request, but if more arrive the driver **throws** instead
of handling the first and silently dropping a capture or a refund. Note also that Adyen's docs ask
for a `200` whose body is `[accepted]`, while the package's mounted `/payments/webhook/:provider`
route answers `200 {"received": true}` — current Adyen docs accept any `2xx`, but mount your own
route if your account requires the literal body.

**What it refuses, because Adyen has no endpoint behind it:** every customer operation (Adyen has no
customer resource — `shopperReference` is a string you invent); `findPayment` (Checkout v71 has no
read-back by `pspReference`); `refund` with no amount (Adyen requires one and the payment cannot be
read back to infer a full refund); all four subscription methods (Adyen has no subscription
resource — recurring billing is you charging a stored token on your own schedule); `listInvoices`; a
charge with no payment method; and `split`, which Adyen expresses as absolute amounts against
balance accounts.

`idempotencyKey` is sent as Adyen's `Idempotency-Key` request header on `charge` and
`createCheckout` — the only thing Adyen deduplicates on, and it never echoes the key back on the
response.

One documented ambiguity: `resultCode: 'Authorised'` maps to `paid` because Adyen captures
automatically by default, but on a manual-capture account it means only that the funds are held. The
API reference does not expose which mode an account is in, so the driver cannot tell — treat `paid`
from `charge()` as "authorised" and let the `CAPTURE` webhook be settlement.

Written against Adyen's published Checkout v71 reference and covered by unit tests; it has not been
exercised against a live Adyen account. Verify against `checkout-test.adyen.com` before taking real
money.
