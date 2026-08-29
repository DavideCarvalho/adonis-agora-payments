---
'@adonis-agora/payments': patch
---

Three regressions from this release's own changes

`config.methods` is written in terms of the KEYS under `config.providers`, and `driver()`
was handing the routing check the driver's own `provider` string instead. The two are the
same only by coincidence — `providers: { primary: payments.stripe(…) }` with
`methods: { credit_card: 'primary' }` made `driver('credit_card').charge(...)` refuse a
charge that was routed exactly right. Every existing routing test used a key equal to the
provider name, which is why nothing caught it. The bound-proxy cache is now keyed by
provider AND method for the same reason.

`payments:health` grew from four checks to six, and its own description, docblock and
plain-text output did not follow: it printed the disputes that carry a deadline and never
the ones that do not — on precisely the installs the new `open_disputes` check was added
for, since Asaas' published webhook examples never carry a deadline at all. The count fired
naming nobody. It now names them, the description matches, and `--rejected-window` exposes
the threshold `billingHealth` already accepted.

Mollie's CLASSIC webhook reported `'unconfigured'`, the state that refuses to boot. There
is no credential to configure on that flow and nothing insecure about not having one: the
request carries only `id=tr_xxx` and the driver authenticates by reading that payment back
with your API key. It is `'unsupported'` now, so the supported configuration boots — and
`allowUnverifiedWebhooks` is not needed for it, which matters because reaching for it would
also have silenced a genuinely missing next-gen secret.
