import {
  type AuditEventCountQuery,
  type AuditEventListItem,
  type AuditEventQuery,
  type BillingCountQuery,
  type BillingListQuery,
  type BillingStore,
  type CustomerListItem,
  type CustomerListQuery,
  type DisputeDeadlineQuery,
  type DisputeListItem,
  OPEN_DISPUTE_STATUSES,
  type OpenDisputeQuery,
  type PaymentListItem,
  type PaymentListQuery,
  type SubscriptionListItem,
  type WebhookEventBreakdownLine,
  type WebhookEventListItem,
  type WebhookEventListQuery,
} from '../billing/billing_store.js';
import { clampLimit, clampOffset } from '../billing/list_query.js';

/** Is this status one that still needs an answer? Shares the constant with the Lucid store. */
function isOpenDispute(status: string): boolean {
  return (OPEN_DISPUTE_STATUSES as readonly string[]).includes(status);
}

/** One dispute row, normalized for reading — the same shape the Lucid store returns. */
function disputeItem(row: InMemoryDisputeRow): DisputeListItem {
  return {
    id: row.id,
    gatewayId: row.gatewayId,
    paymentGatewayId: row.paymentGatewayId,
    provider: row.provider,
    status: row.status,
    reason: row.reason,
    amount: row.amount,
    currency: row.currency,
    evidenceDueBy: row.evidenceDueBy,
    outcome: row.outcome,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
  };
}

