---
'@adonis-agora/payments': patch
---

`node ace add` now registers the webhook-handlers Assembler hook itself, so nothing has to be added
to `adonisrc.ts` by hand.

The docs also overstated what that hook does. Discovery of `app/payment_handlers/` has always worked
without it — the provider falls back to scanning the folder at boot — so a handler scaffolded with
`make:webhook-handler` was already picked up. The hook generates a build-time barrel that removes the
scan; it is an optimization, not a requirement, and the pages that presented it as a required step
now say so.

Also documents the worker that `dispatcher: 'durable'` and `'queue'` depend on (`durable:work` /
`queue:listen`) — without it webhooks are accepted and enqueued but never processed, while the
endpoint keeps answering `200`.
