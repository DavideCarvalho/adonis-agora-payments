---
'@adonis-agora/payments-dashboard': minor
'@adonis-agora/payments': minor
---

Turn the billing dashboard into a management console: health panel, subscriptions screen, gateway filter, and the first two actions.

The console could tell you what happened; it could not tell you what needed doing, and it could not
do anything about it. Four changes:

- **A health panel at the top of the Overview**, above the revenue tiles. `billingHealth()` — the
  three silent failures of a billing install (events claimed and never finished, events the
  dispatcher gave up on, charges created that never confirmed) — existed only behind
  `node ace payments:health`. It is now `GET <path>/api/health` and the first thing on the page: a
  quiet green line when the install is clean, and when it is not, the count, what it means, which
  provider and event type is failing, and a link straight to those rows.
- **A subscriptions screen** (`GET <path>/api/subscriptions`), defaulting to `past_due`, showing
  plan, customer, trial end and period end. `paused` is rendered as its own state with its own hue
  and an explicit "not billing" — a paused subscriber is not paying, and reading them as active
  grants access to someone who is not.
- **A gateway filter** on payments, subscriptions and webhook events, built from
  `GET <path>/api/providers` — what your data actually contains, not the eighteen drivers the
  package ships. A filtered page reports when its scan stopped short rather than showing a
  confident empty result.
- **Two actions**, the console's first writes. `POST <path>/api/payments/:gatewayId/refund`
  (optional partial amount, confirmed in the UI with the amount and the customer, refused before the
  call for a gateway with no refund API, reporting the gateway's own message when it refuses) and
  `POST <path>/api/webhook-events/:gatewayEventId/retry`, which re-runs a failed event through your
  own webhook handlers. Both are `POST` only and both run through the existing `authorize` guard and
  the `dashboardAuth` session.

Also: the payments filter now offers `authorized` and `disputed` (both were reachable statuses with
no way to filter for them), and the SPA's money formatter was aligned with `src/money.ts` — it was
missing the three-decimal currencies entirely, so a KWD amount rendered 10× too large.
