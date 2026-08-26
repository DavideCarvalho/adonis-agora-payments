import { publishPayments } from '../diagnostics.js';
import type { PaymentsDriver } from '../driver.js';
import type { BillingEmitterLike, BillingEventPayloads, BillingEventType } from '../events.js';
import { BILLING_EVENT_TYPES, billingEventName } from '../events.js';
import type { WebhookEvent } from '../types.js';
import type { BillingStore } from './billing_store.js';
import { isPaymentWebhookData, isSubscriptionWebhookData } from './webhook_events.js';

/**
 * A handler for a gateway webhook event type (e.g. `'invoice.payment_succeeded'`).
 * Receives the normalized event plus the raw gateway payload. Return normally to mark the
 * event processed; throw to mark it failed (and trigger the dispatcher's retry).
 */
export type WebhookHandler = (event: WebhookEvent) => void | Promise<void>;

export interface WebhookProcessorOptions {
  store: BillingStore;
  /**
   * The driver that received the webhook — used for lookups and sync. Optional: the
   * built-in handlers persist through the store and don't call the gateway.
   */
  driver?: PaymentsDriver;
  /** Optional emitter to broadcast `billing:*` events to (app emitter / in-process). */
  emitter?: BillingEmitterLike;
  /** Map of gateway event type → handler. Apps register their business logic here. */
  handlers?: Record<string, WebhookHandler>;
}

/**
 * Routes normalized webhook events to handlers, enforcing idempotency through the
 * `billing_webhook_events` ledger (keyed by gateway event id), and keeps the local
 * billing tables in sync (payments, subscriptions).
 *
 * Built-in handlers keep the store in sync; app handlers (via `handlers`) run after and
 * can emit events, send emails, release access, etc.
 */
export class WebhookProcessor {
  #store: BillingStore;
  #driver: PaymentsDriver | undefined;
  #emitter: BillingEmitterLike | undefined;
  #handlers: Record<string, WebhookHandler>;

  constructor(options: WebhookProcessorOptions) {
    this.#store = options.store;
    this.#driver = options.driver;
    this.#emitter = options.emitter;
    this.#handlers = options.handlers ?? {};
  }

