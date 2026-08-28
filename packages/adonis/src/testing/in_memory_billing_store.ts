import type {
  BillingCountQuery,
  BillingListQuery,
  BillingStore,
  CustomerListItem,
  PaymentListItem,
  SubscriptionListItem,
  WebhookEventBreakdownLine,
  WebhookEventListItem,
} from '../billing/billing_store.js';
import { clampLimit, clampOffset } from '../billing/list_query.js';

/** A plain in-memory customer-mapping row (mirrors the Lucid model's columns). */
export interface InMemoryCustomerRow {
  id: string;
  gatewayId: string;
  provider: string;
  ownerType: string | null;
  ownerId: string | null;
  email: string | null;
  name: string | null;
  taxId: string | null;
  metadata: Record<string, unknown> | null;
  /** Insertion timestamp — the Lucid rows have one, and the list query orders by it. */
  createdAt: Date;
}

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
  /** Insertion timestamp — the Lucid row has one, and the list query orders by it. */
  createdAt: Date;
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
  /** The app's own id for this charge, as the gateway echoed it back. */
  externalReference: string | null;
  paidAt: Date | null;
  payload: Record<string, unknown>;
  /** Insertion timestamp — the Lucid rows have one, and the list queries order by it. */
  createdAt: Date;
}

export interface InMemoryWebhookEventRow {
  id: string;
  gatewayEventId: string;
  provider: string;
  type: string;
  status: 'received' | 'processed' | 'failed';
  payload: Record<string, unknown>;
  /** The normalized event this delivery carried — what the dashboard's retry replays. */
  normalized: Record<string, unknown> | null;
  error: string | null;
  /** Insertion timestamp — the Lucid rows have one, and the list queries order by it. */
  createdAt: Date;
  /** Last-write timestamp, bumped by `markWebhookProcessed`/`markWebhookFailed`. */
  updatedAt: Date;
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
      InMemoryUsageEventRow,
      InMemoryCustomerRow
    >
{
  customers: Map<string, InMemoryCustomerRow> = new Map();
  subscriptions: Map<string, InMemorySubscriptionRow> = new Map();
  payments: Map<string, InMemoryPaymentRow> = new Map();
  webhookEvents: Map<string, InMemoryWebhookEventRow> = new Map();
  usageEvents: Map<string, InMemoryUsageEventRow> = new Map();

  #nextId = 1;

  /** Overridable clock so a test can pin `createdAt`/`updatedAt`. Defaults to the wall clock. */
  now: () => Date = () => new Date();

  #now(): Date {
    return this.now();
  }

