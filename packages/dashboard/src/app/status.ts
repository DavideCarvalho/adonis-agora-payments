/**
 * Status → CSS class + label. Pure, so the one thing this console must never get wrong — which
 * rows read as an alarm — is testable without rendering anything.
 *
 * The hues live in `index.css` as `.s-<status>` classes; this file only picks which one applies.
 * An UNKNOWN status (a gateway is free to invent its own) falls back to `s-unknown` rather than
 * borrowing a neighbouring hue: a status nobody modelled must not be able to look "paid".
 */

/** Every member of `BillingStatus`. `authorized` is money HELD and not taken; `disputed` is money
 *  already pulled back. Neither may render as a flavour of `paid`. */
const KNOWN_PAYMENT_STATUSES = new Set([
  'paid',
  'authorized',
  'pending',
  'failed',
  'refunded',
  'disputed',
  'canceled',
]);

/** Every member of `SubscriptionStatus`. */
const KNOWN_SUBSCRIPTION_STATUSES = new Set([
  'trialing',
  'active',
  'paused',
  'past_due',
  'incomplete',
  'canceled',
  'ended',
]);

const KNOWN_WEBHOOK_STATUSES = new Set(['received', 'processed', 'failed']);

/** Every member of `DisputeStatus`. `warning` is a pre-chargeback ALERT: nothing has been pulled
 *  back yet, and it must not render like the three that mean money left the account. */
const KNOWN_DISPUTE_STATUSES = new Set([
  'warning',
  'open',
  'under_review',
  'won',
  'lost',
  'canceled',
  'expired',
]);

/** The dispute statuses that still need an answer — mirrors the store's `OPEN_DISPUTE_STATUSES`.
 *  These are the rows `?dueWithin=` returns, and the only ones with a clock still running. */
const OPEN_DISPUTE_STATUSES = new Set(['warning', 'open', 'under_review']);

export function paymentStatusClass(status: string): string {
  return KNOWN_PAYMENT_STATUSES.has(status) ? `s-${status}` : 's-unknown';
}

export function subscriptionStatusClass(status: string): string {
  return KNOWN_SUBSCRIPTION_STATUSES.has(status) ? `s-${status}` : 's-unknown';
}

export function webhookStatusClass(status: string): string {
  return KNOWN_WEBHOOK_STATUSES.has(status) ? `s-${status}` : 's-unknown';
}

export function disputeStatusClass(status: string): string {
  return KNOWN_DISPUTE_STATUSES.has(status) ? `s-${status}` : 's-unknown';
}

/**
 * Whether this dispute is still unanswered — a clock is still running on it.
 *
 * `expired` is NOT here: the window shut, and there is nothing left to answer. It is the outcome
 * this screen exists to prevent, not a state to keep chasing.
 */
export function disputeIsOpen(status: string): boolean {
  return OPEN_DISPUTE_STATUSES.has(status);
}

/**
 * Whether a chargeback was actually FILED — money left the account at some point.
 *
 * The distinction the whole screen turns on: a `warning` is an issuer's fraud alert or a
 * retrieval request. The customer complained, the funds are still yours, and a refund now stops
 * the chargeback from ever being filed. Rendering it as a chargeback would have an operator write
 * off revenue they still have — and stop them refunding while it is still worth it.
 *
 * `canceled` is out too: a dispute withdrawn before it became a debit. An unmodelled status is out
 * as well — a status nobody modelled must not be able to claim money moved.
 */
export function disputeIsChargeback(status: string): boolean {
  return (
    status === 'open' ||
    status === 'under_review' ||
    status === 'won' ||
    status === 'lost' ||
    status === 'expired'
  );
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

/**
 * Whether a subscription needs someone to do something today.
 *
 * `past_due` is a customer whose payment failed and who is about to lose access; `incomplete` is a
 * signup that never finished paying. Both are revenue that will disappear silently. `paused` is
 * NOT here — it is deliberate, and dragging it into the alarm list would train the operator to
 * ignore the list.
 */
export function subscriptionNeedsAttention(status: string): boolean {
  return status === 'past_due' || status === 'incomplete';
}

/**
 * Whether this subscription is currently collecting money and entitling its subscriber.
 *
 * The trap this exists for: `paused` is a real state, not a flavour of `active`. A paused
 * subscription exists and will bill again, and is not billing NOW — reading the two as the same is
 * how a non-paying subscriber keeps their access.
 */
export function subscriptionIsBilling(status: string): boolean {
  return status === 'active' || status === 'trialing';
}