/** One audit row, normalized for reading — the same shape the Lucid store returns. */
function auditItem(row: InMemoryAuditEventRow): AuditEventListItem {
  return {
    id: row.id,
    action: row.action,
    actor: row.actor,
    provider: row.provider,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    amount: row.amount,
    currency: row.currency,
    message: row.message,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

/** One ledger row, normalized for reading. The stored payload is NEVER part of it. */
function webhookEventItem(row: InMemoryWebhookEventRow): WebhookEventListItem {
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

/** One customer-mapping row, normalized for reading — the same shape the Lucid store returns. */
function customerItem(row: InMemoryCustomerRow): CustomerListItem {
  return {
    id: row.id,
    gatewayId: row.gatewayId,
    provider: row.provider,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    email: row.email,
    name: row.name,
    taxId: row.taxId,
    createdAt: row.createdAt,
  };
}

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
  /** Integer minor units refunded so far. See `BillingPayment.refundedAmount`. */
  refundedAmount: number | null;
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

/** A plain in-memory dispute row (mirrors the Lucid model's columns). */
export interface InMemoryDisputeRow {
  id: string;
  /** The DISPUTE's own gateway id — or the synthesized one, for a gateway that sends none. */
  gatewayId: string;
  /** The disputed payment's gateway id — the join back to the payments map. */
  paymentGatewayId: string;
  provider: string;
  status: string;
  reason: string | null;
  amount: number | null;
  currency: string | null;
  evidenceDueBy: Date | null;
  outcome: string | null;
  openedAt: Date | null;
  closedAt: Date | null;
  payload: Record<string, unknown>;
  /** Insertion timestamp — the Lucid row has one, and the list query orders by it. */
  createdAt: Date;
}

/** A plain in-memory audit row (mirrors `billing_audit_events`). */
export interface InMemoryAuditEventRow {
  id: string;
  action: string;
  actor: string | null;
  provider: string | null;
  subjectType: string | null;
  subjectId: string | null;
  amount: number | null;
  currency: string | null;
  message: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
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
      InMemoryCustomerRow,
      InMemoryDisputeRow
    >
{
  customers: Map<string, InMemoryCustomerRow> = new Map();
  subscriptions: Map<string, InMemorySubscriptionRow> = new Map();
  payments: Map<string, InMemoryPaymentRow> = new Map();
  webhookEvents: Map<string, InMemoryWebhookEventRow> = new Map();
  usageEvents: Map<string, InMemoryUsageEventRow> = new Map();
  /** Keyed by the DISPUTE's gateway id, mirroring the table's unique column. */
  disputes: Map<string, InMemoryDisputeRow> = new Map();
  /** Append-only, like the table — keyed by the row's own id, because nothing looks one up. */
  auditEvents: Map<string, InMemoryAuditEventRow> = new Map();

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

  async listCustomers(query: CustomerListQuery): Promise<CustomerListItem[]> {
    const matching = [...this.customers.values()].filter(
      (row) =>
        (query.provider === undefined || row.provider === query.provider) &&
        (query.ownerType === undefined || row.ownerType === query.ownerType) &&
        (query.ownerId === undefined || row.ownerId === query.ownerId) &&
        (query.gatewayId === undefined || row.gatewayId === query.gatewayId),
    );
    return this.#page(matching, query).map(customerItem);
  }

  async listCustomersByGatewayIds(gatewayIds: readonly string[]): Promise<CustomerListItem[]> {
    if (gatewayIds.length === 0) return [];
    const wanted = new Set(gatewayIds);
    return [...this.customers.values()]
      .filter((row) => wanted.has(row.gatewayId))
      .map(customerItem);
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
    refundedAmount?: number | null;
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
      // Mirrors the Lucid store again, and this one is about money: `payment.refunded`,
      // `payment.disputed` and `payment.dispute_closed` all save WITHOUT a `paidAt`, and
      // `revenue()` filters on it. Writing `undefined` through as `null` erased the only
      // record of when a charge landed, so a dispute closed as WON came back as `paid` with no
      // date and left every windowed revenue figure. `null` still clears it.
      paidAt: payment.paidAt !== undefined ? payment.paidAt : (existing?.paidAt ?? null),
      refundedAmount:
        payment.refundedAmount !== undefined
          ? payment.refundedAmount
          : (existing?.refundedAmount ?? null),
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

  async listPayments(query: PaymentListQuery): Promise<PaymentListItem[]> {
    const matching = [...this.payments.values()].filter(
      (row) =>
        (query.status === undefined || row.status === query.status) &&
        (query.provider === undefined || row.provider === query.provider) &&
        (query.gatewayId === undefined || row.gatewayId === query.gatewayId) &&
        (query.customerId === undefined || row.customerId === query.customerId) &&
        // EXACT, like the Lucid store's `where('external_reference', ?)`. A substring match
        // here would make `order-4` return `order-42` in tests and not in production.
        (query.externalReference === undefined ||
          row.externalReference === query.externalReference),
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
      refundedAmount: row.refundedAmount,
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

  async saveDispute(dispute: {
    gatewayId: string;
    paymentGatewayId: string;
    provider: string;
    status: string;
    reason?: string | null;
    amount?: number | null;
    currency?: string | null;
    evidenceDueBy?: Date | null;
    outcome?: string | null;
    openedAt?: Date | null;
    closedAt?: Date | null;
    payload?: Record<string, unknown>;
  }): Promise<InMemoryDisputeRow> {
    const existing = this.disputes.get(dispute.gatewayId);
    const row: InMemoryDisputeRow = existing ?? {
      id: `dis_${this.#nextId++}`,
      gatewayId: dispute.gatewayId,
      paymentGatewayId: dispute.paymentGatewayId,
      provider: dispute.provider,
      status: dispute.status,
      reason: null,
      amount: null,
      currency: null,
      evidenceDueBy: null,
      outcome: null,
      // Stamped once, on insert, and never moved afterwards — mirrors the Lucid store, where
      // re-stamping it on a later event would make every dispute look brand new.
      openedAt: dispute.openedAt ?? this.#now(),
      closedAt: null,
      payload: {},
      createdAt: this.#now(),
    };
    row.paymentGatewayId = dispute.paymentGatewayId;
    row.provider = dispute.provider;
    row.status = dispute.status;
    // Absent does NOT erase — mirrors the Lucid store: the event that opens a dispute carries
    // the deadline and the reason, and the one that closes it carries neither.
    if (dispute.reason !== undefined) row.reason = dispute.reason;
    if (dispute.amount !== undefined) row.amount = dispute.amount;
    if (dispute.currency !== undefined) row.currency = dispute.currency;
    if (dispute.evidenceDueBy !== undefined) row.evidenceDueBy = dispute.evidenceDueBy;
    if (dispute.outcome !== undefined) row.outcome = dispute.outcome;
    if (dispute.closedAt !== undefined) row.closedAt = dispute.closedAt;
    if (existing !== undefined && existing.openedAt === null) {
      row.openedAt = dispute.openedAt ?? this.#now();
    }
    if (dispute.payload !== undefined) row.payload = dispute.payload;
    this.disputes.set(dispute.gatewayId, row);
    return row;
  }

  async findDisputeByGatewayId(gatewayId: string): Promise<InMemoryDisputeRow | null> {
    return this.disputes.get(gatewayId) ?? null;
  }

  async findOpenDisputeByPayment(paymentGatewayId: string): Promise<InMemoryDisputeRow | null> {
    // Newest first, like the Lucid store's `order by created_at desc`; insertion order breaks
    // ties, because several rows inside one millisecond is the normal case in a test.
    let found: InMemoryDisputeRow | null = null;
    for (const row of this.disputes.values()) {
      if (row.paymentGatewayId !== paymentGatewayId) continue;
      if (!isOpenDispute(row.status)) continue;
      if (found === null || row.createdAt >= found.createdAt) found = row;
    }
    return found;
  }

  async listDisputes(query: BillingListQuery): Promise<DisputeListItem[]> {
    const matching = [...this.disputes.values()].filter(
      (row) =>
        (query.status === undefined || row.status === query.status) &&
        (query.provider === undefined || row.provider === query.provider),
    );
    return this.#page(matching, query).map(disputeItem);
  }

  async countDisputes(query: BillingCountQuery): Promise<number> {
    let count = 0;
    for (const row of this.disputes.values()) {
      if (this.#matchesCount(row, query)) count += 1;
    }
    return count;
  }

  async listDisputesDueWithin(query: DisputeDeadlineQuery): Promise<DisputeListItem[]> {
    const matching = this.#dueWithin(query)
      // Soonest first — the priority order, not the arrival order. The only list here that
      // is not newest-first, and it mirrors the Lucid store's `order by evidence_due_by asc`.
      .sort((a, b) => (a.evidenceDueBy?.getTime() ?? 0) - (b.evidenceDueBy?.getTime() ?? 0));
    const offset = clampOffset(query.offset);
    return matching.slice(offset, offset + clampLimit(query.limit)).map(disputeItem);
  }

  async countDisputesDueWithin(
    query: Omit<DisputeDeadlineQuery, 'limit' | 'offset'>,
  ): Promise<number> {
    return this.#dueWithin(query).length;
  }

  /**
   * The open disputes whose window closes by `now + withinHours`.
   *
   * No lower bound: a deadline that has already passed is still open and still unanswered,
   * and dropping it the moment it expires would make the alert go quiet exactly when it
   * became true. Rows with no deadline are excluded — nothing to be late for.
   */
  #dueWithin(query: Omit<DisputeDeadlineQuery, 'limit' | 'offset'>): InMemoryDisputeRow[] {
    const now = query.now ?? this.#now();
    const cutoff = now.getTime() + query.withinHours * 3_600_000;
    return [...this.disputes.values()].filter(
      (row) =>
        isOpenDispute(row.status) &&
        row.evidenceDueBy !== null &&
        row.evidenceDueBy.getTime() <= cutoff &&
        (query.provider === undefined || row.provider === query.provider),
    );
  }

  async listOpenDisputes(query: OpenDisputeQuery): Promise<DisputeListItem[]> {
    const matching = [...this.disputes.values()]
      .filter(
        (row) =>
          isOpenDispute(row.status) &&
          (query.provider === undefined || row.provider === query.provider),
      )
      // Oldest FIRST — mirrors the Lucid store's `order by created_at asc`. With no deadline
      // to rank on, how long a dispute has gone unanswered is the only priority left.
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const offset = clampOffset(query.offset);
    return matching.slice(offset, offset + clampLimit(query.limit)).map(disputeItem);
  }

  async countOpenDisputes(query: { provider?: string }): Promise<number> {
    let count = 0;
    for (const row of this.disputes.values()) {
      if (!isOpenDispute(row.status)) continue;
      if (query.provider !== undefined && row.provider !== query.provider) continue;
      count += 1;
    }
    return count;
  }

  async recordAuditEvent(event: {
    action: string;
    actor?: string | null;
    provider?: string | null;
    subjectType?: string | null;
    subjectId?: string | null;
    amount?: number | null;
    currency?: string | null;
    message?: string | null;
    metadata?: Record<string, unknown> | null;
    createdAt?: Date;
  }): Promise<AuditEventListItem> {
    const row: InMemoryAuditEventRow = {
      id: `audit_${this.#nextId++}`,
      action: event.action,
      actor: event.actor ?? null,
      provider: event.provider ?? null,
      subjectType: event.subjectType ?? null,
      subjectId: event.subjectId ?? null,
      amount: event.amount ?? null,
      currency: event.currency ?? null,
      message: event.message ?? null,
      metadata: event.metadata ?? null,
      createdAt: event.createdAt ?? this.#now(),
    };
    this.auditEvents.set(row.id, row);
    return auditItem(row);
  }

  async listAuditEvents(query: AuditEventQuery): Promise<AuditEventListItem[]> {
    const matching = [...this.auditEvents.values()].filter((row) => this.#matchesAudit(row, query));
    return this.#page(matching, query).map(auditItem);
  }

  async countAuditEvents(query: AuditEventCountQuery): Promise<number> {
    let count = 0;
    for (const row of this.auditEvents.values()) {
      if (this.#matchesAudit(row, query)) count += 1;
    }
    return count;
  }

  /** One filter for the list and the count — see `#matchesCount`: a bound only one of them
   *  applied is how an alert learns to report a healthy zero. */
  #matchesAudit(row: InMemoryAuditEventRow, query: AuditEventCountQuery): boolean {
    if (query.action !== undefined && row.action !== query.action) return false;
    if (query.actions !== undefined && !query.actions.includes(row.action)) return false;
    if (query.actor !== undefined && row.actor !== query.actor) return false;
    if (query.provider !== undefined && row.provider !== query.provider) return false;
    if (query.subjectType !== undefined && row.subjectType !== query.subjectType) return false;
    if (query.subjectId !== undefined && row.subjectId !== query.subjectId) return false;
    if (query.createdBefore !== undefined && row.createdAt >= query.createdBefore) return false;
    if (query.createdAfter !== undefined && row.createdAt < query.createdAfter) return false;
    return true;
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

  async listWebhookEvents(query: WebhookEventListQuery): Promise<WebhookEventListItem[]> {
    const matching = [...this.webhookEvents.values()].filter(
      (row) =>
        (query.status === undefined || row.status === query.status) &&
        (query.provider === undefined || row.provider === query.provider) &&
        (query.type === undefined || row.type === query.type),
    );
    return this.#page(matching, query).map(webhookEventItem);
  }

  async listWebhookEventsForPayment(
    paymentGatewayId: string,
    query: { limit?: number } = {},
  ): Promise<WebhookEventListItem[]> {
    if (paymentGatewayId === '') return [];
    // Mirrors the Lucid store's `CAST(payload AS TEXT) LIKE '%id%'`, substring semantics and
    // all — including the false positives. A test that matched more precisely here than the
    // database can would be testing a store nobody ships.
    const matching = [...this.webhookEvents.values()].filter((row) =>
      JSON.stringify(row.payload).includes(paymentGatewayId),
    );
    return this.#page(matching, query.limit === undefined ? {} : { limit: query.limit }).map(
      webhookEventItem,
    );
  }

  async findWebhookEventByGatewayEventId(
    gatewayEventId: string,
  ): Promise<WebhookEventListItem | null> {
    const row = this.webhookEvents.get(gatewayEventId);
    if (!row) return null;
    return webhookEventItem(row);
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
      // A row with NO `paid_at` is in no window at all. The Lucid store emits
      // `paid_at >= from AND paid_at < to`, and SQL `NULL` satisfies neither comparison — so
      // counting it here would make the in-memory store report revenue the database cannot,
      // and would hide the exact bug (a won dispute restored with `paid_at = NULL`) that the
      // leave-alone rule in `savePayment` exists to prevent.
      const windowed = query.from !== undefined || query.to !== undefined;
      if (windowed && row.paidAt === null) continue;
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
