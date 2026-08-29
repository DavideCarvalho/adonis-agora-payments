# The dispute vocabulary — shared brief

A chargeback is the one webhook that takes revenue **away**, and it has a clock. Stripe and Adyen
have been through this pass; your drivers have not. Several agents are working in the **same tree**
at once, so the file-ownership rules below are not advice.

Working directory: `/home/dudousxd/personal/oss/adonis/adonis-payments`, package root
`packages/adonis`. Do not switch branches, do not create one, **do not commit**.

---

## 1. What already landed

Read these first — they are the contract you map onto, not something to change:

- `packages/adonis/src/billing/webhook_events.ts` — `WEBHOOK_EVENT_TYPES` and
  **`DisputeWebhookData`**, the payload shape your dispute events must produce.
- `packages/adonis/src/billing/webhook_processor.ts` — `#onDisputeWarning` and
  `#onDisputeClosed`, so you can see exactly what the processor does with what you emit.
- `packages/adonis/src/drivers/stripe.ts` and `adyen.ts` — the two reference implementations.
  `#disputeWarningData`, `#disputeOutcome`, `#disputeExtras`, `#closedOutcome`.
- `docs/providers/stripe.mdx` and `docs/providers/adyen.mdx` — the docs shape and voice for this.

Three canonical event types now exist where there used to be one:

| Type | Means | The money |
| --- | --- | --- |
| `payment.dispute_warning` | a pre-dispute alert | **untouched** |
| `payment.disputed` | a chargeback was filed | **withdrawn** |
| `payment.dispute_closed` | the dispute reached its outcome | returned, or gone |

## 2. The rule, and it is the whole job

**Has the gateway taken the money yet?** That is the line, and it is the only line.

- **No money moved** → `payment.dispute_warning`. Fraud alerts (TC40/SAFE), retrieval requests,
  requests for information, inquiries, "a chargeback is incoming" notifications. Calling any of
  these `payment.disputed` moves a paid row over money still sitting in the account — which is
  exactly the bug that was just fixed on Stripe (an inquiry) and Adyen (a notification of
  chargeback). It is also the moment when a refund still prevents the chargeback from being filed
  at all, which is worth doing even on a dispute you would win, because the chargeback counts
  against the ratio that triggers network monitoring.
- **Money withdrawn** → `payment.disputed`. Unchanged from today for most of you.
- **Outcome known** → `payment.dispute_closed`, carrying `outcome`.
- **Outcome NOT readable** → `payment.updated`. Never guess. The processor **throws** on a
  `payment.dispute_closed` with no outcome, on purpose: a driver that cannot read one is supposed
  to emit an update instead.

**If a gateway has no pre-dispute notification at all, change nothing and say so on its docs
page.** An honest "this gateway sends no warning, so the first you hear is the chargeback" is worth
more than a forced mapping. Several of these gateways genuinely have no dispute API and no dispute
webhook — Pix-only gateways especially, where a Pix payment cannot be charged back the way a card
can. Saying so IS the deliverable for that driver.

### The payload

Your dispute events' `data` must satisfy `DisputeWebhookData`:

```ts
{
  gatewayId: string;      // the PAYMENT's gateway id — the row this is about, never the dispute's
  disputeId?: string;     // the dispute's own id, when the gateway has one
  reason?: string;
  actionableUntil?: string;  // ISO 8601. The deadline to respond.
  outcome?: 'won' | 'lost' | 'canceled' | 'expired';   // dispute_closed only
  amount?: number;
  currency?: string;
}
```

`actionableUntil` is the field that matters most and the one most likely to be sitting unread in a
payload you already parse. **Find it.** Adyen's was in `additionalData.defensePeriodEndsAt` and was
being thrown away; Stripe's is `evidence_details.due_by`. If your gateway sends a response deadline
anywhere, carry it. If it genuinely sends none, say so on the docs page rather than leaving the
reader to wonder.

`amount` and `currency` are optional here on purpose — Stripe's early fraud warning object has
neither — so do not refuse an alert for lacking them.

## 3. Research the real API. Do not write from memory.

Every event name, status value and field path must come from the gateway's **current official
documentation**, fetched during this task. Use `context7` (`resolve-library-id`, then `query-docs`)
where there is a library entry and `WebFetch` the official reference otherwise.

This is money code for gateways you cannot test against. If the reference does not say whether an
event withdraws funds, **say so in a code comment and on the docs page and leave the mapping where
it is** — an honest "the reference does not state this" beats a confident guess that takes a live
payment away.

## 4. Files you own

Only the drivers named in your task, and for each:

- `packages/adonis/src/drivers/<slug>.ts`
- `packages/adonis/test/<slug>_driver.spec.ts`
- `docs/providers/<slug>.mdx`
- one changeset, `.changeset/<your-slugs>-disputes.md`

**Nothing else.** Do NOT edit `src/driver.ts`, `src/types.ts`, `src/billing/**`, `src/diagnostics.ts`,
`src/index.ts`, `src/define_config.ts`, any other driver, `package.json`, `docs/roadmap.mdx`,
`docs/meta.json`, `docs/providers/index.mdx` or `docs/providers/meta.json`. Report anything you
need there instead — the orchestrator wires it.

## 5. Tests — the bar

In your driver's spec, in the style already there. For each driver, at minimum:

- every event you newly map, asserted by type;
- for a warning: that it is **not** `payment.disputed`, and that `actionableUntil` comes through
  when the gateway sends a deadline;
- for a close: the outcome for each status the gateway can report;
- if the gateway can report a close whose outcome is unreadable: that it stays `payment.updated`.

**Mutation-proof every test.** Break the implementation it covers, confirm THAT test fails, restore
with a **targeted edit**. Never `git checkout` — other agents have uncommitted work in this tree.

Two things that bit the last round, so do them:

- Name your script **uniquely**: `mutate_<yourslugs>.py`. Agents collided on `mutate.py`.
- Make each mutation's restore **unambiguous**. A mutation that replaces a line with something
  that already appears elsewhere in the file cannot be restored by search-and-replace, and you
  will leave the tree broken. Assert the match count is exactly 1 in **both** directions and stop
  if it is not.

## 6. Verify

- `pnpm lint` — three `noExplicitAny` warnings in `src/billing/mixins/*` are pre-existing.
  Biome's formatter is part of lint: run `pnpm exec biome check --write <your files>` before you
  claim it is clean.
- `pnpm --filter @adonis-agora/payments typecheck`
- `pnpm --filter @adonis-agora/payments test` — if a failure is in a file you do not own, say so
  rather than fixing it.
- `pnpm --filter @adonis-agora/payments exec vitest run test/driver_registry.spec.ts` — it gates
  the generated providers table and requires every provider page to name `externalReference`.

Do **not** run `pnpm test:integration`; Docker is unavailable here.

## 7. Report back

Compact, no large diffs. Per driver:

1. The reference you read (link), and the API version.
2. Every event you mapped and to what — and **every event you deliberately left alone, with why**.
3. Whether the gateway sends a response deadline, and the field it lives in.
4. The mutations you ran, and that each was caught.
5. Anything the reference would not answer — flagged, not buried.

If a driver's gateway has no dispute vocabulary at all, that is a complete and correct answer.
Say it plainly and spend your effort on the docs page.
