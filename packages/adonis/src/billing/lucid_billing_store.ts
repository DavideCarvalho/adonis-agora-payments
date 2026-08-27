import type { NormalizeConstructor } from '@adonisjs/core/types/helpers';
import { DateTime } from 'luxon';
import type {
  BillingCountQuery,
  BillingListQuery,
  BillingStore,
  PaymentListItem,
  WebhookEventBreakdownLine,
  WebhookEventListItem,
} from './billing_store.js';
import { clampLimit, clampOffset } from './list_query.js';
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

/** Lucid hands back Luxon `DateTime`s; the read SPI speaks plain `Date`. */
function toDate(value: DateTime | null | undefined): Date | null {
  return value ? value.toJSDate() : null;
}

/**
 * Read a single aggregate row.
 *
 * Every aggregate query below must go through `.pojo()`. A model query builder hydrates
 * its rows into model INSTANCES, and a value with no matching column — `count(*) as total`
 * — is not assigned to the instance; it is tucked into `$extras`. Reading `row.total` off
 * the instance therefore yields `undefined`, which `?? 0` then turns into a confident,
 * silent zero. `.pojo()` opts out of hydration and hands back the raw row.
 *
 * Counts also come back as strings on some drivers (Postgres `bigint`), hence the `Number`.
 */
function toCount(rows: unknown): number {
  const first = (rows as Array<{ total?: string | number }> | undefined)?.[0];
  return Number(first?.total ?? 0);
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

  async listPayments(query: BillingListQuery): Promise<PaymentListItem[]> {
    const builder = this.#paymentModel.query().orderBy('created_at', 'desc');
    if (query.status !== undefined) builder.where('status', query.status);
    const rows = (await builder
      .limit(clampLimit(query.limit))
      .offset(clampOffset(query.offset))) as PaymentInstance[];
    return rows.map((row) => ({
      id: String(row.id),
      gatewayId: row.gatewayId,
      provider: row.provider,
      status: row.status,
      amount: Number(row.amount),
      currency: row.currency,
      customerId: row.customerId ?? null,
      subscriptionId: row.subscriptionId ?? null,
      paidAt: toDate(row.paidAt),
      createdAt: toDate(row.createdAt),
    }));
  }

  async countPayments(query: BillingCountQuery): Promise<number> {
    const builder = this.#paymentModel.query().count('* as total').pojo();
    if (query.status !== undefined) builder.where('status', query.status);
    if (query.createdBefore !== undefined) builder.where('created_at', '<', query.createdBefore);
    if (query.createdAfter !== undefined) builder.where('created_at', '>=', query.createdAfter);
    return toCount(await builder);
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

  async listWebhookEvents(query: BillingListQuery): Promise<WebhookEventListItem[]> {
    const builder = this.#webhookEventModel.query().orderBy('created_at', 'desc');
    if (query.status !== undefined) builder.where('status', query.status);
    const rows = (await builder
      .limit(clampLimit(query.limit))
      .offset(clampOffset(query.offset))) as WebhookEventInstance[];
    return rows.map((row) => ({
      id: String(row.id),
      gatewayEventId: row.gatewayEventId,
      provider: row.provider,
      type: row.type,
      status: row.status,
      error: row.error ?? null,
      createdAt: toDate(row.createdAt),
      updatedAt: toDate(row.updatedAt),
    }));
  }

  async findWebhookEventByGatewayEventId(
    gatewayEventId: string,
  ): Promise<WebhookEventListItem | null> {
    const row = (await this.#webhookEventModel.findBy(
      'gateway_event_id',
      gatewayEventId,
    )) as WebhookEventInstance | null;
    if (!row) return null;
    return {
      id: String(row.id),
      gatewayEventId: row.gatewayEventId,
      provider: row.provider,
      type: row.type,
      status: row.status,
      error: row.error ?? null,
      createdAt: toDate(row.createdAt),
      updatedAt: toDate(row.updatedAt),
    };
  }

  async countWebhookEvents(query: BillingCountQuery): Promise<number> {
    const builder = this.#webhookEventModel.query().count('* as total').pojo();
    if (query.status !== undefined) builder.where('status', query.status);
    if (query.createdBefore !== undefined) builder.where('created_at', '<', query.createdBefore);
    if (query.createdAfter !== undefined) builder.where('created_at', '>=', query.createdAfter);
    return toCount(await builder);
  }

  async webhookEventBreakdown(query: BillingCountQuery): Promise<WebhookEventBreakdownLine[]> {
    const builder = this.#webhookEventModel
      .query()
      .select('provider', 'type')
      .count('* as total')
      .groupBy('provider', 'type')
      .orderBy('total', 'desc')
      .pojo();
    if (query.status !== undefined) builder.where('status', query.status);
    if (query.createdBefore !== undefined) builder.where('created_at', '<', query.createdBefore);
    if (query.createdAfter !== undefined) builder.where('created_at', '>=', query.createdAfter);
    // Through `unknown`: the query builder is typed as yielding model instances, but a
    // grouped `select(...).count(...)` yields aggregate rows, which do not overlap with it.
    const rows = (await builder) as unknown as Array<{
      provider: string;
      type: string;
      total: string | number;
    }>;
    return rows.map((row) => ({
      provider: row.provider,
      type: row.type,
      count: Number(row.total),
    }));
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
      .groupBy('meter')
      .pojo();
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
    const builder = this.#paymentModel
      .query()
      .where('status', 'paid')
      .sum('amount as total')
      .pojo();
    if (query.from !== undefined) builder.where('paid_at', '>=', query.from);
    if (query.to !== undefined) builder.where('paid_at', '<', query.to);
    return toCount(await builder);
  }

  async countActiveSubscriptions(): Promise<number> {
    return toCount(
      await this.#subscriptionModel
        .query()
        .whereIn('status', ['active', 'trialing'])
        .count('* as total')
        .pojo(),
    );
  }
}

/** Builder matching the authkit `lucidStores(...)` convention. */
export function lucidBillingStore(models: BillingModels = {}): BillingStore {
  return new LucidBillingStore(models);
}
