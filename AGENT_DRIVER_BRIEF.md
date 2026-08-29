# Adding a gateway driver — shared brief

You are adding one or two gateway drivers to `@adonis-agora/payments`, an AdonisJS v7
package. Several agents are doing this at the same time in the **same working tree**, so
the file-ownership rules below are not advice.

Working directory: `/home/dudousxd/personal/oss/adonis/adonis-payments`.
Package root: `packages/adonis`. Branch: whatever is checked out — **do not switch branches
and do not create one.**

---

## 0. Read these first, in this order

1. `packages/adonis/src/driver.ts` — the `PaymentsDriver` contract you implement, and the
   input types (`ChargeInput`, `CheckoutInput`, `CreateSubscriptionInput`, …).
2. `packages/adonis/src/types.ts` — `Payment`, `Subscription`, `Customer`, `WebhookEvent`,
   `PaymentMethodName`, `BillingStatus`. These are the shapes you map **onto**.
3. `packages/adonis/src/drivers/asaas.ts` — the reference REST driver. Longest, most
   complete, and the one to imitate for structure, comment density and mapping style.
4. `packages/adonis/src/drivers/stripe.ts` — the reference SDK-based driver.
5. `packages/adonis/src/drivers/shared.ts` — `requireCredential` / `requireCurrency`.
6. `packages/adonis/src/http.ts` — `httpRequest`, `headerValue`, `isNotFound`.
7. `packages/adonis/src/webhook_security.ts` (find it via `src/index.ts`) — `safeCompare`,
   `verifyHmacSignature`, `verifyRsaSha256Signature`, `requireMatchingCredential`.
8. `packages/adonis/src/money.ts` — `toDecimal` / `fromDecimal`.
9. `docs/providers/asaas.mdx` and `docs/providers/stripe.mdx` — the docs voice and shape.

## 1. Files you own

Create **only** these, one set per gateway. They are yours alone:

- `packages/adonis/src/drivers/<slug>.ts`
- `packages/adonis/test/<slug>_driver.spec.ts`
- `docs/providers/<slug>.mdx`
- `.changeset/<slug>-driver.md`

**Do not edit any file another agent might touch.** Specifically, do NOT edit:
`src/define_config.ts`, `src/index.ts`, `docs/providers/meta.json`, `docs/providers/index.mdx`,
`src/driver.ts`, `src/types.ts`, `src/drivers/shared.ts`, any existing driver, `package.json`,
`pnpm-workspace.yaml`, or anything under `src/billing/`. The orchestrator wires those up from
the snippet you hand back.

**Do not commit and do not push.** Leave your files in the working tree.

If you genuinely cannot express something without changing a shared type, do not change it —
report it as a finding with the exact change you would need.

## 2. Research the real API. Do not write from memory.

This is money code for a gateway you cannot test against. Every endpoint path, field name,
auth header and signature scheme must come from the gateway's **current official
documentation**, fetched during this task.

- Use the `context7` MCP tools (`resolve-library-id`, then `query-docs`) for anything with a
  library entry, and `WebFetch` the official API reference for the rest.
- Prefer the current major version. Note explicitly when a gateway has a legacy API you are
  deliberately not targeting.
- If the docs are ambiguous on a point that affects money — the unit of `amount`, whether a
  status means settled — say so in a code comment and in the docs page. An honest "the API
  reference does not state this" is worth more than a confident guess.
- **Never invent an endpoint to satisfy the contract.** See §4.

## 3. Implementation rules

**Transport.** Prefer plain REST through the package's own `httpRequest` helper. Do not add
an SDK as a peer dependency unless the gateway's signature verification or auth genuinely
cannot be done without it — fourteen new peer dependencies is a cost the whole package pays.
If you conclude an SDK is required, do NOT add it to `package.json` yourself; report it.

**Credentials.** Read config first, env second, via `requireCredential` from
`src/drivers/shared.ts`. Fail at **boot**, not at the first charge.

**Currency.** A multi-currency gateway takes a **required** `currency` and must call
`requireCurrency(slug, config.currency)` in its constructor. A single-currency gateway (the
BRL-only Brazilian ones) takes **no** `currency` option at all — inventing one implies a
choice that does not exist.

**Money is an integer in the currency's smallest unit**, everywhere in this package. If the
gateway wants decimals, convert at the boundary with `toDecimal`/`fromDecimal` and nowhere
else. If the gateway returns a string, `Number()` it at the boundary. Never divide by 100 in
business logic.

**`supportedMethods` must be honest.** List only what `charge()` genuinely produces —
verified against the API reference, not the marketing page. `'undefined'` is a legitimate
member of `PaymentMethodName`: it means "let the customer choose at checkout". Routing a
method a driver does not declare fails at the manager, which is the point.

