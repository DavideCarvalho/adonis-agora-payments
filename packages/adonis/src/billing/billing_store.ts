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
  /**
   * How much of {@link PaymentListItem.amount} has come back, in the SAME integer minor
   * units — `0` when nothing has, `null` on a row written before an earlier schema ran.
   *
   * Net revenue for a row is `amount - refundedAmount`. It is a separate figure precisely so
   * a PARTIAL refund does not have to be spelled by mangling `amount` or `status`: a R$10
   * refund on a R$100 charge leaves `amount: 10000, refundedAmount: 1000, status: 'paid'`.
   * NEVER divide — format at the edge.
   */
  refundedAmount: number | null;
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

/** A library-owned subscription at creation time. */
export interface ManagedSubscriptionInput {
  provider: string;
  customerId: string;
  status: string;
  planId: string;
  /** Integer minor units, per cycle. */
  amount: number;
  currency: string;
  cycle: string;
  method?: string | null;
  description?: string | null;
  /** Copied onto every cycle's charge, so renewals route like any other payment. */
  externalReference?: string | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  nextChargeAt: Date | null;
  payload?: Record<string, unknown>;
}

/** The fields a managed subscription can change after creation. */
export interface ManagedSubscriptionPatch {
  status?: string;
  amount?: number;
  description?: string | null;
  cycle?: string;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  nextChargeAt?: Date | null;
  cancelAtPeriodEnd?: boolean;
  endsAt?: Date | null;
}

