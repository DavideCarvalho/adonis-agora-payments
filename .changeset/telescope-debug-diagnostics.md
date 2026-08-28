---
'@adonis-agora/payments': minor
---

Telescope as a debugger, not a second dashboard: three new diagnostics that answer why one
payment behaved the way it did.

- **`gateway.request` / `gateway.request.failed`** — every call through the shared
  `httpRequest` transport now records provider, method, host, path, redacted query, HTTP
  status and duration, including the two outcomes that previously left no trace anywhere:
  a timeout and a non-2xx. Credentials are never recorded — headers are omitted entirely,
  credential-shaped query values are replaced with `[redacted]`, and the recorded error is
  built fresh rather than reusing the thrown one (which quotes the full URL). Request and
  response bodies are opt-in and off by default behind
  `configurePaymentsDiagnostics({ recordHttpBodies: true })`, because a charge body carries
  card and CPF data.
- **`webhook.verification`** — says whether a delivery's signature verified and under which
  scheme (`hmac-sha256`, `standard-webhooks`, `rsa-sha256`, `sha256-token-prefix`,
  `shared-token`), or that nothing verified it through the shared helpers, which is the
  usual answer to "why is my endpoint unauthenticated". Fed automatically by
  `webhook_security`'s primitives; `reportWebhookVerification()` is exported so a driver
  verifying inside its own SDK can report too.
- **Per-delivery correlation** — the webhook route opens an `AsyncLocalStorage` trace per
  delivery attempt, and every payments event published inside it is stamped with the same
  `traceId`, so received → verified → ledgered → handler → synced reads as one chain for
  one event. `PaymentsWatcher` surfaces it, preferring the envelope's own trace id.

`PaymentsWatcher` entries are now shaped rather than spread blindly: `event`, `traceId`,
then the fields you scan a timeline by, then the rest of the payload.
