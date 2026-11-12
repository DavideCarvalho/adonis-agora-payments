---
"@adonis-agora/payments": minor
---

The payments console now serves its data to coding agents on the app's dev MCP endpoint (`/mcp/agora`) when the app registers `@adonis-agora/agent/mcp_provider`. Fourteen `payments_*` tools, gated by the console's own `authorize` and, with organizations on, scoped to the organizations the console shows the caller (`tenant` narrows to one). Reads (`payments_get_overview`, `payments_get_health`, `payments_list_payments`, `payments_get_payment`, `payments_list_subscriptions`, `payments_get_subscription`, `payments_list_disputes`, `payments_list_webhook_events`, `payments_list_customers`, `payments_list_audit`, `payments_list_organizations`) are listed by default and return what the console's JSON API returns. The actions (`payments_refund_payment`, `payments_retry_webhook_event`, `payments_resolve_dispute`) only when the app opts in on the dev endpoint; each is recorded in the activity trail as `mcp:<caller>` (a retry under the new `webhook.retried` action). No configuration in this package.

New `anyAuthorize(...authorizers)` in `@adonis-agora/payments/dashboard`: allows a request when any of the given `authorize` forms does, e.g. a console token for MCP clients or a signed-in admin.