/** One `billing_subscriptions` row, normalized for reading. See {@link PaymentListItem}. */
export interface SubscriptionListItem {
  id: string;
  /**
   * `null` when no gateway subscription backs this row — a managed subscription, a free
   * plan, or an admin-granted courtesy. The column was always nullable; only the type
   * disagreed.
   */
  gatewayId: string | null;
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

/**
 * Filter + page for {@link BillingStore.listPayments}.
 *
 * The three fields beyond `status`/`provider` all answer the SAME question, which the console
 * could not ask before: "did THIS charge land?" An operator holds one of three ids — the app's
 * own reference for the order, the gateway's id for the payment, or the gateway's id for the
 * customer — and a list that filters only on status makes them page a growing table looking for
 * a string.
 *
 * All three are EXACT matches, not prefixes or substrings. They are join keys, not search terms:
 * a substring match on `externalReference` would let `order-4` return `order-42`, and the whole
 * point of the lookup is that the row it returns is the row that was asked for.
 */
export interface PaymentListQuery extends BillingListQuery {
  /**
   * The app's own id for the charge (`ChargeInput.externalReference`), exactly as
   * {@link BillingStore.findPaymentByExternalReference} matches it.
   *
   * Unlike that method this returns every row carrying the reference rather than the newest —
   * an app may reuse a reference across retries, and when it did, "which one landed?" is
   * precisely the question being asked.
   */
  externalReference?: string;
  /** The gateway's own payment id (`pi_...`, `pay_...`) — what the gateway's dashboard shows. */
  gatewayId?: string;
  /** The gateway's customer id — every payment recorded for one customer. */
  customerId?: string;
}

/** Filter + page for {@link BillingStore.listWebhookEvents}. */
export interface WebhookEventListQuery extends BillingListQuery {
  /**
   * Exact event-type match (`payment.succeeded`, `payment.refunded`, ...). Omit for every type.
   *
   * `status` + `provider` answers "what is failing on Asaas"; without this there is no way to
   * ask "did any refund event arrive at all", which is the question a ledger is read for once
   * a specific charge is in doubt. The type vocabulary is discoverable —
   * {@link BillingStore.webhookEventBreakdown} with no filter enumerates exactly the types this
   * install has actually received.
   */
  type?: string;
}

/** Filter + page for {@link BillingStore.listCustomers}. */
export interface CustomerListQuery extends BillingListQuery {
  /** The app-side owner type (`'users'`) written by `ensureCustomer`. Exact match. */
  ownerType?: string;
  /** The app-side owner id. Exact match; pair it with `ownerType`. */
  ownerId?: string;
  /** The gateway's customer id — the join key a payment row carries. Exact match. */
  gatewayId?: string;
}

/**
 * "Which disputes are still unanswered?" — regardless of whether anyone told us a deadline.
 *
 * The deliberately deadline-FREE counterpart to {@link DisputeDeadlineQuery}, and it exists
 * because the deadline one is structurally blind on most installs: `evidence_due_by` can only be
 * filled by a gateway that publishes the field, and several of the eighteen drivers here never
 * receive one. On those, `countDisputesDueWithin` returns zero while a chargeback sits open with
 * the money already pulled — a healthy report about an install that is losing money by default.
 */
export interface OpenDisputeQuery {
  /** Exact provider match. Omit for every provider. */
  provider?: string;
  limit?: number;
  offset?: number;
}

/**
 * One `billing_audit_events` row, normalized for reading. See {@link PaymentListItem}.
 *
 * The table records the things that HAPPENED to this install that no other table keeps: a human
 * refunding from the console, a human resolving a dispute the gateway will never close, and a
 * delivery the endpoint REJECTED before it ever became a ledger row. Every one of those was
 * previously a diagnostic and nothing else — i.e. a line in a log that has usually rotated away
 * by the time somebody asks.
 */
export interface AuditEventListItem {
  id: string;
  /** One of {@link AUDIT_ACTIONS}' values. A free string in the column: an app may add its own. */
  action: string;
  /**
   * WHO did it — the dashboard session's user, as `enforce()` knew them.
   *
   * `null` when nothing authorised it in a human sense: a rejected delivery has no actor, and a
   * console with no `dashboardAuth` configured cannot name one. `null` therefore means
   * "unattributed", never "the system".
   */
  actor: string | null;
  provider: string | null;
  /** `'payment'` | `'dispute'` | `'webhook'`, or whatever an app records. */
  subjectType: string | null;
  /** The subject's gateway id — the join back to the table it names. */
  subjectId: string | null;
  /** Integer minor units, or `null`. NEVER divide here. */
  amount: number | null;
  currency: string | null;
  /** A human sentence: the refusal reason, the operator's note. */
  message: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date | null;
}

/** The actions this package records itself. A free string in the column; these are the built-ins. */
export const AUDIT_ACTIONS = {
  /** A refund issued FROM THE CONSOLE. The gateway's own webhook still moves the payment row. */
  refund: 'payment.refunded',
  /** A dispute an operator closed by hand, because the gateway publishes no lost-dispute event. */
  disputeResolved: 'dispute.resolved',
  /** A delivery the webhook endpoint refused: bad signature, unparsable body, unknown provider. */
  webhookRejected: 'webhook.rejected',
} as const;

/** Filter + page for {@link BillingStore.listAuditEvents}. */
export interface AuditEventQuery {
  /** Exact action match. */
  action?: string;
  /** Any of these actions — the timeline reads several at once. Composed with `action` as AND. */
  actions?: readonly string[];
  actor?: string;
  provider?: string;
  subjectType?: string;
  subjectId?: string;
  /** Only rows created at or AFTER this instant — the window a health check counts over. */
  createdAfter?: Date;
  /** Only rows created strictly BEFORE this instant. */
  createdBefore?: Date;
  limit?: number;
  offset?: number;
}

/** The same filter without a page — the count a health check alerts on. */
export type AuditEventCountQuery = Omit<AuditEventQuery, 'limit' | 'offset'>;

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
  listCustomers(query: CustomerListQuery): Promise<CustomerListItem[]>;

  /**
   * The customer mappings behind a set of gateway customer ids, in one read.
   *
   * The join the payments screen needs and could not do: a payment row carries the GATEWAY's
   * customer id (`cus_…`), and the only thing that ties it back to an app user is
   * `billing_customers.owner_type`/`owner_id`, written by `ensureCustomer`. Resolving that one
   * row at a time would be a query per row of every page.
   *
   * Ids not present simply do not appear — a short result is the answer, not an error. An empty
   * input returns an empty array without touching the database.
   */
  listCustomersByGatewayIds(gatewayIds: readonly string[]): Promise<CustomerListItem[]>;

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

