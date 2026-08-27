/**
 * The `@adonis-agora/diagnostics` emit capability, published on this global slot at that
 * package's module load. `@adonis-agora/payments` reads it STRUCTURALLY — it never imports
 * or depends on the diagnostics package. When diagnostics isn't installed the slot is
 * empty and emitting is an inert no-op. (Same pattern as `@adonis-agora/media`.)
 */
import type { Payment, Subscription } from './types.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
type EmitFn = (lib: string, event: string, payload: unknown) => void;

/**
 * The `@adonis-agora/diagnostics` trace capability. Like {@link EMIT_SLOT} it is read
 * STRUCTURALLY — payments never imports the diagnostics package.
 */
const TRACE_SLOT = Symbol.for('@agora/diagnostics:trace');
type TraceFn = <T>(lib: string, event: string, fn: () => T, payload?: unknown) => T;

/**
 * Every payments milestone published on `agora:payments:<event>`. The single runtime
 * source for the {@link PaymentsDiagnosticEvent} union — a Telescope watcher iterates
 * this to subscribe/claim, and apps subscribe with `onDiagnostic('payments', ...)`.
 *
 * Two layers:
 * - **Gateway-action** events, emitted by the drivers on API calls (`charge.created`,
 *   `charge.refunded`, `subscription.created`/`canceled`, `invoice.emitted`).
 * - **Business** events, emitted by the `WebhookProcessor` when a webhook confirms a
 *   state change (`payment.succeeded`/`failed`/`refunded`/`updated`,
 *   `subscription.updated`, plus `subscription.created`/`canceled` from webhooks) and
 *   the webhook lifecycle (`webhook.received`/`processed`/`failed`).
 */
export const PAYMENTS_DIAGNOSTIC_EVENTS = [
  'charge.created',
  'charge.refunded',
  'subscription.created',
  'subscription.updated',
  'subscription.canceled',
  'payment.succeeded',
  'payment.failed',
  'payment.refunded',
  'payment.disputed',
  'payment.updated',
  'invoice.emitted',
  'webhook.received',
  'webhook.processed',
  'webhook.failed',
] as const;

export type PaymentsDiagnosticEvent = (typeof PAYMENTS_DIAGNOSTIC_EVENTS)[number];

/**
 * The claim registry, published by `@adonis-agora/diagnostics` under this global slot as
 * a reference-counted `Map<`${lib}:${event}`, number>`. Read STRUCTURALLY — same
 * decoupling as {@link EMIT_SLOT}. A lib-specific Telescope watcher claims the channels
 * it records here so the generic `DiagnosticsWatcher` skips them (its `recordClaimed:
 * false` default), avoiding double-recording.
 */
const CLAIMS_SLOT = Symbol.for('@agora/diagnostics:claims');

function claimsRegistry(): Map<string, number> {
  const g = globalThis as Record<symbol, unknown>;
  let registry = g[CLAIMS_SLOT] as Map<string, number> | undefined;
  if (registry === undefined) {
    registry = new Map<string, number>();
    g[CLAIMS_SLOT] = registry;
  }
  return registry;
}

/**
 * Claim `payments:<event>` for every event, so the generic diagnostics→telescope bridge
 * skips them. Reference-counted (mirrors `@adonis-agora/diagnostics`'
 * `claimDiagnostics`).
 */
export function claimPaymentsDiagnostics(events: readonly string[]): () => void {
  const registry = claimsRegistry();
  const keys = events.map((event) => `payments:${event}`);
  for (const key of keys) registry.set(key, (registry.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      const count = registry.get(key);
      if (count === undefined) continue;
      if (count <= 1) registry.delete(key);
      else registry.set(key, count - 1);
    }
  };
}

/** Whether `payments:<event>` is currently claimed. */
export function isPaymentsDiagnosticClaimed(event: string): boolean {
  const registry = (globalThis as Record<symbol, unknown>)[CLAIMS_SLOT] as
    | Map<string, number>
    | undefined;
  return registry?.has(`payments:${event}`) ?? false;
}

export interface ChargeCreatedPayload {
  gatewayId: string;
  provider: string;
  amount: number;
  currency: string;
  method?: string;
}
export interface ChargeRefundedPayload {
  gatewayId: string;
  provider: string;
  amount: number;
  currency: string;
}
export interface SubscriptionCreatedPayload {
  gatewayId: string;
  provider: string;
  customerId: string;
  planId: string;
}
export interface SubscriptionUpdatedPayload {
  gatewayId: string;
  provider: string;
  customerId: string;
  status: string;
}
export interface SubscriptionCanceledPayload {
  gatewayId: string;
  provider: string;
}
/** Webhook-confirmed payment (normalized business event). */
export interface PaymentSucceededPayload {
  gatewayId: string;
  provider: string;
  amount: number;
  currency: string;
  /** The `externalReference` the app set on the charge, echoed back by the gateway. */
  externalReference?: string;
}
export interface PaymentFailedPayload {
  gatewayId: string;
  provider: string;
  amount: number;
  currency: string;
  reason?: string;
  externalReference?: string;
}
export interface PaymentRefundedPayload {
  gatewayId: string;
  provider: string;
  amount: number;
  currency: string;
}
/**
 * A chargeback. Same shape as a refund because the same facts identify it — but it is not a
 * refund: nobody at your end decided to give the money back.
 */