  /**
   * The `BillingCountQuery` filter, applied identically for both count/breakdown reads.
   *
   * A window the store silently ignored would report a healthy zero, which is the one wrong
   * answer an alert must never get — so both bounds are applied here, in one place, rather
   * than re-derived per method.
   */
  #matchesCount(row: { status: string; createdAt: Date }, query: BillingCountQuery): boolean {
    if (query.status !== undefined && row.status !== query.status) return false;
    if (query.createdBefore !== undefined && row.createdAt >= query.createdBefore) return false;
    if (query.createdAfter !== undefined && row.createdAt < query.createdAfter) return false;
    return true;
  }

  /**
   * Newest first: `createdAt` descending, ties broken by insertion order descending.
   *
   * The tie-break matters — several rows written inside the same millisecond is the normal
   * case in a test, and `sort` alone would leave them in whatever order the map yields.
   * `Array.prototype.sort` is stable, so reversing first and sorting after gives
   * last-inserted-first within a tie. Mirrors the Lucid store's `order by created_at desc`.
   */
  #page<Row extends { createdAt: Date }>(rows: Iterable<Row>, query: BillingListQuery): Row[] {
    const sorted = [...rows]
      .reverse()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const offset = clampOffset(query.offset);
    return sorted.slice(offset, offset + clampLimit(query.limit));
  }

  async saveCustomer(customer: {
    gatewayId: string;
    provider: string;
    ownerType?: string | null;
    ownerId?: string | null;
    email?: string | null;
    name?: string | null;
    taxId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<InMemoryCustomerRow> {
    const existing = this.customers.get(customer.gatewayId);
    const row: InMemoryCustomerRow = existing ?? {
      id: String(this.#nextId++),
      gatewayId: customer.gatewayId,
      provider: customer.provider,
      ownerType: null,
      ownerId: null,
      email: null,
      name: null,
      taxId: null,
      metadata: null,
      createdAt: this.#now(),
    };
    row.provider = customer.provider;
    // Absent fields do NOT erase what is already recorded — mirrors the Lucid store, where
    // a later, less-informed call must not blank the owner mapping an earlier one wrote.
    if (customer.ownerType !== undefined) row.ownerType = customer.ownerType;
    if (customer.ownerId !== undefined) row.ownerId = customer.ownerId;
    if (customer.email !== undefined) row.email = customer.email;
    if (customer.name !== undefined) row.name = customer.name;
    if (customer.taxId !== undefined) row.taxId = customer.taxId;
    if (customer.metadata !== undefined) row.metadata = customer.metadata;
    this.customers.set(customer.gatewayId, row);
    return row;
  }

  async findCustomerByGatewayId(gatewayId: string): Promise<InMemoryCustomerRow | null> {
    return this.customers.get(gatewayId) ?? null;
  }

  async findCustomerByOwner(
    ownerType: string,
    ownerId: string,
    provider: string,
  ): Promise<InMemoryCustomerRow | null> {
    for (const row of this.customers.values()) {
      if (row.ownerType === ownerType && row.ownerId === ownerId && row.provider === provider) {
        return row;
      }
    }
    return null;
  }

  async listCustomers(
    query: BillingListQuery & { provider?: string },
  ): Promise<CustomerListItem[]> {
    const matching = [...this.customers.values()].filter(
      (row) => query.provider === undefined || row.provider === query.provider,
    );
    return this.#page(matching, query).map((row) => ({
      id: row.id,
      gatewayId: row.gatewayId,
      provider: row.provider,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      email: row.email,
      name: row.name,
      taxId: row.taxId,
      createdAt: row.createdAt,
    }));
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
      // Preserved across upserts: a subscription's creation time is when it was FIRST
      // recorded, not when its status last changed, or every update would reorder the list.
      createdAt: existing?.createdAt ?? this.#now(),
    };
    this.subscriptions.set(sub.gatewayId, row);
    return row;
  }

  async listSubscriptions(query: BillingListQuery): Promise<SubscriptionListItem[]> {
    const matching = [...this.subscriptions.values()].filter(
      (row) =>
        (query.status === undefined || row.status === query.status) &&
        (query.provider === undefined || row.provider === query.provider),
    );
    return this.#page(matching, query).map((row) => ({
      id: row.id,
      gatewayId: row.gatewayId,
      provider: row.provider,
      status: row.status,
      planId: row.planId,
      customerId: row.customerId ?? null,
      trialEndsAt: row.trialEndsAt,
      endsAt: row.endsAt,
      createdAt: row.createdAt,
    }));
  }

  async countSubscriptions(query: BillingCountQuery): Promise<number> {
    let count = 0;
    for (const row of this.subscriptions.values()) {
      if (this.#matchesCount(row, query)) count += 1;
    }
    return count;
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
    externalReference?: string | null;
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
      // Mirrors the Lucid store: an ABSENT reference keeps the stored one. `payment.refunded`
      // and `payment.disputed` routinely carry no reference, and blanking it there would throw
      // away the only key `findPaymentByExternalReference` can route on. `null` still clears.
      externalReference:
        payment.externalReference !== undefined
          ? payment.externalReference
          : (existing?.externalReference ?? null),
      paidAt: payment.paidAt ?? null,
      payload: payment.payload ?? {},
      createdAt: existing?.createdAt ?? this.#now(),
    };
    this.payments.set(payment.gatewayId, row);
    return row;
  }

  async findPaymentByGatewayId(gatewayId: string): Promise<InMemoryPaymentRow | null> {
    return this.payments.get(gatewayId) ?? null;
  }

  async findPaymentByExternalReference(reference: string): Promise<InMemoryPaymentRow | null> {
    // Newest first, like the Lucid store's `order by created_at desc`: an app may reuse a
    // reference across retries, and the row it means is the most recent one. Insertion order
    // breaks ties — several rows inside one millisecond is the normal case in a test.
    let found: InMemoryPaymentRow | null = null;
    for (const row of this.payments.values()) {
      if (row.externalReference !== reference) continue;
      if (found === null || row.createdAt >= found.createdAt) found = row;
    }
    return found;
  }

  async listPayments(query: BillingListQuery): Promise<PaymentListItem[]> {
    const matching = [...this.payments.values()].filter(
      (row) =>
        (query.status === undefined || row.status === query.status) &&
        (query.provider === undefined || row.provider === query.provider),
    );
    return this.#page(matching, query).map((row) => ({
      id: row.id,
      gatewayId: row.gatewayId,
      provider: row.provider,
      status: row.status,
      amount: row.amount,
      currency: row.currency,
      customerId: row.customerId,
      subscriptionId: row.subscriptionId,
      externalReference: row.externalReference,
      paidAt: row.paidAt,
      createdAt: row.createdAt,
    }));
  }

  async countPayments(query: BillingCountQuery): Promise<number> {
    let count = 0;
    for (const row of this.payments.values()) {
      if (this.#matchesCount(row, query)) count += 1;
    }
    return count;
  }

  async recordWebhookEvent(event: {
    gatewayEventId: string;
    provider: string;
    type: string;
    payload: Record<string, unknown>;
    normalized?: unknown;
  }): Promise<InMemoryWebhookEventRow | null> {
    const existing = this.webhookEvents.get(event.gatewayEventId);
    if (existing) {
      // Mirrors LucidBillingStore: a failed attempt is claimable again so the
      // retry re-runs; in-flight and processed events are redeliveries.
      if (existing.status !== 'failed') return null;
      existing.status = 'received';
      existing.error = null;
      // `payload` and `normalized` are deliberately NOT touched: the retry re-claims this row
      // precisely to read back what the original delivery recorded.
      existing.updatedAt = this.#now();
      return existing;
    }
    const now = this.#now();
    const normalized = event.normalized;
    const row: InMemoryWebhookEventRow = {
      id: `wh_${this.#nextId++}`,
      gatewayEventId: event.gatewayEventId,
      provider: event.provider,
      type: event.type,
      status: 'received',
      payload: event.payload,
      // Only an object shape survives the jsonb column in the Lucid store; anything else is
      // stored as `null` there, so it is `null` here too rather than a shape a test could pass
      // and production could not.
      normalized:
        typeof normalized === 'object' && normalized !== null && !Array.isArray(normalized)
          ? (normalized as Record<string, unknown>)
          : null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.webhookEvents.set(event.gatewayEventId, row);
    return row;
  }

  async markWebhookProcessed(id: string): Promise<void> {
    for (const row of this.webhookEvents.values()) {
      if (row.id === id) {
        row.status = 'processed';
        row.updatedAt = this.#now();
        return;
      }
    }
  }

  async markWebhookFailed(id: string, error: string): Promise<void> {
    for (const row of this.webhookEvents.values()) {
      if (row.id === id) {
        row.status = 'failed';
        row.error = error;
        row.updatedAt = this.#now();
        return;
      }
    }
  }

  async listWebhookEvents(query: BillingListQuery): Promise<WebhookEventListItem[]> {
    const matching = [...this.webhookEvents.values()].filter(
      (row) =>
        (query.status === undefined || row.status === query.status) &&
        (query.provider === undefined || row.provider === query.provider),
    );
    return this.#page(matching, query).map((row) => ({
      id: row.id,
      gatewayEventId: row.gatewayEventId,
      provider: row.provider,
      type: row.type,
      status: row.status,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async findWebhookEventByGatewayEventId(
    gatewayEventId: string,
  ): Promise<WebhookEventListItem | null> {
    const row = this.webhookEvents.get(gatewayEventId);
    if (!row) return null;
    return {
      id: row.id,
      gatewayEventId: row.gatewayEventId,
      provider: row.provider,
      type: row.type,
      status: row.status,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async countWebhookEvents(query: BillingCountQuery): Promise<number> {
    let count = 0;
    for (const row of this.webhookEvents.values()) {
      if (this.#matchesCount(row, query)) count += 1;
    }
    return count;
  }

  async webhookEventBreakdown(query: BillingCountQuery): Promise<WebhookEventBreakdownLine[]> {
    const totals = new Map<string, WebhookEventBreakdownLine>();
    for (const row of this.webhookEvents.values()) {
      if (!this.#matchesCount(row, query)) continue;
      const key = `${row.provider}\u0000${row.type}`;
      const line = totals.get(key);
      if (line) line.count += 1;
      else totals.set(key, { provider: row.provider, type: row.type, count: 1 });
    }
    return [...totals.values()].sort((a, b) => b.count - a.count);
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

  async revenue(query: { from?: Date; to?: Date }): Promise<number> {
    let total = 0;
    for (const row of this.payments.values()) {
      if (row.status !== 'paid') continue;
      if (query.from !== undefined && row.paidAt !== null && row.paidAt < query.from) continue;
      if (query.to !== undefined && row.paidAt !== null && row.paidAt >= query.to) continue;
      total += row.amount;
    }
    return total;
  }

  async countActiveSubscriptions(): Promise<number> {
    let count = 0;
    for (const row of this.subscriptions.values()) {
      if (row.status === 'active' || row.status === 'trialing') count += 1;
    }
    return count;
  }
}