  // ── Managed subscriptions ────────────────────────────────────────────────────────
  //
  // Separate from `saveSubscription` because that one is keyed by `gatewayId`, and a managed
  // subscription has none — nothing was created at the gateway. Reusing it would have meant
  // inventing a fake gateway id, which then flows into `findSubscriptionByGatewayId` and the
  // webhook processor as if a gateway knew about it.

  /** Insert a library-owned subscription. `id` is the app-visible handle from here on. */
  createManagedSubscription(sub: ManagedSubscriptionInput): Promise<SubscriptionRow>;

  findSubscriptionById(id: string): Promise<SubscriptionRow | null>;

  /** Patch a managed subscription. Returns `null` when the id matches nothing. */
  updateManagedSubscription(
    id: string,
    patch: ManagedSubscriptionPatch,
  ): Promise<SubscriptionRow | null>;

  /**
   * Managed subscriptions whose next cycle is due at or before `now`, oldest first.
   *
   * `limit` is not decoration: this is what the renewal runner iterates, and an unbounded
   * read on a backlog (a worker that was down for a day) is how a renewal pass turns into an
   * out-of-memory restart that then renews nothing at all.
   */
  listDueManagedSubscriptions(now: Date, limit: number): Promise<SubscriptionRow[]>;

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
   *
   * **`paidAt` and `refundedAmount` follow exactly the same rule**, and the reason is money.
   * A refund, a chargeback and a dispute close all write this row and none of them carries a
   * settlement date; a store that wrote `undefined` through as `null` destroyed `paid_at` on
   * every one of them, and {@link BillingStore.revenue} filters on `paid_at`. A dispute closed
   * as WON therefore restored `status = 'paid'` with no date and the recovered money dropped
   * out of every windowed revenue figure. Absent means "not stated"; `null` means "clear it".
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
    /**
     * Integer minor units refunded so far — the whole point of the field is that a PARTIAL
     * refund can be recorded without lying about `amount` or `status`. Absent leaves the
     * stored figure alone; `null` clears it.
     */
    refundedAmount?: number | null;
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
  listPayments(query: PaymentListQuery): Promise<PaymentListItem[]>;

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

  /**
   * Every dispute that still needs an answer, oldest FIRST — deadline or no deadline.
   *
   * The check {@link listDisputesDueWithin} cannot be. That one requires `evidence_due_by`, and
   * the deadline only ever arrives from a gateway that publishes one; on Asaas it comes from
   * `chargeback.deadlineToSendDisputeDocuments`, which no published webhook example even
   * contains. On such an install every deadline read answers zero forever, so a chargeback can
   * be open with the money already pulled back while the report says healthy.
   *
   * Oldest first because with no deadline to sort on, "how long has nobody answered this" is the
   * only priority signal left.
   */
  listOpenDisputes(query: OpenDisputeQuery): Promise<DisputeListItem[]>;

  /** The unbounded count behind {@link listOpenDisputes} — what a health check alerts on. */
  countOpenDisputes(query: { provider?: string }): Promise<number>;

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
  listWebhookEvents(query: WebhookEventListQuery): Promise<WebhookEventListItem[]>;

  /**
   * The ledger rows whose stored delivery NAMES one payment — that payment's timeline.
   *
   * `billing_payments` is a single mutable row upserted in place: it holds the current state and
   * no history at all, so "what happened to this charge, and when?" has no answer from the
   * payments table. The ledger does have one — every delivery that moved the row is in it — but
   * nothing links a ledger row to a payment, because the link lives inside the stored payload.
   *
   * So this is a SUBSTRING match over the payload, and both of that decision's costs are real:
   * it is an unindexed scan (bounded by `limit`, newest first, which is why the bound is not
   * optional in spirit even though it has a default), and a gateway id that happens to be a
   * substring of some other identifier in another delivery will match. It is offered anyway
   * because the alternative on the table today is nothing at all. The honest fix is a
   * `payment_gateway_id` column the PROCESSOR fills on the way in; see the changeset.
   *
   * Never returns the payload itself — the same rule the rest of this console follows.
   */
  listWebhookEventsForPayment(
    paymentGatewayId: string,
    query?: { limit?: number },
  ): Promise<WebhookEventListItem[]>;

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