export interface PaymentDisputedPayload {
  gatewayId: string;
  provider: string;
  amount: number;
  currency: string;
}
export interface PaymentUpdatedPayload {
  gatewayId: string;
  provider: string;
  status: string;
}
export interface InvoiceEmittedPayload {
  gatewayId: string;
  provider: string;
  number?: string;
  url?: string;
}
export interface WebhookReceivedPayload {
  id: string;
  provider: string;
  type: string;
}
export interface WebhookProcessedPayload {
  id: string;
  provider: string;
  type: string;
}
export interface WebhookFailedPayload {
  id: string;
  provider: string;
  type: string;
  error: string;
}

/** Maps each event to its payload type, so {@link publishPayments} is checked at the call site. */
export interface PaymentsDiagnosticPayloads {
  'charge.created': ChargeCreatedPayload;
  'charge.refunded': ChargeRefundedPayload;
  'subscription.created': SubscriptionCreatedPayload;
  'subscription.updated': SubscriptionUpdatedPayload;
  'subscription.canceled': SubscriptionCanceledPayload;
  'payment.succeeded': PaymentSucceededPayload;
  'payment.failed': PaymentFailedPayload;
  'payment.refunded': PaymentRefundedPayload;
  'payment.disputed': PaymentDisputedPayload;
  'payment.updated': PaymentUpdatedPayload;
  'invoice.emitted': InvoiceEmittedPayload;
  'webhook.received': WebhookReceivedPayload;
  'webhook.processed': WebhookProcessedPayload;
  'webhook.failed': WebhookFailedPayload;
}

/**
 * Publish a payments event on `agora:payments:<event>` via the structural diagnostics
 * slot. No-op when diagnostics isn't installed (the slot is empty) — and it never throws
 * back into the library.
 */
export function publishPayments<E extends PaymentsDiagnosticEvent>(
  event: E,
  payload: PaymentsDiagnosticPayloads[E],
): void {
  const emit = (globalThis as Record<symbol, unknown>)[EMIT_SLOT] as EmitFn | undefined;
  if (typeof emit === 'function') {
    try {
      emit('payments', event, payload);
    } catch {
      // diagnostics must never break a payment operation
    }
  }
}

/** Wrap a unit of payments work in a structural trace span. */
export function tracePayments<T>(event: string, fn: () => T, payload?: unknown): T {
  const trace = (globalThis as Record<symbol, unknown>)[TRACE_SLOT] as TraceFn | undefined;
  if (typeof trace === 'function') {
    return trace('payments', event, fn, payload);
  }
  return fn();
}

/**
 * Emit the `charge.created` / `charge.refunded` / `subscription.created` /
 * `subscription.canceled` diagnostics for a normalized payment/subscription. Called by
 * the drivers after a successful gateway call; a no-op when diagnostics isn't installed.
 */
export function publishPaymentDiagnostics(payment: Payment): void {
  publishPayments('charge.created', {
    gatewayId: payment.gatewayId,
    provider: payment.provider,
    amount: payment.amount.amount,
    currency: payment.amount.currency,
    ...(payment.method !== undefined ? { method: payment.method } : {}),
  });
}

export function publishRefundDiagnostics(refund: {
  gatewayId: string;
  provider: string;
  amount: { amount: number; currency: string };
}): void {
  publishPayments('charge.refunded', {
    gatewayId: refund.gatewayId,
    provider: refund.provider,
    amount: refund.amount.amount,
    currency: refund.amount.currency,
  });
}

export function publishSubscriptionDiagnostics(
  subscription: Subscription,
  event: 'subscription.created' | 'subscription.canceled',
): void {
  if (event === 'subscription.created') {
    publishPayments('subscription.created', {
      gatewayId: subscription.gatewayId,
      provider: subscription.provider,
      customerId: subscription.customerId,
      planId: subscription.planId,
    });
  } else {
    publishPayments('subscription.canceled', {
      gatewayId: subscription.gatewayId,
      provider: subscription.provider,
    });
  }
}

export function publishInvoiceEmittedDiagnostics(invoice: {
  gatewayId: string;
  provider: string;
  number?: string;
  url?: string;
}): void {
  publishPayments('invoice.emitted', {
    gatewayId: invoice.gatewayId,
    provider: invoice.provider,
    ...(invoice.number !== undefined ? { number: invoice.number } : {}),
    ...(invoice.url !== undefined ? { url: invoice.url } : {}),
  });
}
