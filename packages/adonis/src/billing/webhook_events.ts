import type { WebhookEvent } from '../types.js';

/**
 * The canonical normalized webhook event types. Every driver's `#mapWebhookType` maps
 * its gateway events onto these, and the `WebhookProcessor`'s built-in sync switches on
 * them. Shared constant so a typo in one driver can't silently degrade to the no-op
 * branch.
 */
export const WEBHOOK_EVENT_TYPES = [
  'payment.succeeded',
  'payment.failed',
  'payment.refunded',
  'payment.disputed',
  // A dispute has two more moments than the one `payment.disputed` names. The warning
  // arrives BEFORE a chargeback exists — Stripe's early fraud warning, Adyen's fraud
  // notification, an Ethoca/Verifi alert — while refunding is still cheaper than losing.
  // The close carries the outcome. Both are canonical because the deadline they carry is
  // the only thing that makes a dispute actionable, and a deadline nothing normalizes is a
  // deadline every app re-derives from a different gateway's payload.
  'payment.dispute_warning',
  'payment.dispute_closed',
  'payment.updated',
  'subscription.created',
  'subscription.updated',
  'subscription.canceled',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Shape the built-in sync handlers expect from a payment event's `data`. */
export interface PaymentWebhookData {
  gatewayId: string;
  amount: number;
  currency: string;
  /**
   * Why it failed, in the gateway's own words. Optional because most gateways send nothing
   * useful — and declared here because `PaymentFailedPayload` has carried a `reason` since
   * the bus was written while the processor never published one, so a subscriber could not
   * see it even on the gateways that do normalize it.
   */
  reason?: string;
  customerId?: string;
  subscriptionId?: string;
  /**
   * The `externalReference` the app set on the charge/subscription, echoed back by the
   * gateway. First-class so app handlers route payments to their local records without
   * digging into `event.raw` — the reason {@link ChargeInput.externalReference} exists.
   */
  externalReference?: string;
  /**
   * The payment's CURRENT status at the gateway, as a {@link import('../types.js').BillingStatus}
   * value (`'paid'`, `'refunded'`, `'disputed'`, `'canceled'`, `'failed'`, `'pending'`,
   * `'authorized'`).
   *
   * Only `payment.updated` reads it, and it is the reason that event can do anything at all:
   * the other five payment events state their outcome in their TYPE, while an update says
   * only "this payment changed" and the new state is on the payload. Optional, because most
   * drivers do not normalize one — the built-in sync leaves the stored status alone when it
   * is absent rather than guessing.
   */
  status?: string;
  /**
   * When the gateway settled the charge, ISO-8601 — the gateway's OWN date, never the
   * webhook's arrival time.
   *
   * `revenue()` windows on this, so inventing it moves historic money into the current month.
   * Optional: a driver that cannot read a settlement date must send nothing, and the
   * processor then leaves whatever is stored alone.
   */
  paidAt?: string;
  /**
   * How much has been refunded so far, in the SAME integer minor units as `amount`.
   *
   * The field a PARTIAL refund needs and nothing else has: a R$10 refund on a R$100 charge is
   * `amount: 10000, refundedAmount: 1000` and the status stays `paid`. Overwriting `amount`
   * with the refunded figure — the only alternative before this existed — erased R$90 of
   * revenue. NEVER divide.
   */
  refundedAmount?: number;
  /** Gateway-echoed metadata, when the gateway includes it in the webhook payload. */
  metadata?: Record<string, unknown>;
}

/** Shape the built-in sync handlers expect from a subscription event's `data`. */
export interface SubscriptionWebhookData {
  gatewayId: string;
  customerId: string;
  status: string;
  planId?: string;
  trialEndsAt?: string;
  endsAt?: string;
}

/**
 * Guard: is this event's `data` shaped like a payment event? The drivers normalize their
 * payloads onto this shape (see the Asaas driver's `#mapWebhookData`); the processor
 * checks it before writing a row so a malformed event can't produce garbage rows.
 */
export function isPaymentWebhookData(data: unknown): data is PaymentWebhookData {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.gatewayId === 'string' &&
    typeof d.amount === 'number' &&
    typeof d.currency === 'string'
  );
}

/**
 * A dispute event's `data`. Deliberately looser than {@link PaymentWebhookData}: a dispute
 * alert does not always carry an amount. Stripe's early fraud warning object has no amount
 * or currency at all — it names a charge and a fraud type — and refusing it for that would
 * throw away the earliest warning the library gets.
 */
export interface DisputeWebhookData {
  /** The PAYMENT's gateway id, not the dispute's — the row this is about. */
  gatewayId: string;
  disputeId?: string;
  reason?: string;
  /** When the window to respond closes. The whole value of a warning. */
  actionableUntil?: string;
  outcome?: 'won' | 'lost' | 'canceled' | 'expired';
  amount?: number;
  currency?: string;
  /**
   * The `externalReference` the app set on the disputed charge, when the driver has it. The
   * gateways that build a dispute event out of the payment resource carry it (Asaas nests
   * `chargeback` on the payment and spreads the payment's fields — see the Asaas driver's
   * `#disputeExtras`), and an app routing a chargeback back to its own order needs it as
   * much as a `payment.succeeded` handler does. Optional because a gateway whose dispute is
   * a standalone object — Stripe's early fraud warning names only a charge — has nothing to
   * put here.
   */
  externalReference?: string;
}

/** Guard: is this event's `data` shaped like a dispute event? */
export function isDisputeWebhookData(data: unknown): data is DisputeWebhookData {
  if (typeof data !== 'object' || data === null) return false;
  return typeof (data as Record<string, unknown>).gatewayId === 'string';
}

/** Guard: is this event's `data` shaped like a subscription event? */
export function isSubscriptionWebhookData(data: unknown): data is SubscriptionWebhookData {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return typeof d.gatewayId === 'string' && typeof d.customerId === 'string';
}

/** Assert a webhook event's type is one of the canonical types (or a passthrough). */
export function isWebhookEventType(type: string): type is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(type);
}

/** Narrow a {@link WebhookEvent} to one of the canonical types. */
export function asWebhookEvent(
  event: WebhookEvent,
): WebhookEvent<unknown> & { type: WebhookEventType } {
  return event as WebhookEvent<unknown> & { type: WebhookEventType };
}
