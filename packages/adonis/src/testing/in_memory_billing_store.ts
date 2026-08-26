import type { BillingStore } from '../billing/billing_store.js';

/** A minimal in-memory row shape (mirrors the Lucid models' columns). */
export interface InMemorySubscriptionRow {
  id: string;
  gatewayId: string;
  provider: string;
  customerId: string;
  status: string;
  planId: string;
  trialEndsAt: Date | null;
  endsAt: Date | null;
  payload: Record<string, unknown>;
}

export interface InMemoryPaymentRow {
  id: string;
  gatewayId: string;
  provider: string;
  status: string;
  amount: number;
  currency: string;
  customerId: string | null;
  subscriptionId: string | null;
  paidAt: Date | null;
  payload: Record<string, unknown>;
}

export interface InMemoryWebhookEventRow {
  id: string;
  gatewayEventId: string;
  provider: string;
  type: string;
  status: 'received' | 'processed' | 'failed';
  payload: Record<string, unknown>;
  error: string | null;
}

/** A plain in-memory metered-usage row (mirrors the Lucid model's columns). */
export interface InMemoryUsageEventRow {
  id: string;
  subscriptionId: string | null;
  customerId: string | null;
  meter: string;
  quantity: number;
  metadata?: Record<string, unknown>;
  recordedAt: Date;
}

/**
 * In-memory {@link BillingStore} for tests — no database required. Mirrors the shape of
 * the Lucid models so the billing layer behaves identically.
 */
export class InMemoryBillingStore
  implements
    BillingStore<
      InMemorySubscriptionRow,
      InMemoryPaymentRow,
      InMemoryWebhookEventRow,
      InMemoryUsageEventRow
    >
{
  subscriptions: Map<string, InMemorySubscriptionRow> = new Map();
  payments: Map<string, InMemoryPaymentRow> = new Map();
  webhookEvents: Map<string, InMemoryWebhookEventRow> = new Map();
  usageEvents: Map<string, InMemoryUsageEventRow> = new Map();

  #nextId = 1;

  async saveSubscription(sub: {
    gatewayId: string;
    provider: string;
    customerId: string;
    status: string;
    planId: string;
    trialEndsAt?: Date | null;
    endsAt?: Date | null;
    payload?: Record<string, unknown>;
  }): Promise<InMemorySubscriptionRow> {
    const existing = this.subscriptions.get(sub.gatewayId);
    const row: InMemorySubscriptionRow = {
      id: existing?.id ?? `sub_${this.#nextId++}`,
      gatewayId: sub.gatewayId,
      provider: sub.provider,
      customerId: sub.customerId,
      status: sub.status,
      planId: sub.planId,
      trialEndsAt: sub.trialEndsAt ?? null,
      endsAt: sub.endsAt ?? null,
      payload: sub.payload ?? {},
    };
    this.subscriptions.set(sub.gatewayId, row);
    return row;
  }

  async findSubscriptionByGatewayId(gatewayId: string): Promise<InMemorySubscriptionRow | null> {
    return this.subscriptions.get(gatewayId) ?? null;
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
  }): Promise<InMemoryPaymentRow> {
    const existing = this.payments.get(payment.gatewayId);
    const row: InMemoryPaymentRow = {
      id: existing?.id ?? `pay_${this.#nextId++}`,
      gatewayId: payment.gatewayId,
      provider: payment.provider,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      customerId: payment.customerId ?? null,
      subscriptionId: payment.subscriptionId ?? null,
      paidAt: payment.paidAt ?? null,
      payload: payment.payload ?? {},
    };
    this.payments.set(payment.gatewayId, row);
    return row;
  }

  async findPaymentByGatewayId(gatewayId: string): Promise<InMemoryPaymentRow | null> {
    return this.payments.get(gatewayId) ?? null;
  }

  async recordWebhookEvent(event: {
    gatewayEventId: string;
    provider: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<InMemoryWebhookEventRow | null> {
    const existing = this.webhookEvents.get(event.gatewayEventId);
    if (existing) return null;
    const row: InMemoryWebhookEventRow = {
      id: `wh_${this.#nextId++}`,
      gatewayEventId: event.gatewayEventId,
      provider: event.provider,
      type: event.type,
      status: 'received',
      payload: event.payload,
      error: null,
    };
    this.webhookEvents.set(event.gatewayEventId, row);
    return row;
  }

  async markWebhookProcessed(id: string): Promise<void> {
    for (const row of this.webhookEvents.values()) {
      if (row.id === id) {
        row.status = 'processed';
        return;
      }
    }
  }

  async markWebhookFailed(id: string, error: string): Promise<void> {
    for (const row of this.webhookEvents.values()) {
      if (row.id === id) {
        row.status = 'failed';
        row.error = error;
        return;
      }
    }
  }

  async recordUsage(event: {
    subscriptionId?: string | null;
    customerId?: string;
    meter: string;
    quantity: number;
    metadata?: Record<string, unknown>;
    recordedAt?: Date;
  }): Promise<InMemoryUsageEventRow> {
    const row: InMemoryUsageEventRow = {
      id: `usage_${this.#nextId++}`,
      subscriptionId: event.subscriptionId ?? null,
      customerId: event.customerId ?? null,
      meter: event.meter,
      quantity: event.quantity,
      ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
      recordedAt: event.recordedAt ?? new Date(),
    };
    this.usageEvents.set(row.id, row);
    return row;
  }

  async usageReport(query: {
    subscriptionId?: string;
    customerId?: string;
    meter?: string;
    from?: Date;
    to?: Date;
  }): Promise<Array<{ meter: string; quantity: number }>> {
    const totals = new Map<string, number>();
    for (const row of this.usageEvents.values()) {
      if (query.subscriptionId !== undefined && row.subscriptionId !== query.subscriptionId)
        continue;
      if (query.customerId !== undefined && row.customerId !== query.customerId) {
        continue;
      }
      if (query.meter !== undefined && row.meter !== query.meter) continue;
      if (query.from !== undefined && row.recordedAt < query.from) continue;
      if (query.to !== undefined && row.recordedAt >= query.to) continue;
      totals.set(row.meter, (totals.get(row.meter) ?? 0) + row.quantity);
    }
    return [...totals.entries()].map(([meter, quantity]) => ({ meter, quantity }));
  }
}
