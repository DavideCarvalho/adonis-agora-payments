---
'@adonis-agora/payments': minor
---

Operate billing from the terminal: every console read and action now has a `payments:<noun>:<verb>` ace command that serves the console's own handler (same filters, refusals, organization scope and audit trail).

- Reads: `payments:overview`, `payments:payments:list|show`, `payments:subscriptions:list|show`, `payments:customers:list`, `payments:disputes:list`, `payments:webhook-events:list`, `payments:audit:list`, `payments:providers:list`, `payments:organizations:list`. `--json` prints the console's `{ data, meta }`; `--tenant` narrows to one organization; lists take `--page`/`--size`.
- Actions: `payments:payments:refund`, `payments:subscriptions:cancel|resume|reprice`, `payments:disputes:resolve|evidence`, `payments:webhook-events:retry`. Each validates first, asks for confirmation unless `--force` (and refuses without a terminal), takes `--dry-run` to show what would happen without sending or writing anything, and records `cli:<os user>` plus `--note` in the audit trail.
- New console handlers behind the commands: `cancelSubscription`, `resumeSubscription`, `repriceSubscription` (through `manager.subscriptions()`) and `submitDisputeEvidence` (through the dispute's gateway), with audit actions `subscription.canceled|resumed|repriced` and `dispute.evidence_submitted`. The refund, retry and resolve handlers accept `{ dryRun: true }`, and refund takes a `note`.
- `serveConsoleRoute`, `CONSOLE_ROUTES`, `createConsoleActions` and `consoleCapabilities` (from `@adonis-agora/payments/dashboard`) are the one core the console API, its dev tools and the commands go through. `ProviderCapabilities` gains `updateSubscription`.
