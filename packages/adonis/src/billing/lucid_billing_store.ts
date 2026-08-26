import type { NormalizeConstructor } from '@adonisjs/core/types/helpers';
import { DateTime } from 'luxon';
import type { BillingStore } from './billing_store.js';
import {
  BillingPayment as DefaultPayment,
  BillingSubscription as DefaultSubscription,
  BillingWebhookEvent as DefaultWebhookEvent,
} from './mixins/index.js';

/**
 * Models the billing layer persists through. Apps may override any of them with their own
 * model composed from the corresponding mixin (authkit `lucidStores` pattern).
 */
export interface BillingModels {
  subscriptionModel?: NormalizeConstructor<typeof DefaultSubscription>;
  paymentModel?: NormalizeConstructor<typeof DefaultPayment>;
  webhookEventModel?: NormalizeConstructor<typeof DefaultWebhookEvent>;
}

type SubscriptionInstance = InstanceType<typeof DefaultSubscription>;
type PaymentInstance = InstanceType<typeof DefaultPayment>;
type WebhookEventInstance = InstanceType<typeof DefaultWebhookEvent>;

/**
 * Lucid implementation of {@link BillingStore}. Resolves the models passed in (defaulting
 * to the bundled ones) and writes through them, so custom models/composed mixins keep
 * working with the same store.
 */
export class LucidBillingStore
  implements BillingStore<SubscriptionInstance, PaymentInstance, WebhookEventInstance>
{
  #subscriptionModel: typeof DefaultSubscription;
  #paymentModel: typeof DefaultPayment;
  #webhookEventModel: typeof DefaultWebhookEvent;

  constructor(models: BillingModels = {}) {
    this.#subscriptionModel = (models.subscriptionModel ??
      DefaultSubscription) as typeof DefaultSubscription;
    this.#paymentModel = (models.paymentModel ?? DefaultPayment) as typeof DefaultPayment;
    this.#webhookEventModel = (models.webhookEventModel ??
      DefaultWebhookEvent) as typeof DefaultWebhookEvent;
  }

  async saveSubscription(sub: {
    gatewayId: string;
    provider: string;
    customerId: string;
    status: string;
    planId: string;
    trialEndsAt?: Date | null;
    endsAt?: Date | null;
    payload?: Record<string, unknown>;
  }): Promise<SubscriptionInstance> {
    const existing = await this.findSubscriptionByGatewayId(sub.gatewayId);
    const row = (existing ?? new this.#subscriptionModel()) as SubscriptionInstance;
    row.gatewayId = sub.gatewayId;
    row.provider = sub.provider;
    row.customerId = sub.customerId;
    row.status = sub.status;
    row.planId = sub.planId;
    row.trialEndsAt = sub.trialEndsAt ? DateTime.fromJSDate(sub.trialEndsAt) : null;
    row.endsAt = sub.endsAt ? DateTime.fromJSDate(sub.endsAt) : null;
    row.payload = sub.payload ?? {};
    await row.save();
    return row;
  }

  async findSubscriptionByGatewayId(gatewayId: string): Promise<SubscriptionInstance | null> {
    const row = await this.#subscriptionModel.findBy('gateway_id', gatewayId);
    return row as SubscriptionInstance | null;
  }

  async savePayment(payment: {
    gatewayId: string;
    provider: string;
    status: string;
    amount: number;
    currency: string;
    customerId?: string | null;
    subscriptionId?: string | null;
    paidAt?: Date | null;
    payload?: Record<string, unknown>;
  }): Promise<PaymentInstance> {
    const existing = await this.findPaymentByGatewayId(payment.gatewayId);
    const row = (existing ?? new this.#paymentModel()) as PaymentInstance;
    row.gatewayId = payment.gatewayId;
    row.provider = payment.provider;
    row.status = payment.status;
    row.amount = payment.amount;
    row.currency = payment.currency;
    row.customerId = payment.customerId ?? null;
    row.subscriptionId = payment.subscriptionId ?? null;
    row.paidAt = payment.paidAt ? DateTime.fromJSDate(payment.paidAt) : null;
    row.payload = payment.payload ?? {};
    await row.save();
    return row;
  }

  async findPaymentByGatewayId(gatewayId: string): Promise<PaymentInstance | null> {
    const row = await this.#paymentModel.findBy('gateway_id', gatewayId);
    return row as PaymentInstance | null;
  }

  async recordWebhookEvent(event: {
    gatewayEventId: string;
    provider: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<WebhookEventInstance | null> {
    const existing = await this.#webhookEventModel.findBy('gateway_event_id', event.gatewayEventId);
    if (existing) return null;
    const row = new this.#webhookEventModel() as WebhookEventInstance;
    row.gatewayEventId = event.gatewayEventId;
    row.provider = event.provider;
    row.type = event.type;
    row.status = 'received';
    row.payload = event.payload;
    row.error = null;
    await row.save();
    return row;
  }

  async markWebhookProcessed(id: string): Promise<void> {
    const row = await this.#webhookEventModel.find(id);
    if (row) {
      row.status = 'processed';
      await row.save();
    }
  }

  async markWebhookFailed(id: string, error: string): Promise<void> {
    const row = await this.#webhookEventModel.find(id);
    if (row) {
      row.status = 'failed';
      row.error = error;
      await row.save();
    }
  }
}

/** Builder matching the authkit `lucidStores(...)` convention. */
export function lucidBillingStore(models: BillingModels = {}): BillingStore {
  return new LucidBillingStore(models);
}
