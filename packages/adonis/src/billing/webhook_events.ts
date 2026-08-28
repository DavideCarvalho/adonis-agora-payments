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
  customerId?: string;
  subscriptionId?: string;
  /**
   * The `externalReference` the app set on the charge/subscription, echoed back by the
   * gateway. First-class so app handlers route payments to their local records without
   * digging into `event.raw` — the reason {@link ChargeInput.externalReference} exists.
   */
  externalReference?: string;
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
