/**
 * The billing event catalog.
 *
 * The billing layer emits these events whenever something billing-related happens
 * (a payment succeeded, a subscription was created/canceled, a webhook was processed...).
 * They are dispatched through the app emitter (`agora:payments:*`) and can also be
 * consumed by the in-process dispatcher's `onEvent` hooks.
 *
 * Keeping the catalog as a runtime `as const` array (authkit audit pattern) lets a drift
 * test scan call sites and fail when an emitted type isn't listed here.
 */

export const BILLING_EVENT_TYPES = [
  'billing:payment.succeeded',
  'billing:payment.failed',
  'billing:payment.refunded',
  'billing:subscription.created',
  'billing:subscription.updated',
  'billing:subscription.canceled',
  'billing:subscription.trial_started',
  'billing:invoice.created',
  'billing:invoice.paid',
  'billing:customer.created',
  'billing:customer.updated',
  'billing:webhook.received',
  'billing:webhook.handled',
  'billing:webhook.failed',
] as const;

export type BillingEventType = (typeof BILLING_EVENT_TYPES)[number];

/** Payloads for each billing event type. */
export interface BillingEventPayloads {
  'billing:payment.succeeded': { gatewayId: string; amount: number; currency: string };
  'billing:payment.failed': {
    gatewayId: string;
    amount: number;
    currency: string;
    reason?: string;
  };
  'billing:payment.refunded': { gatewayId: string; amount: number; currency: string };
  'billing:subscription.created': { gatewayId: string; customerId: string; planId: string };
  'billing:subscription.updated': { gatewayId: string; status: string };
  'billing:subscription.canceled': { gatewayId: string };
  'billing:subscription.trial_started': { gatewayId: string; trialEndsAt?: string };
  'billing:invoice.created': { gatewayId: string; amount: number; currency: string };
  'billing:invoice.paid': { gatewayId: string; amount: number; currency: string };
  'billing:customer.created': { gatewayId: string };
  'billing:customer.updated': { gatewayId: string };
  'billing:webhook.received': { id: string; provider: string; type: string };
  'billing:webhook.handled': { id: string; provider: string; type: string };
  'billing:webhook.failed': { id: string; provider: string; type: string; error: string };
}

export type BillingEventPayload<K extends BillingEventType> = BillingEventPayloads[K];

/** Emitted event name shape: `agora:payments:${eventType}`. */
export type BillingEmitterEventName = `agora:payments:${BillingEventType}`;

/** Map the emitter uses: `agora:payments:<type>` → payload. */
export type BillingEmitterEvents = {
  [K in BillingEventType as BillingEmitterEventName]: BillingEventPayloads[K];
};

export function billingEventName(type: BillingEventType): BillingEmitterEventName {
  return `agora:payments:${type}`;
}

/**
 * EmitterLike structural type (mirrors `@adonisjs/core/types/events` EmitterLike and
 * telescope's watcher emitter). Lets the framework-agnostic core subscribe to the
 * container emitter without importing AdonisJS.
 */
export interface BillingEmitterLike {
  on<K extends BillingEventType>(
    event: BillingEmitterEventName | K,
    listener: (payload: BillingEventPayloads[K]) => void,
  ): () => void;
  emit<K extends BillingEventType>(
    event: BillingEmitterEventName | K,
    payload: BillingEventPayloads[K],
  ): unknown;
}

/** A watcher that subscribes to billing events (telescope-style). */
export interface BillingWatcher {
  readonly type: string;
  start(emitter: BillingEmitterLike): void;
  stop(): void;
}
