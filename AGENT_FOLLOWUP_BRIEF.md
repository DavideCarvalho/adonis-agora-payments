# Adopting the widened contract — shared brief

The shared types grew to say things drivers were previously forced to lie about. Your job is
to make **your** drivers tell the truth with them.

Working directory: `/home/dudousxd/personal/oss/adonis/adonis-payments`, package root
`packages/adonis`. Several agents are doing this at once in the **same tree**, so the file
ownership rule is not advice. Do not switch branches, do not create one, **do not commit**.

## Files you own

Only the drivers named in your task, and for each: `packages/adonis/src/drivers/<slug>.ts`,
`packages/adonis/test/<slug>_driver.spec.ts`, `docs/providers/<slug>.mdx`, and a changeset in
`.changeset/`. Nothing else. In particular do NOT edit `src/driver.ts`, `src/types.ts`,
`src/billing/**`, `src/http.ts`, `src/webhook_security.ts`, `src/define_config.ts`,
`src/index.ts`, `package.json`, `docs/providers/meta.json` or `docs/roadmap.mdx` — report
anything you need there instead.

## What changed

**1. `payment.disputed` is a canonical webhook event.**

`BillingStatus` carried `'disputed'` from the start while nothing could set it: the processor
knew six event types and none was a dispute, so a chargeback — the one webhook that takes
revenue **away** — arrived as an unknown type, passed through unprocessed, and the payment row
went on saying `paid`. The app found out from its bank statement.

The processor now handles `payment.disputed`: it moves the stored payment to `disputed`,
keeps the customer the row already had, and publishes on the diagnostics bus. It needs the
usual payment payload shape (`gatewayId`, `amount`, `currency`, plus `externalReference` when
you have it).

**Map your gateway's chargeback/dispute-opened event onto it.** Check the API reference for
what that event is actually called. If a gateway genuinely has no dispute notification, say so
on its docs page — do not force an unrelated event into it.

Deliberately **not** added: a resolution event. Every gateway reports a dispute won or lost
differently, and a canonical type no driver emits is worse than none — map those to
`payment.updated` and say so on the page.

**2. `BillingStatus` gained `'authorized'`.**

Funds held on the card, nothing captured, money has NOT moved. The auth/capture gateways had
no word for it, so it collapsed into `pending` (understates it) or `paid` (grants access
against money that can still evaporate). If your gateway separates authorization from capture,
map it now — and check the surrounding code for anywhere that treated the old mapping as
settled.

**3. `SubscriptionStatus` gained `'paused'`.**

A paused subscription exists, will bill again, and must **not** entitle the subscriber right
now. Several drivers were mapping `paused` → `active`, which grants access to someone who is
not paying. If yours did, fix it; if your gateway has no pause, leave it.

**4. `PaymentMethodType` / `PaymentMethodName` gained categories.**

`wallet`, `bank_transfer`, `bank_debit`, `upi`, `bnpl`, `voucher` — **categories, not brands**.
Enumerating iDEAL, Bancontact, EPS, Przelewy24, BLIK, TWINT, Klarna and a new one each quarter
is a union that never closes, and a union that never closes cannot make a routing typo fail at
the manager, which is the only reason the type is closed.

So: `bank_transfer` = push-from-your-bank (iDEAL, Bancontact, Multibanco, Trustly);
`bank_debit` = pull-from-your-account (SEPA Direct Debit, ACH); `wallet` = stored-balance and
device wallets (PayPal, Apple Pay, Google Pay); `bnpl` = buy-now-pay-later; `upi` named
outright because in India it is how people pay by default.

Widen your `supportedMethods` **only** where `charge()` genuinely produces that category, and
map the brand into the gateway's own field via `metadata`. Name on the docs page which brands
each category covers for that gateway. If you widen `supportedMethods`, the docs comparison
table is generated from the code and gated by `test/driver_registry.spec.ts` — it will follow
automatically, but run that spec.

**5. `idempotencyKey` now exists on `refund()`, `CreateCustomerInput`,
`CreateSubscriptionInput` and `UpdateSubscriptionInput`.**

`refund` takes it as a third argument: `refund(gatewayId, amount?, { idempotencyKey })`.

Wire it wherever your gateway actually deduplicates — the header, the body field, whatever the
reference says. **If a gateway has no deduplication mechanism for that operation, THROW rather
than accept and ignore it.** Silently dropping the key turns a caller's retry guarantee into a
second refund. Say which operations honour it on the docs page.

**6. `listInvoices` on a gateway with `capabilities.invoices !== true`.**

Some drivers return `[]`, some throw. Standardize on **throwing**, with the usual
`[payments]`-prefixed message naming the gateway: an empty list is indistinguishable from "you
have no invoices", which is the same silent shape as the bugs this batch exists to remove.
(`PaymentsManager.assertCapability` already stops the documented path, so this only affects a
caller reaching the driver directly — which is exactly who benefits from a real message.)

## Verification

- Every change gets a test in your driver's spec, in the style already there.
- **Mutation-proof each one**: break the implementation, confirm THAT test fails, restore with
  a targeted edit. **Never `git checkout`** — other agents have uncommitted work in this tree.
  Use a **uniquely named** mutation script (`mutate_<yourslugs>.py`); agents collided on
  `mutate.py` in the last batch.
- `pnpm lint`, `pnpm typecheck`, and `pnpm --filter @adonis-agora/payments test` must be clean
  for your files. Three `noExplicitAny` warnings in `src/billing/mixins/*` are pre-existing.
  If a failure is in a file you do not own, say so rather than fixing it.
- Run `pnpm vitest run test/driver_registry.spec.ts` — it gates the generated comparison table
  against your `capabilities`.

## Report back

Compact, no large diffs: for each driver, what you mapped for each of the six items, what you
made it refuse, the mutations you ran and that each was caught, and anything the API reference
would not answer — flagged, not buried.
