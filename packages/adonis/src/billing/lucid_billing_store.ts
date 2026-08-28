import type { NormalizeConstructor } from '@adonisjs/core/types/helpers';
import { DateTime } from 'luxon';
import {
  type BillingCountQuery,
  type BillingListQuery,
  type BillingStore,
  type CustomerListItem,
  type DisputeDeadlineQuery,
  type DisputeListItem,
  OPEN_DISPUTE_STATUSES,
  type PaymentListItem,
  type SubscriptionListItem,
  type WebhookEventBreakdownLine,
  type WebhookEventListItem,
} from './billing_store.js';
import { clampLimit, clampOffset } from './list_query.js';
import {
  BillingCustomer as DefaultCustomer,
  BillingDispute as DefaultDispute,
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
  customerModel?: NormalizeConstructor<typeof DefaultCustomer>;
  subscriptionModel?: NormalizeConstructor<typeof DefaultSubscription>;
  paymentModel?: NormalizeConstructor<typeof DefaultPayment>;
  webhookEventModel?: NormalizeConstructor<typeof DefaultWebhookEvent>;
  usageEventModel?: NormalizeConstructor<typeof DefaultUsageEvent>;
  disputeModel?: NormalizeConstructor<typeof DefaultDispute>;
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

/**
 * The instant a deadline query looks up to: `now + withinHours`.
 *
 * There is no lower bound on purpose. A deadline that has already PASSED is still open and
 * still unanswered, and excluding it would make the alert go quiet at exactly the moment it
 * became true.
 */
function deadlineCutoff(query: { withinHours: number; now?: Date }): Date {
  const now = query.now ?? new Date();
  return new Date(now.getTime() + query.withinHours * 3_600_000);
}

/** One dispute row, normalized for reading. `amount` stays integer minor units. */
function disputeItem(row: {
  id: string;
  gatewayId: string;
  paymentGatewayId: string;
  provider: string;
  status: string;
  reason: string | null;
  amount: number | null;
  currency: string | null;
  evidenceDueBy: DateTime | null;
  outcome: string | null;
  openedAt: DateTime | null;
  closedAt: DateTime | null;
  createdAt: DateTime;
}): DisputeListItem {
  return {
    id: String(row.id),
    gatewayId: row.gatewayId,
    paymentGatewayId: row.paymentGatewayId,
    provider: row.provider,
    status: row.status,
    reason: row.reason ?? null,
    // `bigint` comes back as a STRING on Postgres, like every other amount in this store.
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    currency: row.currency ?? null,
    evidenceDueBy: toDate(row.evidenceDueBy),
    outcome: row.outcome ?? null,
    openedAt: toDate(row.openedAt),
    closedAt: toDate(row.closedAt),
    createdAt: toDate(row.createdAt),
  };
}

/**
 * The normalized event, as a jsonb-storable value.
 *
 * Drivers normalize onto object shapes (`PaymentWebhookData`, `SubscriptionWebhookData`), but
 * `WebhookEvent.data` is `unknown` and a driver may hand back anything. Anything that is not
 * an object is stored as `null` rather than coerced: the retry checks for `null` and says it
 * cannot replay, which is a better answer than rebuilding an event around a string.
 */
function normalizedColumn(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

type CustomerInstance = InstanceType<typeof DefaultCustomer>;
type SubscriptionInstance = InstanceType<typeof DefaultSubscription>;
type PaymentInstance = InstanceType<typeof DefaultPayment>;
type WebhookEventInstance = InstanceType<typeof DefaultWebhookEvent>;
type UsageEventInstance = InstanceType<typeof DefaultUsageEvent>;
type DisputeInstance = InstanceType<typeof DefaultDispute>;

/**
 * Lucid implementation of {@link BillingStore}. Resolves the models passed in (defaulting
 * to the bundled ones) and writes through them, so custom models/composed mixins keep
 * working with the same store.
 */
export class LucidBillingStore
  implements
    BillingStore<
      SubscriptionInstance,
      PaymentInstance,
      WebhookEventInstance,
      UsageEventInstance,
      CustomerInstance,
      DisputeInstance
    >
{
  /**
   * Per-column answers to "does this install's table actually have it?", cached per store.
   *
   * `external_reference` and `normalized` arrive in a SECOND migration
   * (`add_billing_external_reference`), because the first one is already in production
   * everywhere this package is installed. An app that upgrades the package before running it
   * must keep taking webhooks — a payment that records no reference, and a ledger row the
   * dashboard cannot replay, are both survivable; a `column ... does not exist` on every
   * gateway delivery is not. So the write asks once, per column, and skips what is not there.
   *
   * Keyed by `table.column`. One `information_schema` read per column per process, then
   * nothing. A probe that itself fails answers "present": dropping data quietly is the worse
   * of the two failures, and the real INSERT will then say exactly what is wrong.
   */
  #columnCache: Map<string, Promise<boolean>> = new Map();

  #customerModel: typeof DefaultCustomer;
  #subscriptionModel: typeof DefaultSubscription;
  #paymentModel: typeof DefaultPayment;
  #webhookEventModel: typeof DefaultWebhookEvent;
  #usageEventModel: typeof DefaultUsageEvent;
  #disputeModel: typeof DefaultDispute;

  constructor(models: BillingModels = {}) {
    this.#customerModel = (models.customerModel ?? DefaultCustomer) as typeof DefaultCustomer;
    this.#subscriptionModel = (models.subscriptionModel ??
      DefaultSubscription) as typeof DefaultSubscription;
    this.#paymentModel = (models.paymentModel ?? DefaultPayment) as typeof DefaultPayment;
    this.#webhookEventModel = (models.webhookEventModel ??
      DefaultWebhookEvent) as typeof DefaultWebhookEvent;
    this.#usageEventModel = (models.usageEventModel ??
      DefaultUsageEvent) as typeof DefaultUsageEvent;
    this.#disputeModel = (models.disputeModel ?? DefaultDispute) as typeof DefaultDispute;
  }

  async #hasColumn(
    model: typeof DefaultPayment | typeof DefaultWebhookEvent | typeof DefaultDispute,
    column: string,
  ) {
    const key = `${model.table}.${column}`;
    let answer = this.#columnCache.get(key);
    if (answer === undefined) {
      answer = model
        .query()
        .client.columnsInfo(model.table)
        .then((columns) => Object.hasOwn(columns as Record<string, unknown>, column))
        .catch(() => true);
      this.#columnCache.set(key, answer);
    }
    return answer;
  }

  /**
   * Does this install have the `billing_disputes` table at all?
   *
   * Same question as {@link LucidBillingStore.hasColumn}, one level up, and for the same
   * reason: `billing_disputes` arrives in a THIRD migration (`add_billing_disputes`), so an
   * app that upgrades the package before running it has a processor that wants to write
   * disputes and no table to write them to. The dispute row is ADDITIONAL — the payment row
   * still moves, the diagnostics still publish — so a missing table skips the write and
   * every dispute read answers empty, rather than failing every gateway delivery with
   * `relation "billing_disputes" does not exist` until someone notices.
   *
   * Reuses the column cache and the column probe: `columnsInfo` on a table that does not
   * exist yields no columns at all. A probe that itself fails answers "present", so the real
   * query then says exactly what is wrong.
   */
  async #hasDisputesTable(): Promise<boolean> {
    const key = `${this.#disputeModel.table}.*`;
    let answer = this.#columnCache.get(key);
    if (answer === undefined) {
      answer = this.#disputeModel
        .query()
        .client.columnsInfo(this.#disputeModel.table)
        .then((columns) => Object.keys(columns as Record<string, unknown>).length > 0)
        .catch(() => true);
      this.#columnCache.set(key, answer);
    }
    return answer;
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
  }): Promise<CustomerInstance> {
    const existing = await this.findCustomerByGatewayId(customer.gatewayId);
    const row = (existing ?? new this.#customerModel()) as CustomerInstance;
    row.gatewayId = customer.gatewayId;
    row.provider = customer.provider;
    // Absent fields do NOT erase what is already recorded: a later call that only knows the
    // gateway id — a reconcile, a webhook — would otherwise blank the owner mapping that an
    // earlier, better-informed call wrote, which is the whole reason the row exists.
    if (customer.ownerType !== undefined) row.ownerType = customer.ownerType;
    if (customer.ownerId !== undefined) row.ownerId = customer.ownerId;
    if (customer.email !== undefined) row.email = customer.email;
    if (customer.name !== undefined) row.name = customer.name;
    if (customer.taxId !== undefined) row.taxId = customer.taxId;
    if (customer.metadata !== undefined) row.metadata = customer.metadata;
    await row.save();
    return row;
  }

  async findCustomerByGatewayId(gatewayId: string): Promise<CustomerInstance | null> {
    return (await this.#customerModel.findBy('gateway_id', gatewayId)) as CustomerInstance | null;
  }

  async findCustomerByOwner(
    ownerType: string,
    ownerId: string,
    provider: string,
  ): Promise<CustomerInstance | null> {
    return (await this.#customerModel
      .query()
      .where('owner_type', ownerType)
      .where('owner_id', ownerId)
      .where('provider', provider)
      .first()) as CustomerInstance | null;
  }

  async listCustomers(
    query: BillingListQuery & { provider?: string },
  ): Promise<CustomerListItem[]> {
    const builder = this.#customerModel.query().orderBy('created_at', 'desc');
    if (query.provider !== undefined) builder.where('provider', query.provider);
    const rows = (await builder
      .limit(clampLimit(query.limit))
      .offset(clampOffset(query.offset))) as CustomerInstance[];
    return rows.map((row) => ({
      id: String(row.id),
      gatewayId: row.gatewayId,
      provider: row.provider,
      ownerType: row.ownerType ?? null,
      ownerId: row.ownerId ?? null,
      email: row.email ?? null,
      name: row.name ?? null,
      taxId: row.taxId ?? null,
      createdAt: toDate(row.createdAt),
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

  async listSubscriptions(query: BillingListQuery): Promise<SubscriptionListItem[]> {
    const builder = this.#subscriptionModel.query().orderBy('created_at', 'desc');
    if (query.status !== undefined) builder.where('status', query.status);
    if (query.provider !== undefined) builder.where('provider', query.provider);
    const rows = (await builder
      .limit(clampLimit(query.limit))
      .offset(clampOffset(query.offset))) as SubscriptionInstance[];
    return rows.map((row) => ({
      id: String(row.id),
      gatewayId: row.gatewayId,
      provider: row.provider,
      status: row.status,
      planId: row.planId,
      customerId: row.customerId ?? null,
      trialEndsAt: toDate(row.trialEndsAt),
      endsAt: toDate(row.endsAt),
      createdAt: toDate(row.createdAt),
    }));
  }

  async countSubscriptions(query: BillingCountQuery): Promise<number> {
    const builder = this.#subscriptionModel.query().count('* as total').pojo();
    if (query.status !== undefined) builder.where('status', query.status);
    if (query.createdBefore !== undefined) builder.where('created_at', '<', query.createdBefore);
    if (query.createdAfter !== undefined) builder.where('created_at', '>=', query.createdAfter);
    return toCount(await builder);
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
    externalReference?: string | null;
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
    // An ABSENT reference does not erase the stored one — same rule as `saveCustomer`'s owner
    // mapping, and for a sharper reason: `payment.succeeded` carries the app's reference,
    // `payment.refunded` and `payment.disputed` frequently do not, and blanking it there would
    // destroy the only key `findPaymentByExternalReference` can route on. `null` still clears.
    if (
      payment.externalReference !== undefined &&
      (await this.#hasColumn(this.#paymentModel, 'external_reference'))
    ) {
      row.externalReference = payment.externalReference;
    }
    row.paidAt = payment.paidAt ? DateTime.fromJSDate(payment.paidAt) : null;
    row.payload = payment.payload ?? {};
    await row.save();
    return row;
  }

  async findPaymentByGatewayId(gatewayId: string): Promise<PaymentInstance | null> {
    const row = await this.#paymentModel.findBy('gateway_id', gatewayId);
    return row as PaymentInstance | null;
  }

  async findPaymentByExternalReference(reference: string): Promise<PaymentInstance | null> {
    // An install that has not run `add_billing_external_reference` has no column to match on,
    // and every row it holds would answer `null` anyway — so say `null` instead of raising
    // `column "external_reference" does not exist` at a browser that is merely polling.
    if (!(await this.#hasColumn(this.#paymentModel, 'external_reference'))) return null;
    // Newest first: nothing stops an app reusing a reference across retries, and the row an
    // operator (or a polling checkout page) means is the most recent one.
    const row = await this.#paymentModel
      .query()
      .where('external_reference', reference)
      .orderBy('created_at', 'desc')
      .first();
    return row as PaymentInstance | null;
  }

  async listPayments(query: BillingListQuery): Promise<PaymentListItem[]> {
    const builder = this.#paymentModel.query().orderBy('created_at', 'desc');
    if (query.status !== undefined) builder.where('status', query.status);
    if (query.provider !== undefined) builder.where('provider', query.provider);
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
      externalReference: row.externalReference ?? null,
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
  }): Promise<DisputeInstance | null> {
    if (!(await this.#hasDisputesTable())) return null;
    const existing = await this.findDisputeByGatewayId(dispute.gatewayId);
    const row = (existing ?? new this.#disputeModel()) as DisputeInstance;
    row.gatewayId = dispute.gatewayId;
    row.paymentGatewayId = dispute.paymentGatewayId;
    row.provider = dispute.provider;
    row.status = dispute.status;
    // A new row starts with every optional column explicitly `null` rather than absent, so a
    // reader never has to tell "the gateway sent nothing" apart from "the column was omitted".
    if (existing === null) {
      row.reason = null;
      row.amount = null;
      row.currency = null;
      row.evidenceDueBy = null;
      row.outcome = null;
      row.closedAt = null;
      row.payload = {};
    }
    // Absent does NOT erase: the event that OPENS a dispute carries the deadline and the
    // reason, and the one that CLOSES it carries neither. Blanking them on the close would
    // destroy the only record of the window that was answered. `null` still clears.
    if (dispute.reason !== undefined) row.reason = dispute.reason;
    if (dispute.amount !== undefined) row.amount = dispute.amount;
    if (dispute.currency !== undefined) row.currency = dispute.currency;
    if (dispute.evidenceDueBy !== undefined) {
      row.evidenceDueBy = dispute.evidenceDueBy ? DateTime.fromJSDate(dispute.evidenceDueBy) : null;
    }
    if (dispute.outcome !== undefined) row.outcome = dispute.outcome;
    if (dispute.closedAt !== undefined) {
      row.closedAt = dispute.closedAt ? DateTime.fromJSDate(dispute.closedAt) : null;
    }
    // `openedAt` is when the dispute FIRST reached us and is never moved afterwards: a later
    // event re-stamping it would make every dispute look brand new and destroy the only
    // measure of how long one has been open.
    if (existing === null || existing.openedAt === null) {
      row.openedAt = dispute.openedAt ? DateTime.fromJSDate(dispute.openedAt) : DateTime.now();
    }
    if (dispute.payload !== undefined) row.payload = dispute.payload;
    await row.save();
    return row;
  }

  async findDisputeByGatewayId(gatewayId: string): Promise<DisputeInstance | null> {
    if (!(await this.#hasDisputesTable())) return null;
    return (await this.#disputeModel.findBy('gateway_id', gatewayId)) as DisputeInstance | null;
  }

  async findOpenDisputeByPayment(paymentGatewayId: string): Promise<DisputeInstance | null> {
    if (!(await this.#hasDisputesTable())) return null;
    const row = await this.#disputeModel
      .query()
      .where('payment_gateway_id', paymentGatewayId)
      .whereIn('status', [...OPEN_DISPUTE_STATUSES])
      .orderBy('created_at', 'desc')
      .first();
    return row as DisputeInstance | null;
  }

  async listDisputes(query: BillingListQuery): Promise<DisputeListItem[]> {
    if (!(await this.#hasDisputesTable())) return [];
    const builder = this.#disputeModel.query().orderBy('created_at', 'desc');
    if (query.status !== undefined) builder.where('status', query.status);
    if (query.provider !== undefined) builder.where('provider', query.provider);
    const rows = (await builder
      .limit(clampLimit(query.limit))
      .offset(clampOffset(query.offset))) as DisputeInstance[];
    return rows.map(disputeItem);
  }

  async countDisputes(query: BillingCountQuery): Promise<number> {
    if (!(await this.#hasDisputesTable())) return 0;
    const builder = this.#disputeModel.query().count('* as total').pojo();
    if (query.status !== undefined) builder.where('status', query.status);
    if (query.createdBefore !== undefined) builder.where('created_at', '<', query.createdBefore);
    if (query.createdAfter !== undefined) builder.where('created_at', '>=', query.createdAfter);
    return toCount(await builder);
  }

  async listDisputesDueWithin(query: DisputeDeadlineQuery): Promise<DisputeListItem[]> {
    if (!(await this.#hasDisputesTable())) return [];
    const builder = this.#disputeModel
      .query()
      .whereIn('status', [...OPEN_DISPUTE_STATUSES])
      // Explicit, though `<=` would already exclude NULLs: a gateway that sent no deadline
      // gives nothing to be late for, and the reader should not have to know SQL's NULL rules
      // to be sure of that.
      .whereNotNull('evidence_due_by')
      .where('evidence_due_by', '<=', deadlineCutoff(query))
      // Soonest first — the priority order, not the arrival order. The only list in this store
      // that is not newest-first.
      .orderBy('evidence_due_by', 'asc');
    if (query.provider !== undefined) builder.where('provider', query.provider);
    const rows = (await builder
      .limit(clampLimit(query.limit))
      .offset(clampOffset(query.offset))) as DisputeInstance[];
    return rows.map(disputeItem);
  }

  async countDisputesDueWithin(
    query: Omit<DisputeDeadlineQuery, 'limit' | 'offset'>,
  ): Promise<number> {
    if (!(await this.#hasDisputesTable())) return 0;
    const builder = this.#disputeModel
      .query()
      .whereIn('status', [...OPEN_DISPUTE_STATUSES])
      .whereNotNull('evidence_due_by')
      .where('evidence_due_by', '<=', deadlineCutoff(query))
      .count('* as total')
      .pojo();
    if (query.provider !== undefined) builder.where('provider', query.provider);
    return toCount(await builder);
  }

  async recordWebhookEvent(event: {
    gatewayEventId: string;
    provider: string;
    type: string;
    payload: Record<string, unknown>;
    normalized?: unknown;
  }): Promise<WebhookEventInstance | null> {
    const existing = await this.#webhookEventModel.findBy('gateway_event_id', event.gatewayEventId);
    if (existing) {
      // A previous attempt failed: claim it again so the retry re-runs. Anything
      // else (in flight, or already processed) is a redelivery — stop here.
      if (existing.status !== 'failed') return null;
      existing.status = 'received';
      existing.error = null;
      // `payload` and `normalized` are deliberately NOT touched here: the retry re-claims
      // this row precisely to read back what the original delivery recorded.
      await existing.save();
      return existing;
    }
    const row = new this.#webhookEventModel() as WebhookEventInstance;
    row.gatewayEventId = event.gatewayEventId;
    row.provider = event.provider;
    row.type = event.type;
    row.status = 'received';
    row.payload = event.payload;
    const normalized = normalizedColumn(event.normalized);
    if (normalized !== null && (await this.#hasColumn(this.#webhookEventModel, 'normalized'))) {
      row.normalized = normalized;
    }
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
    if (query.provider !== undefined) builder.where('provider', query.provider);
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
