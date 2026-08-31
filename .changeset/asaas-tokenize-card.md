---
'@adonis-agora/payments': minor
---

Add `tokenizeCard` to the driver contract, implemented for Asaas.

Asaas has no browser-side tokenization — no publishable key, so its
`POST /creditCard/tokenizeCreditCard` authenticates with the account API key and the card
number necessarily reaches the server. The contract accepted a card that was already
tokenized (`CardInput.token`) and offered no way to obtain one, so every application built
a transparent checkout by hand-rolling the same authenticated POST. One of them wrote it
against `/creditCard/tokenize`, a path that does not exist: the endpoint 404s and every
card checkout fails as "invalid card".

- `PaymentsDriver.tokenizeCard?(input)` — optional, gated by the new
  `capabilities.cardTokenization`. A gateway that tokenizes in the browser (Stripe,
  Mercado Pago) or is a merchant of record (Polar, Dodo) declares it `false` and omits the
  method rather than inventing an endpoint.
- New types `TokenizeCardInput` and `TokenizedCard` (`{ token, last4, brand, provider }`).
- The Asaas provider docs claimed the card number "never touches your server". It does,
  for this gateway, and the page now says so along with the PCI consequence and the fact
  that tokenization needs activation on a production Asaas account.