  // ── Audit trail ──────────────────────────────────────────────────────────────────

  /**
   * Record something that happened which no other table keeps: a console refund, a dispute an
   * operator resolved by hand, a delivery the endpoint rejected.
   *
   * Returns `null` — and writes nothing — when the install has no `billing_audit_events` table
   * yet, i.e. it upgraded the package before running an earlier schema. Exactly the tolerance
   * {@link BillingStore.saveDispute} has, and for the same reason: the audit row is ADDITIONAL,
   * and failing a refund that the gateway already accepted because the note could not be filed
   * would be the worse outcome by a distance.
   */
  recordAuditEvent(event: {
    action: string;
    /** WHO. `null`/absent means unattributed — see {@link AuditEventListItem.actor}. */
    actor?: string | null;
    provider?: string | null;
    subjectType?: string | null;
    subjectId?: string | null;
    /** Integer minor units. */
    amount?: number | null;
    currency?: string | null;
    message?: string | null;
    metadata?: Record<string, unknown> | null;
    /** Defaults to the insert instant. */
    createdAt?: Date;
  }): Promise<AuditEventListItem | null>;

  /** Page through the audit trail, newest first. Empty on an install with no table yet. */
  listAuditEvents(query: AuditEventQuery): Promise<AuditEventListItem[]>;

  /** How many audit rows match — the count the rejected-delivery check alerts on. */
  countAuditEvents(query: AuditEventCountQuery): Promise<number>;

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

  /**
   * Sum of paid payments within a window, **GROSS** — `amount` on `status = 'paid'` rows,
   * windowed on `paid_at`, with nothing subtracted.
   *
   * A half-refunded charge counts at its FULL value here, because that is what gross means:
   * it answers "how much did we charge and collect in this window". For "how much did we
   * keep", see {@link BillingStore.netRevenue}. Both are legitimate figures and neither is
   * the other's replacement — a screen that shows one without saying which is the screen that
   * misleads. Integer minor units; NEVER divide.
   */
  revenue(query: { from?: Date; to?: Date }): Promise<number>;

  /**
   * The same rows and the same window as {@link BillingStore.revenue}, **NET of refunds**:
   * `SUM(amount - COALESCE(refunded_amount, 0))`.
   *
   * The `refunded_amount` column exists precisely so a PARTIAL refund does not have to be
   * spelled by mangling `amount` or `status` — a R$10 refund on a R$100 charge leaves the row
   * `paid` at `amount: 10000, refundedAmount: 1000`. Gross sees R$100 of that row, net sees
   * R$90, and until this existed only gross was reachable, so a partially refunded charge was
   * invisible in every revenue figure the console printed.
   *
   * `COALESCE` is not decoration: `refunded_amount` is `NULL` on every row written before the
   * column existed, and `10000 - NULL` is `NULL` in SQL, which would poison the whole SUM into
   * `NULL` — one legacy row would report zero revenue for the entire window. `NULL` means
   * "nothing came back", so it reads as zero.
   *
   * On an install whose table predates the column, this equals {@link BillingStore.revenue}:
   * no refund was ever recorded, so there is nothing to subtract.
   *
   * Integer minor units, like everything else here. NEVER divide — format at the edge.
   */
  netRevenue(query: { from?: Date; to?: Date }): Promise<number>;

  /** Count of active subscriptions (status `'active'`/`'trialing'`). */
  countActiveSubscriptions(): Promise<number>;
}
