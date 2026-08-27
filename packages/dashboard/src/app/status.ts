/**
 * Status → CSS class + label. Pure, so the one thing this console must never get wrong — which
 * rows read as an alarm — is testable without rendering anything.
 *
 * The hues live in `index.css` as `.s-<status>` classes; this file only picks which one applies.
 * An UNKNOWN status (a gateway is free to invent its own) falls back to `s-unknown` rather than
 * borrowing a neighbouring hue: a status nobody modelled must not be able to look "paid".
 */

const KNOWN_PAYMENT_STATUSES = new Set(['paid', 'pending', 'failed', 'refunded', 'canceled']);

const KNOWN_WEBHOOK_STATUSES = new Set(['received', 'processed', 'failed']);

export function paymentStatusClass(status: string): string {
  return KNOWN_PAYMENT_STATUSES.has(status) ? `s-${status}` : 's-unknown';
}

export function webhookStatusClass(status: string): string {
  return KNOWN_WEBHOOK_STATUSES.has(status) ? `s-${status}` : 's-unknown';
}

/**
 * Whether a row is one an operator has to ACT on.
 *
 * A `failed` webhook event is the load-bearing case: the dispatcher gave up, so the event's effect
 * — a subscription activated, a payment recorded — never happened, and nothing will retry it.
 */
export function isActionable(status: string): boolean {
  return status === 'failed';
}
