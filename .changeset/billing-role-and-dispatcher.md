---
'@adonis-agora/payments': minor
---

`billing.role` splits the deployment into an api half and a worker half, and `billing.dispatcher` is
finally read.

`dispatcher` was declared in the config and **never consulted** — the provider resolved the backend
from the legacy `billing.durable` boolean alias only, which cannot express `'queue'` at all. So
`dispatcher: 'queue'` and `dispatcher: 'durable'` were silent no-ops. `dispatcher` is now read first,
with the alias kept as the fallback.

`billing.role` is `'all'` (default), `'api'` or `'worker'`. A `'worker'` process does not mount
`/payments/webhook/:provider` — it consumes what the api half enqueued. An `'api'` process skips
resolving app handlers, because they run on the worker.

Splitting requires a channel between the halves, so `'api'`/`'worker'` demand an explicit
`dispatcher` of `'durable'` or `'queue'`. `'in-process'` calls the processor inline and `'auto'` can
silently resolve to it, so both are refused at boot rather than producing a deployment where the api
half quietly processes everything and the worker sits idle.

`CheckoutSession` also now declares `pixCode`/`pixCopiaECola`. Three drivers were already writing the
field onto it; it only survived typecheck because a conditional spread bypasses the excess-property
check, so the value was undiscoverable from the type.
