import type { NormalizeConstructor } from '@adonisjs/core/types/helpers';
import { DateTime } from 'luxon';
import type { BillingStore } from './billing_store.js';
import {
  BillingPayment as DefaultPayment,
  BillingSubscription as DefaultSubscription,
  BillingUsageEvent as DefaultUsageEvent,
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
  usageEventModel?: NormalizeConstructor<typeof DefaultUsageEvent>;
}

type SubscriptionInstance = InstanceType<typeof DefaultSubscription>;
type PaymentInstance = InstanceType<typeof DefaultPayment>;
type WebhookEventInstance = InstanceType<typeof DefaultWebhookEvent>;
type UsageEventInstance = InstanceType<typeof DefaultUsageEvent>;

/**
 * Lucid implementation of {@link BillingStore}. Resolves the models passed in (defaulting
 * to the bundled ones) and writes through them, so custom models/composed mixins keep
 * working with the same store.
 */
export class LucidBillingStore
  implements
    BillingStore<SubscriptionInstance, PaymentInstance, WebhookEventInstance, UsageEventInstance>
{
  #subscriptionModel: typeof DefaultSubscription;
  #paymentModel: typeof DefaultPayment;
  #webhookEventModel: typeof DefaultWebhookEvent;
  #usageEventModel: typeof DefaultUsageEvent;

  constructor(models: BillingModels = {}) {
    this.#subscriptionModel = (models.subscriptionModel ??
      DefaultSubscription) as typeof DefaultSubscription;
    this.#paymentModel = (models.paymentModel ?? DefaultPayment) as typeof DefaultPayment;
    this.#webhookEventModel = (models.webhookEventModel ??
      DefaultWebhookEvent) as typeof DefaultWebhookEvent;
    this.#usageEventModel = (models.usageEventModel ??
      DefaultUsageEvent) as typeof DefaultUsageEvent;
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
    if (existing) {
      // A previous attempt failed: claim it again so the retry re-runs. Anything
      // else (in flight, or already processed) is a redelivery — stop here.
      if (existing.status !== 'failed') return null;
      existing.status = 'received';
      existing.error = null;
      await existing.save();
      return existing;
    }
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

  async recordUsage(event: {
    subscriptionId?: string | null;
    customerId?: string;
    meter: string;
    quantity: number;
    metadata?: Record<string, unknown>;
    recordedAt?: Date;
  }): Promise<UsageEventInstance> {
    const row = new this.#usageEventModel() as UsageEventInstance;
    row.subscriptionId = event.subscriptionId ?? null;
    row.customerId = event.customerId ?? null;
    row.meter = event.meter;
    row.quantity = event.quantity;
    row.metadata = event.metadata ?? {};
    row.recordedAt = event.recordedAt ? DateTime.fromJSDate(event.recordedAt) : DateTime.now();
    await row.save();
    return row;
  }

  async usageReport(query: {
    subscriptionId?: string;
    customerId?: string;
    meter?: string;
    from?: Date;
    to?: Date;
  }): Promise<Array<{ meter: string; quantity: number }>> {
    const builder = this.#usageEventModel
      .query()
      .select('meter')
      .sum('quantity as quantity')
      .groupBy('meter');
    if (query.subscriptionId !== undefined) builder.where('subscription_id', query.subscriptionId);
    else if (query.customerId !== undefined) builder.where('customer_id', query.customerId);
    if (query.meter !== undefined) builder.where('meter', query.meter);
    if (query.from !== undefined) builder.where('recorded_at', '>=', query.from);
    if (query.to !== undefined) builder.where('recorded_at', '<', query.to);
    const rows = await builder;
    return (rows as Array<{ meter: string; quantity: string | number }>).map((row) => ({
      meter: row.meter,
      quantity: Number(row.quantity),
    }));
  }

  async revenue(query: { from?: Date; to?: Date }): Promise<number> {
    const builder = this.#paymentModel.query().where('status', 'paid').sum('amount as total');
    if (query.from !== undefined) builder.where('paid_at', '>=', query.from);
    if (query.to !== undefined) builder.where('paid_at', '<', query.to);
    const rows = await builder;
    const total = (rows[0] as { total?: string | number } | undefined)?.total;
    return Number(total ?? 0);
  }

  async countActiveSubscriptions(): Promise<number> {
    const count = await this.#subscriptionModel
      .query()
      .whereIn('status', ['active', 'trialing'])
      .count('* as total');
    return Number((count[0] as { total?: string | number } | undefined)?.total ?? 0);
  }
}

/** Builder matching the authkit `lucidStores(...)` convention. */
export function lucidBillingStore(models: BillingModels = {}): BillingStore {
  return new LucidBillingStore(models);
}
