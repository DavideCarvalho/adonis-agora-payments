---
'@adonis-agora/payments': patch
---

`arrears()` now accepts `InMemoryBillingStore`.

It was typed `store: BillingStore`, whose row generics default to the Lucid models — so it rejected this library's own testing store, even though `listPayments` is identical on both and does not reference those generics. Anyone following the obvious testing path (inject `InMemoryBillingStore`, assert the delinquency branch) hit a type error on their first try.

Typed on the one method it reads instead, which also states the honest contract: `arrears` reads payments and nothing else.

Worth noting for maintainers: this shipped in 0.13.0 despite `test/arrears.spec.ts` passing `InMemoryBillingStore`, because `tsconfig.json` excludes `test/**`. The suite runs but is never typechecked, so a type-level regression in a public signature is invisible to CI. Including `test/**` today surfaces 285 pre-existing errors, so that cleanup is its own piece of work.
