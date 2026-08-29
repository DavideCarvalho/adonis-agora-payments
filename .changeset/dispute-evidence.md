---
'@adonis-agora/payments': minor
---

Make `findDispute` and `submitDisputeEvidence` real on Stripe, and say plainly why Adyen cannot have
them.

`PaymentsDriver` has declared both methods and a `capabilities.disputes` flag since the dispute pass,
and no driver implemented either — a contract nothing kept. Stripe now keeps it.

**Stripe** (`capabilities.disputes: true`, API `2025-08-27.basil`). `findDispute` is
`GET /v1/disputes/{id}`; `submitDisputeEvidence` is `POST /v1/disputes/{id}` with the `evidence` hash
and `submit` (defaulting to `true` — the method is called submit, and staging silently would report a
defense the bank never received; `metadata.submit: false` stages a draft). The two fields an operator
acts on are read from Stripe's own `evidence_details`, never guessed from the status: `evidenceDueBy`
from `due_by`, and `canSubmitEvidence` from the status **and** `past_due` — past the deadline a
dispute is lost by default while its status still says `needs_response`. A dispute Stripe closed as
`lost` on arrival, or one the networks forbid contesting, reports `canSubmitEvidence: false`, so the
caller learns it before building a case rather than at the API error. `warning_*` statuses stay on the
warning side of the money line, `warning_closed` maps to `expired` and `prevented` to `canceled`.

Evidence is carried or refused, never dropped. `explanation` → `uncategorized_text`, the customer and
shipping fields → their Stripe names, a single `documentIds` entry → `uncategorized_file`, and
`metadata` reaches Stripe's own 27 evidence field names verbatim (checked against them, with file
fields requiring a `file_…` upload id). What Stripe has no home for throws with the fix in the
message: `receiptUrl`/`invoiceUrl`/`termsUrl` (Stripe wants a File upload id, and reviewing banks
follow no links), `priorUndisputedPayments` (Visa CE 3.0 wants two prior charge ids with device and
IP, not a count), more than one `documentIds` entry (Stripe files evidence by type), and an empty
evidence packet — which would spend the dispute's single submission on nothing. Mapping happens
before the dispute is read, so a refusal costs no round trip.

The library never decides whether to fight: no auto-submit, no threshold, no default response. It
makes the deadline visible and the submission one honest call.

**Adyen** keeps `capabilities.disputes: false`, and both methods now exist and throw instead of being
absent. Adyen has a dispute API — Defend Disputes v30 — but it cannot be driven through this
contract: none of its five endpoints reads a dispute back (so `Dispute.status`, `amount` and the
deadline would be invented), a defense is a scheme-specific `defenseReasonCode` plus base64 documents
with no free-text field anywhere, and it lives on `ca-{test,live}.adyen.com/ca/services/DisputeService/v30`
behind a credential with the "API dispute management" role. The throws name the three calls to make
instead, and the provider page documents the flow — including that a `disputeServiceResult.success:
false` arrives with an HTTP 200.
