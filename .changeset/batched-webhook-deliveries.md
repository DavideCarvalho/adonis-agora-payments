---
'@adonis-agora/payments': minor
---

**A webhook delivery can carry more than one event, and now it is processed as one.**

Two gateways put a list in the delivery envelope — Adyen's `notificationItems` and Efí's
`pix` — while `parseWebhook` returned exactly one `WebhookEvent`. Both drivers refused a
batch loudly rather than processing the first and dropping the rest, which was the safe half
of the answer and lost every entry in the batch. The contract now carries what the envelope
carries.

**`PaymentsDriver.parseWebhook` returns `WebhookEvent | WebhookEvent[]`** (still optionally a
promise). This is a widening, not a migration: every other driver keeps returning a single
event and the union lets it. A driver whose gateway sends one event per request should keep
returning one — an array of length one adds nothing and reads as if batching were possible.
Only an implementation that *reads* the result needs updating; the mounted route accepts
either shape.

**Adyen verifies the HMAC per notification item.** Adyen's signature lives inside each item's
own `additionalData.hmacSignature` and nothing signs the envelope, so the driver verifies
*every* item before mapping *any* of them: verifying the first and trusting the rest is a
replay hole where an attacker appends whatever they like beside one genuine notification. One
bad signature rejects the whole delivery with `400`. Adyen documents that JSON and HTTP POST
webhooks carry a single item (only legacy SOAP batches, up to six), so in practice this stays
one event — the array is simply no longer truncated to its first entry.

**Efí returns one event per Pix**, each keyed on its own `endToEndId`. Efí's reference shows
one entry per notification and never states a maximum; the shape is a list either way.

**The mounted route loops, and every event gets its own ledger row.** Idempotency is keyed on
the gateway event id, so four events in one delivery are four rows, four
`webhook.received`/`processed`/`failed` triples on the diagnostics bus, and a redelivery
where three were already processed runs only the fourth. The whole delivery shares one
`traceId` — the trace answers "what happened to this HTTP request", and losing the fact that
these four arrived together would be the one thing a batch makes worth knowing. Each event's
`raw` is the envelope narrowed to its own item, so a ledger row can still say which
notification it is about and remains replayable by the dashboard.

**Behavior change: a delivery whose processing failed now answers `500`, not `200`.** When an
event throws, its siblings are still attempted — they are different payments, and refusing
them because a neighbour failed loses money for a reason unrelated to them — and the response
then reports the failure:

```json
{ "received": true, "processed": 3, "failed": ["evt_2"], "error": "..." }
```

A `2xx` promises the gateway it never has to send that delivery again, which over a failed
event is the payment lost for good. Previously the in-process dispatcher swallowed the error
and answered `200`, leaving the event to a background retry that dies with the process; the
gateway's own redelivery is the only durable retry there is, and it only starts on a non-2xx
(Adyen queues one for up to 30 days, Efí makes up to 9 attempts). Both retries now run, and
the ledger keeps that safe — whichever attempt claims the `failed` row first does the work
and the other short-circuits. **If you alert on 5xx from `/payments/webhook/:provider`, that
alert will now fire on a failing handler where it previously stayed silent.** A rejected
delivery — bad signature, unparsable body, unknown provider — is unchanged at `400`, since
redelivering it would fail identically.