  /**
   * Process a webhook event. Returns `false` when the event was already processed
   * (idempotent replay). Throws when the event handler throws.
   */
  async process(event: WebhookEvent): Promise<boolean> {
    const ledger = await this.#store.recordWebhookEvent({
      gatewayEventId: event.id,
      provider: event.provider,
      type: event.type,
      payload: event.raw,
    });

    // Already seen → idempotent replay, skip.
    if (ledger === null) return false;

    this.#emit('billing:webhook.received', {
      id: event.id,
      provider: event.provider,
      type: event.type,
    });
    publishPayments('webhook.received', {
      id: event.id,
      provider: event.provider,
      type: event.type,
    });

    try {
      await this.#runBuiltIn(event);
      const handler = this.#handlers[event.type];
      if (handler) await handler(event);
      await this.#store.markWebhookProcessed(ledger.id);
      this.#emit('billing:webhook.handled', {
        id: event.id,
        provider: event.provider,
        type: event.type,
      });
      publishPayments('webhook.processed', {
        id: event.id,
        provider: event.provider,
        type: event.type,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#store.markWebhookFailed(ledger.id, message);
      this.#emit('billing:webhook.failed', {
        id: event.id,
        provider: event.provider,
        type: event.type,
        error: message,
      });
      publishPayments('webhook.failed', {
        id: event.id,
        provider: event.provider,
        type: event.type,
        error: message,
      });
      throw error;
    }
  }

  /** Built-in sync handlers, keyed by the normalized event type (shared constants). */
  #runBuiltIn(event: WebhookEvent): Promise<void> {
    switch (event.type) {
      case 'payment.succeeded':
        return this.#onPaymentSucceeded(event);
      case 'payment.failed':
        return this.#onPaymentFailed(event);
      case 'payment.refunded':
        return this.#onPaymentRefunded(event);
      case 'subscription.created':
      case 'subscription.updated':
        return this.#onSubscriptionChanged(event);
      case 'subscription.canceled':
        return this.#onSubscriptionCanceled(event);
      default:
        return Promise.resolve();
    }
  }

  async #onPaymentSucceeded(event: WebhookEvent): Promise<void> {
    if (!isPaymentWebhookData(event.data)) {
      throw new Error(`[payments] Malformed payment.succeeded payload for event ${event.id}.`);
    }
    const { gatewayId, amount, currency, customerId, subscriptionId } = event.data;
    await this.#store.savePayment({
      gatewayId,
      provider: event.provider,
      status: 'paid',
      amount,
      currency,
      ...(customerId !== undefined ? { customerId } : {}),
      ...(subscriptionId !== undefined ? { subscriptionId } : {}),
      paidAt: new Date(),
      payload: event.raw,
    });
    this.#emit('billing:payment.succeeded', { gatewayId, amount, currency });
  }

  async #onPaymentFailed(event: WebhookEvent): Promise<void> {
    if (!isPaymentWebhookData(event.data)) {
      throw new Error(`[payments] Malformed payment.failed payload for event ${event.id}.`);
    }
    const { gatewayId, amount, currency, customerId, subscriptionId } = event.data;
    await this.#store.savePayment({
      gatewayId,
      provider: event.provider,
      status: 'failed',
      amount,
      currency,
      ...(customerId !== undefined ? { customerId } : {}),
      ...(subscriptionId !== undefined ? { subscriptionId } : {}),
      payload: event.raw,
    });
    this.#emit('billing:payment.failed', { gatewayId, amount, currency });
  }

  async #onPaymentRefunded(event: WebhookEvent): Promise<void> {
    if (!isPaymentWebhookData(event.data)) {
      throw new Error(`[payments] Malformed payment.refunded payload for event ${event.id}.`);
    }
    const { gatewayId, amount, currency } = event.data;
    const existing = await this.#store.findPaymentByGatewayId(gatewayId);
    if (existing) {
      await this.#store.savePayment({
        gatewayId,
        provider: event.provider,
        status: 'refunded',
        amount,
        currency,
        ...(existing.customerId !== undefined ? { customerId: existing.customerId } : {}),
        ...(existing.subscriptionId !== undefined
          ? { subscriptionId: existing.subscriptionId }
          : {}),
        payload: event.raw,
      });
    }
    this.#emit('billing:payment.refunded', { gatewayId, amount, currency });
  }

  async #onSubscriptionChanged(event: WebhookEvent): Promise<void> {
    if (!isSubscriptionWebhookData(event.data)) {
      throw new Error(`[payments] Malformed subscription payload for event ${event.id}.`);
    }
    const data = event.data;
    await this.#store.saveSubscription({
      gatewayId: data.gatewayId,
      provider: event.provider,
      customerId: data.customerId,
      status: data.status,
      planId: data.planId ?? '',
      ...(data.trialEndsAt !== undefined ? { trialEndsAt: new Date(data.trialEndsAt) } : {}),
      ...(data.endsAt !== undefined ? { endsAt: new Date(data.endsAt) } : {}),
      payload: event.raw,
    });
    const type: BillingEventType =
      event.type === 'subscription.created'
        ? 'billing:subscription.created'
        : 'billing:subscription.updated';
    this.#emit(type, {
      gatewayId: data.gatewayId,
      customerId: data.customerId,
      planId: data.planId ?? '',
    });
  }

  async #onSubscriptionCanceled(event: WebhookEvent): Promise<void> {
    if (!isSubscriptionWebhookData(event.data)) {
      throw new Error(`[payments] Malformed subscription.canceled payload for event ${event.id}.`);
    }
    const data = event.data;
    const existing = await this.#store.findSubscriptionByGatewayId(data.gatewayId);
    if (existing) {
      await this.#store.saveSubscription({
        gatewayId: data.gatewayId,
        provider: event.provider,
        customerId: data.customerId,
        status: 'canceled',
        planId: existing.planId,
        ...(data.trialEndsAt !== undefined ? { trialEndsAt: new Date(data.trialEndsAt) } : {}),
        ...(data.endsAt !== undefined ? { endsAt: new Date(data.endsAt) } : {}),
        payload: event.raw,
      });
    }
    this.#emit('billing:subscription.canceled', { gatewayId: data.gatewayId });
  }

  #emit<K extends BillingEventType>(type: K, payload: BillingEventPayloads[K]): void {
    if (!this.#emitter) return;
    void this.#emitter.emit(billingEventName(type), payload);
  }
}
