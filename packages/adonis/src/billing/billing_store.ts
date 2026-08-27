import type {
  BillingPayment,
  BillingSubscription,
  BillingUsageEvent,
  BillingWebhookEvent,
} from './mixins/index.js';

/**
 * One `billing_payments` row, normalized for reading.
 *
 * The write side of this SPI is generic over the row type (a Lucid model instance in one
 * implementation, a plain object in the other). A reader — the dashboard, a report — cannot
 * work against `PaymentRow` for that reason, so the LIST side returns this flat, plain
 * shape instead: every implementation normalizes into it, and no caller ever has to know
 * whether a Lucid model or a plain object produced it.
 *
 * `amount` is integer cents, like everywhere else in this package. Format at the edge.
 */
export interface PaymentListItem {
  id: string;
  gatewayId: string;
  provider: string;
  status: string;
  /** Integer cents — NEVER divide here. */
  amount: number;
  currency: string;
  customerId: string | null;
  subscriptionId: string | null;
  paidAt: Date | null;
  createdAt: Date | null;
}

/** One `billing_webhook_events` row, normalized for reading. See {@link PaymentListItem}. */
export interface WebhookEventListItem {
  id: string;
  gatewayEventId: string;
  provider: string;
  type: string;
  status: string;
  /** The handler's failure message when `status === 'failed'`; `null` otherwise. */
  error: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/**
 * One line of {@link BillingStore.webhookEventBreakdown} — how many ledger rows matched,
 * grouped by the two fields that identify WHAT is failing: which gateway, and which event.
 */
export interface WebhookEventBreakdownLine {
  provider: string;
  type: string;
  count: number;
}

/**
 * Filter for the count/breakdown reads — the operational questions ("how many events are
 * stuck?", "what failed in the last day?") that a page of rows cannot answer.
 *
 * Kept separate from {@link BillingListQuery} on purpose: a store that silently ignored a
 * window it did not implement would report a healthy zero, which is the one wrong answer an
 * alert must never get.
 */
export interface BillingCountQuery {
  /** Exact status match. Omit for every status. */
  status?: string;
  /** Only rows created strictly BEFORE this instant — "older than", for staleness checks. */
  createdBefore?: Date;
  /** Only rows created at or AFTER this instant — "within the last N", for recency checks. */
  createdAfter?: Date;
}

/** Filter + page for the two list queries. `limit`/`offset` are applied after the filter. */
export interface BillingListQuery {
  /** Exact status match. Omit for every status. */
  status?: string;
  limit?: number;
  offset?: number;
}

/**
 * The persistence SPI for the billing layer. The Lucid implementation writes through the
 * configured models; an in-memory implementation exists in `src/testing` so the billing
 * layer is unit-testable without a database.
 *
 * Generic over the row types so the in-memory store can use plain objects while the
 * Lucid store returns model instances.
 */
export interface BillingStore<
  SubscriptionRow = BillingSubscription,
  PaymentRow = BillingPayment,
  WebhookEventRow = BillingWebhookEvent,
  UsageEventRow = BillingUsageEvent,
> {
  // ── Subscriptions ────────────────────────────────────────────────────────────────

  /** Upsert a subscription keyed by gateway id. Returns the stored row. */
  saveSubscription(sub: {
    gatewayId: string;
    provider: string;
    customerId: string;
    status: string;
    planId: string;
    trialEndsAt?: Date | null;
    endsAt?: Date | null;
    payload?: Record<string, unknown>;
  }): Promise<SubscriptionRow>;

  findSubscriptionByGatewayId(gatewayId: string): Promise<SubscriptionRow | null>;

  // ── Payments ─────────────────────────────────────────────────────────────────────

  /** Upsert a payment keyed by gateway id. Returns the stored row. */
  savePayment(payment: {
    gatewayId: string;
    provider: string;
    status: string;
    amount: number;
    currency: string;
    customerId?: string | null;
    subscriptionId?: string | null;
    paidAt?: Date | null;
    payload?: Record<string, unknown>;
  }): Promise<PaymentRow>;

  findPaymentByGatewayId(gatewayId: string): Promise<PaymentRow | null>;

  /**
   * Page through recorded payments, newest first, optionally filtered by status.
   *
   * A narrow read the aggregates above cannot answer: `revenue()` sums, it does not say
   * WHICH payment failed. Returns the normalized {@link PaymentListItem}, not the
   * implementation's row type, so a reader never depends on Lucid.
   */
  listPayments(query: BillingListQuery): Promise<PaymentListItem[]>;

  /**
   * How many payments match a status and/or a creation window.
   *
   * The check this exists for: charges that were created and never confirmed
   * (`{ status: 'pending', createdBefore: twoHoursAgo }`). A webhook endpoint that stops
   * being reachable produces exactly that and nothing else in the system errors.
   */
  countPayments(query: BillingCountQuery): Promise<number>;

  // ── Webhook idempotency ledger ───────────────────────────────────────────────────

  /**
   * Record a webhook event for idempotency.
   *
   * Returns `null` when this gateway event is already in flight or already
   * processed — that is the guard that makes a gateway redelivery a no-op.
   *
   * An event whose previous attempt **failed** is claimed again and returned,
   * so a retry actually re-runs it. Without that, the first failure would seal
   * the ledger and every retry — in-process or durable — would short-circuit
   * into doing nothing.
   */
  recordWebhookEvent(event: {
    gatewayEventId: string;
    provider: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<WebhookEventRow | null>;

  markWebhookProcessed(id: string): Promise<void>;

  markWebhookFailed(id: string, error: string): Promise<void>;

  /**
   * Page through the ledger, newest first, optionally filtered by status.
   *
   * `status: 'failed'` is the operationally load-bearing one: a `failed` row means a
   * handler threw and the dispatcher gave up, so the event's effect never happened. It
   * carries the handler's `error`, which is the only place that message survives.
   */
  listWebhookEvents(query: BillingListQuery): Promise<WebhookEventListItem[]>;

  /**
   * The ledger row for one **gateway** event id — the id the gateway's dashboard shows.
   *
   * This is the first question when a customer paid and nothing happened: did the event
   * arrive at all? `null` means it never reached the processor; a row with status `failed`
   * carries the handler's error.
   */
  findWebhookEventByGatewayEventId(gatewayEventId: string): Promise<WebhookEventListItem | null>;

  /**
   * How many ledger rows match a status and/or a creation window.
   *
   * `{ status: 'received', createdBefore: fifteenMinutesAgo }` is the one to alert on: an
   * event was claimed and nothing ever finished it, which usually means the worker the
   * dispatcher depends on is not running.
   */
  countWebhookEvents(query: BillingCountQuery): Promise<number>;

  /**
   * The same count, grouped by provider and event type — "what is failing", not just
   * "how much". Ordered by count, descending.
   */
  webhookEventBreakdown(query: BillingCountQuery): Promise<WebhookEventBreakdownLine[]>;

  // ── Metered usage ────────────────────────────────────────────────────────────────

  /** Record one metered-usage event (a metered subscription's consumption). */
  recordUsage(event: {
    subscriptionId?: string | null;
    customerId?: string;
    meter: string;
    quantity: number;
    metadata?: Record<string, unknown>;
    recordedAt?: Date;
  }): Promise<UsageEventRow>;

  /** Aggregate metered usage by meter, filtered by subscription/customer/meter/window. */
  usageReport(query: {
    subscriptionId?: string;
    customerId?: string;
    meter?: string;
    from?: Date;
    to?: Date;
  }): Promise<Array<{ meter: string; quantity: number }>>;

  /** Sum of paid payments within a window (revenue, in cents). */
  revenue(query: { from?: Date; to?: Date }): Promise<number>;

  /** Count of active subscriptions (status `'active'`/`'trialing'`). */
  countActiveSubscriptions(): Promise<number>;
}
