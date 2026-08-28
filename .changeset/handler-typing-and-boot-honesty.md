---
'@adonis-agora/payments': minor
---

Eight things an application integration found, all of them silent: typed webhook handlers, a boot
refusal for the wirings that could never work, lazy service accessors, and a testing surface that
does not need a cast.

**1. `event.data` is typed by the event type.** `WebhookEvent<T = unknown>` plus
`WebhookHandler = (event: WebhookEvent) => …` forced every handler to open with
`const data = event.data as PaymentWebhookData` — and on `payment.disputed` that cast was simply
wrong, because a dispute carries a `DisputeWebhookData` whose `amount` and `currency` are optional
(a Stripe early fraud warning has neither). New `WebhookEventDataMap` pairs each canonical type with
its payload, and `defineWebhookHandler('payment.disputed', (event) => …)` infers it, so reading a
payment field off a dispute is a compile error. The returned value is callable *and* carries
`type`/`handle`, so one definition works as a `billing.handlers` entry and as an
`app/payment_handlers/` default export. A passthrough type keeps `data: unknown` — nothing
normalized it, and pretending otherwise is the same lie one level down. `make:webhook-handler` now
generates `WebhookEventFor<'…'>` and no cast.

**2. A typo in `eventType` no longer boots.** `normalizeWebhookHandlerModule` accepted any string,
the provider did `handlers[type] = …`, and the processor skipped a lookup miss — so
`'payment.suceeded'` registered a handler nothing ever called, the ledger recorded the delivery as
**processed**, the route answered 200 (telling the gateway never to send it again), and the grant
never happened. `WEBHOOK_EVENT_TYPES` and `WebhookEventType` are now exported (they existed and were
not, so apps typed the key as a bare string), and the provider refuses at boot on an unknown type —
and on two handlers claiming the same type, which used to overwrite in silence. The rule is
namespace-based and stated in the error: `payment.*`/`subscription.*` is the library's namespace, so
a type there must be canonical; a gateway event a driver could not map arrives lowercased as the
gateway spells it (`payment_anticipated`) and is accepted as-is. `billing.passthroughEvents` covers
the rare gateway that spells one with a dot.

**3. Lazy service accessors.** `getPayments()` throws until the provider's `booted()` hook runs, and
providers registered earlier boot first — durable constructs workflow services before payments has
set anything — so resolving in a constructor throws. `lazyPayments()`, `lazyBillingStore()` and
`lazyPaymentsDriver(methodOrName?)` resolve on first property access, so `#payments = lazyPayments()`
in a field initializer is safe. `getPayments()`/`getBillingStore()` keep the eager throw.

**4. `@adonis-agora/payments/testing` can build a manager.** It exported the fake driver and no way
to wrap it, so apps wrote `setPayments({ driver: () => fake } as never)` — a cast that erased the
fact the stand-in has no `invoice()` and no `assertCapability()`. New `fakePayments(driver?)` returns
a real `PaymentsManager`; `swapPayments(manager)` / `swapBillingStore(store)` return a restore that
works when nothing was set, which the hand-rolled save/restore could not express.

**5. Webhooks can be awaited in tests.** In durable mode `dispatchAll` resolves when the event is
**accepted**, not processed, so every app pairing `billing.dispatcher` with durable wrote the same
polling `waitFor` — and had to write its negative assertions as timed sleeps.
`dispatcher.flushWebhooks()` (and `flushWebhooks()` from `./testing`) resolves when the accepted work
has actually run, background in-process retries included, and throws instead of hanging when the
events belong to a separate worker process.

**6. `truncateBillingTables(db)`, and `dropBillingTables` invalidates the store's memo.**
`LucidBillingStore` caches schema creation in `#schemaReady`, so an app that dropped the tables
between test groups left the store certain they still existed and every following query failed on a
missing relation. The drop now tells live stores to forget; the new truncate empties the rows, which
is what a suite actually needs — without it one test's webhook ledger deduplicates the next test's
event, the library's idempotency working against the suite.

**7. `driver()` no longer ignores `config.methods`.** `#resolveName` returned `{ name: default }`
with no method, so the routing map was never consulted and the driver came back unbound — the same
failure the manager's own comment names one branch down: *a charge routed as Pix could come back a
card*. Now: exactly one method routed to the default provider is bound; several is ambiguous and the
`charge`/`createSubscription` is refused, naming the two ways to say what you meant (so an app that
already passes `method:` everywhere is unaffected); and a method the map routes to a **different**
provider is refused rather than sent to the wrong gateway.

**8. A driver with an empty webhook-credential slot no longer boots.** `if (this.#webhookToken !==
undefined)` meant a driver with nothing configured verified nothing, and the mounted
`POST /payments/webhook/:provider` accepted any body — including one that marks a payment paid. Every
driver now declares `webhookVerification` (`'configured'` / `'unconfigured'` / `'unsupported'` — Efí
and InfinitePay sign nothing at all), and the provider refuses to boot on an unconfigured one, the
way the dashboard already refuses a missing session secret. `allowUnverifiedWebhooks: ['efi']` is the
explicit opt-out for an app that terminates verification upstream.
