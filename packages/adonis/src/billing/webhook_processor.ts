import { publishPayments } from '../diagnostics.js';
import type { PaymentsDriver } from '../driver.js';
import type { WebhookEvent } from '../types.js';
import type { BillingStore } from './billing_store.js';
import {
  isDisputeWebhookData,
  isPaymentWebhookData,
  isSubscriptionWebhookData,
} from './webhook_events.js';

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
  /** Map of gateway event type → handler. Apps register their business logic here. */
  handlers?: Record<string, WebhookHandler>;
}

/**
 * Routes normalized webhook events to handlers, enforcing idempotency through the
 * `billing_webhook_events` ledger (keyed by gateway event id), and keeps the local
 * billing tables in sync (payments, subscriptions).
 *
 * Built-in handlers keep the store in sync and publish the normalized business events on
 * the `@adonis-agora/diagnostics` channel (`agora:payments:payment.succeeded`, ...) —
 * apps react with `onDiagnostic('payments', ...)` (or the `handlers` below). App
 * handlers (via `handlers`) run after the built-in sync and can dispatch work.
 */
export class WebhookProcessor {
  #store: BillingStore;
  #driver: PaymentsDriver | undefined;
  #handlers: Record<string, WebhookHandler>;

  constructor(options: WebhookProcessorOptions) {
    this.#store = options.store;
    this.#driver = options.driver;
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
      // The NORMALIZED event, stored beside the raw payload so the dashboard's retry can
      // replay this delivery without calling `parseWebhook` again — which would re-verify a
      // signature computed from headers the ledger never kept.
      normalized: event.data,
    });

    // Already seen → idempotent replay, skip.
    if (ledger === null) return false;

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
      publishPayments('webhook.processed', {
        id: event.id,
        provider: event.provider,
        type: event.type,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#store.markWebhookFailed(ledger.id, message);
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
      case 'payment.disputed':
        return this.#onPaymentDisputed(event);
      case 'payment.dispute_warning':
        return this.#onDisputeWarning(event);
      case 'payment.dispute_closed':
        return this.#onDisputeClosed(event);

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
    const { gatewayId, amount, currency, customerId, subscriptionId, externalReference } =
      event.data;
    await this.#store.savePayment({
      gatewayId,
      provider: event.provider,
      status: 'paid',
      amount,
      currency,
      ...(customerId !== undefined ? { customerId } : {}),
      ...(subscriptionId !== undefined ? { subscriptionId } : {}),
      // Spread away when absent, never passed as `null`: the store keeps what it already has
      // for an `undefined` reference, and a later event that does not echo one must not blank
      // the key the app routes on.
      ...(externalReference !== undefined ? { externalReference } : {}),
      paidAt: new Date(),
      payload: event.raw,
    });
    publishPayments('payment.succeeded', {
      gatewayId,
      provider: event.provider,
      amount,
      currency,
      ...(event.data.externalReference !== undefined
        ? { externalReference: event.data.externalReference }
        : {}),
    });
  }

  async #onPaymentFailed(event: WebhookEvent): Promise<void> {
    if (!isPaymentWebhookData(event.data)) {
      throw new Error(`[payments] Malformed payment.failed payload for event ${event.id}.`);
    }
    const { gatewayId, amount, currency, customerId, subscriptionId, externalReference } =
      event.data;
    await this.#store.savePayment({
      gatewayId,
      provider: event.provider,
      status: 'failed',
      amount,
      currency,
      ...(customerId !== undefined ? { customerId } : {}),
      ...(subscriptionId !== undefined ? { subscriptionId } : {}),
      ...(externalReference !== undefined ? { externalReference } : {}),
      payload: event.raw,
    });
    publishPayments('payment.failed', {
      gatewayId,
      provider: event.provider,
      amount,
      currency,
      ...(event.data.externalReference !== undefined
        ? { externalReference: event.data.externalReference }
        : {}),
    });
  }

  async #onPaymentRefunded(event: WebhookEvent): Promise<void> {
    if (!isPaymentWebhookData(event.data)) {
      throw new Error(`[payments] Malformed payment.refunded payload for event ${event.id}.`);
    }
    const { gatewayId, amount, currency, externalReference } = event.data;
    const existing = await this.#store.findPaymentByGatewayId(gatewayId);
    if (existing) {
      await this.#store.savePayment({
        gatewayId,
        provider: event.provider,
        status: 'refunded',
        amount,
        currency,
        ...(externalReference !== undefined ? { externalReference } : {}),
        ...(existing.customerId !== undefined ? { customerId: existing.customerId } : {}),
        ...(existing.subscriptionId !== undefined
          ? { subscriptionId: existing.subscriptionId }
          : {}),
        payload: event.raw,
      });
    }
    publishPayments('payment.refunded', {
      gatewayId,
      provider: event.provider,
      amount,
      currency,
    });
  }

  /**
   * A chargeback: the customer's bank has pulled the money back.
   *
   * The one webhook that takes revenue AWAY, and until now the library had no name for it —
   * `BillingStatus` carried `'disputed'` while nothing could ever set it, so a dispute
   * arrived as an unknown type, passed through unprocessed, and the payment row went on
   * saying `paid`. The app found out from its bank statement.
   *
   * Deliberately does NOT invent the resolution event. A dispute that is later won or lost
   * is reported differently by every gateway, and a canonical type no driver emits is worse
   * than none — those arrive as `payment.updated`.
   */
  async #onPaymentDisputed(event: WebhookEvent): Promise<void> {
    if (!isPaymentWebhookData(event.data)) {
      throw new Error(`[payments] Malformed payment.disputed payload for event ${event.id}.`);
    }
    const { gatewayId, amount, currency, externalReference } = event.data;
    const existing = await this.#store.findPaymentByGatewayId(gatewayId);
    if (existing) {
      await this.#store.savePayment({
        gatewayId,
        provider: event.provider,
        status: 'disputed',
        amount,
        currency,
        ...(externalReference !== undefined ? { externalReference } : {}),
        ...(existing.customerId !== undefined ? { customerId: existing.customerId } : {}),
        ...(existing.subscriptionId !== undefined
          ? { subscriptionId: existing.subscriptionId }
          : {}),
        payload: event.raw,
      });
    }
    publishPayments('payment.disputed', {
      gatewayId,
      provider: event.provider,
      amount,
      currency,
    });
  }

  /**
   * A pre-dispute alert: a Stripe inquiry or early fraud warning, an Adyen notification of
   * chargeback or fraud. **Nothing is written.** No money has moved, so a payment that says
   * `paid` is telling the truth, and the one useful thing to do with the alert is put it in
   * front of somebody while a refund still prevents the chargeback.
   *
   * That is what the diagnostics publish is for — and until this method existed, the event
   * was declared on the bus with a payload type and published by nothing at all.
   */
  async #onDisputeWarning(event: WebhookEvent): Promise<void> {
    if (!isDisputeWebhookData(event.data)) {
      throw new Error(
        `[payments] Malformed payment.dispute_warning payload for event ${event.id}.`,
      );
    }
    const { gatewayId, reason, actionableUntil } = event.data;
    publishPayments('payment.dispute_warning', {
      gatewayId,
      provider: event.provider,
      ...(reason !== undefined ? { reason } : {}),
      ...(actionableUntil !== undefined ? { actionableUntil } : {}),
    });
  }

  /**
   * A dispute reaching its outcome. A WON dispute returns the money, and the row has been
   * sitting at `disputed` since the chargeback arrived — `revenue()` sums rows that are
   * `paid`, so leaving it there writes off money that came back.
   *
   * Only `won` moves it. `lost` and `expired` are money that is gone, and `canceled` — the
   * cardholder withdrawing — is deliberately NOT treated as a win: on Stripe a withdrawn
   * dispute still has to be closed in your favour with evidence, so calling it settled would
   * count revenue the acquirer has not returned. Understating is the safe direction here.
   */
  async #onDisputeClosed(event: WebhookEvent): Promise<void> {
    if (!isDisputeWebhookData(event.data)) {
      throw new Error(`[payments] Malformed payment.dispute_closed payload for event ${event.id}.`);
    }
    const { gatewayId, disputeId, outcome, amount, currency } = event.data;
    // A close with no outcome is not a close. Defaulting it — to `lost`, to anything —
    // would report a result the gateway never sent, which is the failure this whole event
    // exists to avoid: a driver that cannot read the outcome is supposed to emit
    // `payment.updated` instead.
    if (outcome === undefined) {
      throw new Error(
        `[payments] payment.dispute_closed for event ${event.id} carries no outcome. A driver that cannot read one must emit payment.updated instead.`,
      );
    }
    const existing = await this.#store.findPaymentByGatewayId(gatewayId);

    if (outcome === 'won' && existing !== null && existing.status === 'disputed') {
      await this.#store.savePayment({
        gatewayId,
        provider: event.provider,
        status: 'paid',
        // The dispute's amount can differ from the charge's — a partial dispute, or a
        // currency conversion between the charge and the chargeback. The ROW keeps the
        // amount it was charged for; the dispute's own figure stays on the payload.
        amount: existing.amount,
        currency: existing.currency,
        ...(existing.customerId !== null ? { customerId: existing.customerId } : {}),
        ...(existing.subscriptionId !== null ? { subscriptionId: existing.subscriptionId } : {}),
        payload: event.raw,
      });
    }

    publishPayments('payment.dispute_closed', {
      gatewayId,
      provider: event.provider,
      disputeId: disputeId ?? gatewayId,
      outcome,
      ...(amount !== undefined ? { amount } : {}),
      ...(currency !== undefined ? { currency } : {}),
    });
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
    const type =
      event.type === 'subscription.created' ? 'subscription.created' : 'subscription.updated';
    publishPayments(type, {
      gatewayId: data.gatewayId,
      provider: event.provider,
      customerId: data.customerId,
      status: data.status,
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
    publishPayments('subscription.canceled', {
      gatewayId: data.gatewayId,
      provider: event.provider,
    });
  }
}
