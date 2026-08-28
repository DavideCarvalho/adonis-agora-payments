import type {
  BillingCustomer,
  BillingDispute,
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
  /**
   * The app's own id for this charge, as the gateway echoed it back.
   *
   * `null` on a payment whose gateway sent none, and on every row an install wrote before
   * it ran an earlier schema.
   */
  externalReference: string | null;
  paidAt: Date | null;
  createdAt: Date | null;
}

/** One `billing_customers` row, normalized for reading. See {@link PaymentListItem}. */
export interface CustomerListItem {
  id: string;
  gatewayId: string;
  provider: string;
  ownerType: string | null;
  ownerId: string | null;
  email: string | null;
  name: string | null;
  taxId: string | null;
  createdAt: Date | null;
}

/** One `billing_subscriptions` row, normalized for reading. See {@link PaymentListItem}. */
export interface SubscriptionListItem {
  id: string;
  gatewayId: string;
  provider: string;
  status: string;
  planId: string;
  customerId: string | null;
  trialEndsAt: Date | null;
  endsAt: Date | null;
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

/** One `billing_disputes` row, normalized for reading. See {@link PaymentListItem}. */
export interface DisputeListItem {
  id: string;
  /** The DISPUTE's own gateway id — or the synthesized one, for a gateway that sends none. */
  gatewayId: string;
  /** The disputed payment's gateway id — the join back to `billing_payments`. */
  paymentGatewayId: string;
  provider: string;
  /** A {@link import('../types.js').DisputeStatus} value. */
  status: string;
  reason: string | null;
  /** Integer minor units, or `null` — an early fraud warning names no money. NEVER divide here. */
  amount: number | null;
  currency: string | null;
  /**
   * The deadline to respond, or `null` when the gateway sent none.
   *
   * `null` means "this gateway told us nothing", never "no hurry": a reader must not treat
   * it as a distant deadline, and {@link BillingStore.listDisputesDueWithin} does not
   * return rows that carry one.
   */
  evidenceDueBy: Date | null;
  outcome: string | null;
  openedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date | null;
}

/**
 * The dispute statuses that still need an answer — everything that is not a resolution.
 *
 * Shared, and exported, because the deadline read is only meaningful against the same set
 * in both store implementations: one of them counting `expired` rows as open would make an
 * alert that never goes quiet, and one of them omitting `warning` would drop the alert that
 * arrives while a refund still prevents the chargeback.
 */
export const OPEN_DISPUTE_STATUSES = ['warning', 'open', 'under_review'] as const;

/**
 * "Which windows close soon?" — the one question this table was added to answer.
 *
 * Deliberately not expressible through {@link BillingListQuery}: it filters on a deadline,
 * not on a creation time, and it is the read an alert is built on, so a store that quietly
 * ignored the window would report a healthy zero.
 */
export interface DisputeDeadlineQuery {
  /** How far ahead to look, in HOURS. `72` = "everything due in the next three days". */
  withinHours: number;
  /** Overridable clock — the tests pass a fixed instant. Defaults to now. */
  now?: Date;
  /** Exact provider match. Omit for every provider. */
  provider?: string;
  limit?: number;
  offset?: number;
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
  /**
   * Exact provider match. Omit for every provider.
   *
   * Not decorative: with eighteen gateways configurable at once, "what is failing on
   * Asaas" is a different question from "what is failing", and without this the dashboard
   * had to page the whole table and filter in memory.
   */
  provider?: string;
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
  CustomerRow = BillingCustomer,
  DisputeRow = BillingDispute,
> {
  // ── Customers ────────────────────────────────────────────────────────────────────

  /**
   * Upsert the mapping between an app-side owner and its gateway customer, keyed by
   * gateway id.
   *
   * Nothing records this for you — the library learns a gateway customer id inside
   * `ensureCustomer`, which takes a store precisely so the mapping is written where it is
   * created. Without it `billing_customers` stays empty and `payments:sync --all` has
   * nothing to reconcile over.
   */
  saveCustomer(customer: {
    gatewayId: string;
    provider: string;
    ownerType?: string | null;
    ownerId?: string | null;
    email?: string | null;
    name?: string | null;
    taxId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<CustomerRow>;

  findCustomerByGatewayId(gatewayId: string): Promise<CustomerRow | null>;

  /**
   * The customer an app-side row holds at one gateway.
   *
   * `provider` is part of the question, not an optional filter: one owner may legitimately
   * have a customer at every configured gateway, and answering without it would return an
   * arbitrary one of them.
   */
  findCustomerByOwner(
    ownerType: string,
    ownerId: string,
    provider: string,
  ): Promise<CustomerRow | null>;

  /**
   * Page through recorded customers, newest first, optionally narrowed to one provider.
   *
   * This is what `payments:sync --all` iterates. Returns the normalized
   * {@link CustomerListItem} so a reader never depends on Lucid.
   */
  listCustomers(query: BillingListQuery & { provider?: string }): Promise<CustomerListItem[]>;

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

  /**
   * Page through subscriptions, newest first, optionally filtered by status.
   *
   * `countActiveSubscriptions()` answers "how many", which is the wrong question on any day
   * something is wrong: the operational ones are WHICH subscriptions are `past_due`, and
   * which are `paused` — a count cannot name a customer to email.
   */
  listSubscriptions(query: BillingListQuery): Promise<SubscriptionListItem[]>;

  /** How many subscriptions match a status and/or a creation window. */
  countSubscriptions(query: BillingCountQuery): Promise<number>;

  // ── Payments ─────────────────────────────────────────────────────────────────────

  /**
   * Upsert a payment keyed by gateway id. Returns the stored row.
   *
   * `externalReference` left `undefined` does NOT erase a stored one: the first webhook of a
   * charge usually carries the app's reference and a later one (a refund, a dispute) often
   * does not, and blanking it there would throw away the only key
   * {@link BillingStore.findPaymentByExternalReference} can route on. Pass `null` explicitly
   * to clear it. Same rule, same reason, as `saveCustomer`'s owner mapping.
   */
  savePayment(payment: {
    gatewayId: string;
    provider: string;
    status: string;
    amount: number;
    currency: string;
    customerId?: string | null;
    subscriptionId?: string | null;
    /** The app's own id for this charge (`ChargeInput.externalReference`), echoed by the gateway. */
    externalReference?: string | null;
    paidAt?: Date | null;
    payload?: Record<string, unknown>;
  }): Promise<PaymentRow>;

  findPaymentByGatewayId(gatewayId: string): Promise<PaymentRow | null>;

  /**
   * The payment carrying one app-side reference — the id the APP knows the charge by.
   *
   * The other direction of {@link findPaymentByGatewayId}, and the one an app actually has
   * at hand: a checkout page polls for "order-1042", not for `pi_3Qx...`. Backed by
   * `billing_payments_external_reference_idx`.
   *
   * `null` when no row carries it — including on a payment written before the install ran
   * an earlier schema, whose column is `null` for every row.
   * Ties are broken newest-first: nothing stops an app reusing a reference across retries.
   */
  findPaymentByExternalReference(reference: string): Promise<PaymentRow | null>;

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

  // ── Disputes ─────────────────────────────────────────────────────────────────────

  /**
   * Upsert a dispute keyed by `gatewayId` — the DISPUTE's own id, not the payment's.
   *
   * Absent fields do NOT erase what is already recorded, the same rule (and for a sharper
   * reason) as `savePayment`'s `externalReference`: the event that opens a dispute carries
   * the deadline and the reason, and the event that CLOSES it carries neither. Blanking
   * them on the close would destroy the only record of the window that was answered — and
   * the deadline is the entire reason this table exists. Pass `null` explicitly to clear.
   *
   * Returns `null` — and writes nothing — when the install has no `billing_disputes` table
   * yet, i.e. it upgraded the package before running an earlier schema. The dispute row
   * is ADDITIONAL (the payment row still moves, the diagnostics still publish), so the write
   * is skipped rather than failing every gateway delivery until someone runs the migration.
   */
  saveDispute(dispute: {
    /** The dispute's own gateway id. See {@link DisputeListItem.gatewayId}. */
    gatewayId: string;
    /** The disputed payment's gateway id. */
    paymentGatewayId: string;
    provider: string;
    /** A {@link import('../types.js').DisputeStatus} value. */
    status: string;
    reason?: string | null;
    /** Integer minor units. */
    amount?: number | null;
    currency?: string | null;
    evidenceDueBy?: Date | null;
    outcome?: string | null;
    /** Defaults to the insert instant, and is never moved by a later update. */
    openedAt?: Date | null;
    closedAt?: Date | null;
    payload?: Record<string, unknown>;
  }): Promise<DisputeRow | null>;

  /** The dispute with this gateway id, or `null`. The idempotency lookup behind the upsert. */
  findDisputeByGatewayId(gatewayId: string): Promise<DisputeRow | null>;

  /**
   * The most recent UNRESOLVED dispute against one payment, or `null`.
   *
   * The processor's answer to an event that carries no dispute id: several gateways send
   * the id when the dispute opens and omit it when it closes, and without this the close
   * would open a second row instead of finishing the first. Resolved disputes are skipped
   * so a fresh chargeback on a previously-lost payment starts its own row.
   */
  findOpenDisputeByPayment(paymentGatewayId: string): Promise<DisputeRow | null>;

  /**
   * Page through recorded disputes, newest first, `status`/`provider` filters — the same
   * shape as {@link listPayments}, and normalized for the same reason.
   */
  listDisputes(query: BillingListQuery): Promise<DisputeListItem[]>;

  /** How many disputes match a status and/or a creation window. */
  countDisputes(query: BillingCountQuery): Promise<number>;

  /**
   * The open disputes whose response window closes within `withinHours` — ordered by the
   * deadline, soonest FIRST.
   *
   * The one read that earns the table, and the only list here that is not newest-first: the
   * ordering is the priority order, because a window that closes tomorrow outranks a dispute
   * that arrived today.
   *
   * A deadline that is already PAST is included, not filtered out. It is still open, nothing
   * has answered it, and dropping it the moment it expires would make the alert go quiet at
   * exactly the moment it became true — the operator would read that as resolved.
   *
   * Rows with no `evidenceDueBy` are excluded: a gateway that sent no deadline gives nothing
   * to be late for, and putting them in the list would bury the rows that do have one.
   */
  listDisputesDueWithin(query: DisputeDeadlineQuery): Promise<DisputeListItem[]>;

  /**
   * The count behind {@link listDisputesDueWithin}, unbounded by any page.
   *
   * Separate from the list on purpose: the health check alerts on this number, and a count
   * derived from a capped page saturates at the cap — which reads as "200 disputes" forever
   * and, worse, would report a healthy zero if the page limit were ever misapplied.
   */
  countDisputesDueWithin(query: Omit<DisputeDeadlineQuery, 'limit' | 'offset'>): Promise<number>;

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
    /**
     * The NORMALIZED event (`WebhookEvent.data`), stored alongside the raw payload.
     *
     * Without it the dashboard's retry had to rebuild the event by calling `parseWebhook`
     * over the stored payload, which re-verifies a signature computed from headers the
     * ledger never kept — so a retry on Stripe or Adyen answered `422` and only unsigned
     * gateways could replay. Stored once, on the way in, where it is still in hand.
     *
     * Left `undefined` on the re-claim path (a retry), where the row keeps what it has.
     */
    normalized?: unknown;
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
