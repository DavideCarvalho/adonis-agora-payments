# The documentation sweep — shared brief

The library changed a great deal in one day and the docs have not caught up. Several agents are
sweeping different pages **in the same tree**, so the file ownership in your task is not advice.

Working directory: `/home/dudousxd/personal/oss/adonis/adonis-payments`. Do not switch branches, do
not create one, **do not commit**.

---

## 1. The one rule

**Verify every claim against the source, not against the page.** A docs page is the last place to
learn what the code does, and this repo has spent a day proving it: pages said the library shipped
four gateways when it shipped eighteen, that no dashboard existed when one did, that
`idempotencyKey` was absent from a contract that carried it on six methods. Every one of those read
plausibly. If a page states a default, a table name, a status, a flag or an event name, open the
file and check. If you cannot verify it, say so on the page rather than repeating it.

Read the recent commit messages (`git log --oneline -12` and the bodies) before you start. They are
written to explain *why*, and the why is usually the half a reader cannot reconstruct.

## 2. What changed today, in the order it will bite you

**The library creates its own tables.** `billing.autoCreateSchema` is on by default and there is no
migration to run. `configure` still publishes one file for apps that want to own the DDL — three
stubs collapsed into it. Any page telling a reader to run `node ace migration:run`, or naming
`add_billing_external_reference` / `add_billing_disputes`, is wrong. See `src/billing/schema.ts`.

**The dashboard mounts at `/payments`**, not `/payments-dashboard`, sharing the prefix with
`POST /payments/webhook/:provider` and `GET /payments/client/status`. Safe because every route it
registers is an exact path; a test asserts no wildcard.

**Disputes are a first-class thing now.** Three canonical events — `payment.dispute_warning`
(no money has moved), `payment.disputed` (withdrawn), `payment.dispute_closed` (carries `outcome`).
A `billing_disputes` table, a `payments:health` check for a window closing within 72h, a read-only
dashboard screen, and real evidence submission on Stripe. `DisputeEvidence` addresses documents by
what they prove rather than a bare list of ids. Sixteen drivers went through the vocabulary pass and
several genuinely have nothing — those pages say so, and that is correct, not a gap.

**A webhook delivery can carry several events**, and a delivery whose handler threw now answers
**500** rather than 200. That is a behavior change beyond batching: a 2xx tells the gateway never to
resend, which over a failed event is the payment lost. Anyone alerting on 5xx will see it fire.

**Routing threads the method.** `driver('pix')` returns the driver bound to `pix`, so a charge made
through it no longer needs `method: 'pix'` repeated.

**Money:** `toDecimal`/`fromDecimal`/`formatDecimal` take a currency, because the exponent is not
always 2 (JPY has none, KWD has three). Woovi works in centavos and no longer converts.

## 3. What good looks like here

The existing pages are the standard — read three or four before writing, including ones outside your
set. The voice is plain, technical, second person. Specifically:

- **Say what it does not do.** That is the half a reader cannot get from a gateway's own site, and
  it is why these pages are worth reading.
- **Explain the why, once, where it belongs.** "Grant on the webhook, not on `charge()`" is worth a
  paragraph because it is the most expensive mistake available in this domain. Do not repeat it on
  nine pages.
- **No marketing, no filler, no "simply".** If a sentence would survive being deleted, delete it.
- Code samples must be real. If you write one, check the symbol exists and the signature matches.

## 4. What NOT to do

- **Do not invent features.** If a page would be better with something the library does not have,
  that is a roadmap note in your report, not a paragraph.
- **Do not soften a limitation into a hint.** A gateway that sends no dispute deadline should say
  so plainly.
- **Do not restructure the sidebar.** `docs/meta.json` and `docs/providers/meta.json` are the
  orchestrator's — report a new page rather than wiring it yourself.
- **Do not touch `docs/roadmap.mdx`.** Also the orchestrator's; report what should change.
- Do not edit pages outside your set, or anything under `packages/`. If a page you own is wrong
  because the CODE is wrong, **report it — do not fix the code**. Two of today's worst bugs were
  found exactly that way.

## 5. Verify

```
pnpm --filter @adonis-agora/payments exec vitest run test/docs_types.spec.ts test/driver_registry.spec.ts
pnpm lint
```

Those two specs are drift gates over the docs: one compares the api-reference's domain unions and
the diagnostics event table against the source, the other requires every provider page to name its
`externalReference` and keeps the generated comparison table honest. If you break one, you changed
something you should not have.

Docs are `.mdx` — the components in use (`Callout`, `Steps`, `Card`, `Tabs`) must be imported at the
top of the file that uses them. Match the imports the existing pages use.

## 6. Report back

Compact. Per page: what was factually **wrong** (this is the interesting part — quote the claim),
what you added, what you deliberately left alone. Then: anything you found where the CODE looks
wrong, and anything the orchestrator needs to do in `meta.json` or the roadmap.