**`capabilities`** (`refunds` / `invoices` / `subscriptions`) likewise: only `true` where the
API has the endpoint.

**`externalReference`** must be mapped onto whatever the gateway echoes back on its webhooks,
and read back out in `parseWebhook` onto `event.data.externalReference`. Say which field on
the docs page. This is the only thing tying a confirmation to the app's own row.

**`parseWebhook` must verify the signature** using the gateway's documented scheme, and throw
when verification fails. Follow the enforcement policy the existing drivers use: strict when
a credential is configured; skipped only where the gateway treats signing as optional, so
local development works without gateway setup. Then normalize onto the canonical event types
(`payment.succeeded`, `payment.failed`, `payment.refunded`, `payment.updated`,
`subscription.created`, `subscription.updated`, `subscription.canceled`) with a stable `id`.

**Anything the gateway does not support must THROW**, with a `[payments]`-prefixed message
naming the gateway and what to do instead. This is the single most important rule here. A
driver in this package was recently found "supporting" a subscription update by mutating a
local object and returning it — reporting success for a change the gateway never saw. Silent
success on money is worse than no support at all.

**Style.** Match the surrounding code exactly: single quotes, 100 columns, `#private` fields,
`...(x !== undefined ? { k: x } : {})` for optional properties. Comments explain **why**,
never what. No comment that restates the line below it.

## 4. Tests — the bar

`packages/adonis/test/<slug>_driver.spec.ts`, vitest, matching `test/asaas_driver.spec.ts`
and `test/woovi_driver.spec.ts` (read them; they stub the HTTP layer rather than the
network). Cover at minimum:

- a charge mapping onto the canonical `Payment`, including the money unit;
- the webhook signature check **rejecting** a forged/tampered body, and accepting a valid one;
- one normalized webhook event with `externalReference` read back out;
- every operation the gateway does not support **throwing**;
- the boot failure when the credential (and currency, if multi-currency) is missing.

**Mutation-proof every test.** After it passes, deliberately break the implementation it
covers — invert the signature comparison, drop the `toDecimal` conversion, make the
unsupported operation return a fake object — and confirm THAT test fails. Then restore with a
**targeted edit**. Never `git checkout` a file: other agents have uncommitted work in this
tree. Report which mutations you ran and that each was caught. A test that passes both before
and after the break measures nothing and must be rewritten.

There is also an integration suite (`pnpm test:integration`, real Postgres via
testcontainers). It covers the billing store, not drivers — you do not need to add to it.

## 5. Verify

From the repo root:

- `pnpm lint` — clean. Three `noExplicitAny` **warnings** in `src/billing/mixins/*` are
  pre-existing; anything else is yours or another agent's, so check `git status` before
  claiming a failure is not yours.
- `pnpm typecheck` — clean.
- `pnpm --filter @adonis-agora/payments test` — green. Other agents are adding files to this
  same tree; if a failure is in a file you do not own, say so rather than fixing it.

## 6. Docs page

`docs/providers/<slug>.mdx`, frontmatter `title` / `description` / `icon: Landmark`, then the
same bullet structure the existing pages use: **Methods**, **Setup**, **Webhooks**,
**`externalReference`**, **Subscriptions**, plus whatever is genuinely peculiar to that
gateway. Voice: plain, technical, second person, no marketing. Say what it does **not** do —
that is the half a reader cannot get from the gateway's own site.

Every page must carry this, worded naturally in your own sentence, not copy-pasted:

> This driver is written against `<gateway>`'s published API reference and covered by unit
> tests; it has not been exercised against a live `<gateway>` account. Verify in sandbox
> before taking real money.

## 7. Changeset

`.changeset/<slug>-driver.md`, `minor`, format matching the existing ones in `.changeset/`.
State what the driver supports, what it refuses and why, and the same not-yet-verified
caveat.

## 8. What to report back

Compact. No large diffs.

1. For each gateway: the API version you targeted, the auth scheme, the money unit, the
   `supportedMethods` and `capabilities` you settled on, and **what you made it refuse**.
2. **The exact snippet to paste into `src/define_config.ts`** — the `<Slug>DriverConfig`
   interface and the factory entry, in the existing style:

   ```ts
   polar(config: PolarDriverConfig): PaymentsDriverFactory {
     return async (ctx) => {
       const { PolarDriver } = await import('./drivers/polar.js');
       return new PolarDriver(ctx, config);
     };
   },
   ```

   Say whether the config argument takes a `= {}` default (it must not, if `currency` or any
   credential is required).
3. The export lines needed in `src/index.ts`.
4. The mutations you ran and that each was caught.
5. Anything the API docs would not answer, and any place you had to guess — flagged, not
   buried.
