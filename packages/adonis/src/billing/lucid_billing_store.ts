import type { NormalizeConstructor } from '@adonisjs/core/types/helpers';
import { DateTime } from 'luxon';
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
} from './billing_store.js';
import { clampLimit, clampOffset } from './list_query.js';
import {
  BillingAuditEvent as DefaultAuditEvent,
  BillingCustomer as DefaultCustomer,
  BillingDispute as DefaultDispute,
  BillingPayment as DefaultPayment,
  BillingSubscription as DefaultSubscription,
  BillingUsageEvent as DefaultUsageEvent,
  BillingWebhookEvent as DefaultWebhookEvent,
} from './mixins/index.js';
import {
  type LucidDatabase,
  createBillingTables,
  detectDialect,
  registerBillingSchemaCache,
} from './schema.js';

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
  auditEventModel?: NormalizeConstructor<typeof DefaultAuditEvent>;
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
type AuditEventInstance = InstanceType<typeof DefaultAuditEvent>;

/** One ledger row, normalized for reading. The stored payload is NEVER part of it. */
function webhookEventItem(row: WebhookEventInstance): WebhookEventListItem {
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

/** One customer-mapping row, normalized for reading. Shared by both customer reads. */
function customerItem(row: CustomerInstance): CustomerListItem {
  return {
    id: String(row.id),
    gatewayId: row.gatewayId,
    provider: row.provider,
    ownerType: row.ownerType ?? null,
    ownerId: row.ownerId ?? null,
    email: row.email ?? null,
    name: row.name ?? null,
    taxId: row.taxId ?? null,
    createdAt: toDate(row.createdAt),
  };
}

/** One audit row, normalized for reading. `amount` is BIGINT — a STRING on Postgres. */
function auditItem(row: AuditEventInstance): AuditEventListItem {
  return {
    id: String(row.id),
    action: row.action,
    actor: row.actor ?? null,
    provider: row.provider ?? null,
    subjectType: row.subjectType ?? null,
    subjectId: row.subjectId ?? null,
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    currency: row.currency ?? null,
    message: row.message ?? null,
    metadata: (row.metadata as Record<string, unknown> | null | undefined) ?? null,
    createdAt: toDate(row.createdAt),
  };
}

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
   * (an earlier schema), because the first one is already in production
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

  /**
   * Whether to create the billing tables on first use. On by default — the ecosystem
   * convention is that a lib owns its own schema, the same way `@adonis-agora/durable` and
   * `@adonis-agora/authz` do. An app that wants explicit control sets
   * `billing.autoCreateSchema: false` and calls {@link createBillingTables} from a migration
   * instead; both paths run the SAME DDL, so they cannot drift.
   */
  #autoCreateSchema: boolean;

  /**
   * The one-shot schema promise. Cached so the DDL runs once per store, not once per query,
   * and so concurrent first calls await the same round trip rather than racing six
   * `CREATE TABLE IF NOT EXISTS` statements against each other.
   */
  #schemaReady: Promise<void> | undefined;

  #customerModel: typeof DefaultCustomer;
  #subscriptionModel: typeof DefaultSubscription;
  #paymentModel: typeof DefaultPayment;
  #webhookEventModel: typeof DefaultWebhookEvent;
  #usageEventModel: typeof DefaultUsageEvent;
  #disputeModel: typeof DefaultDispute;
  #auditEventModel: typeof DefaultAuditEvent;

  constructor(models: BillingModels = {}, options: { autoCreateSchema?: boolean } = {}) {
    this.#autoCreateSchema = options.autoCreateSchema !== false;
    this.#customerModel = (models.customerModel ?? DefaultCustomer) as typeof DefaultCustomer;
    this.#subscriptionModel = (models.subscriptionModel ??
      DefaultSubscription) as typeof DefaultSubscription;
    this.#paymentModel = (models.paymentModel ?? DefaultPayment) as typeof DefaultPayment;
    this.#webhookEventModel = (models.webhookEventModel ??
      DefaultWebhookEvent) as typeof DefaultWebhookEvent;
    this.#usageEventModel = (models.usageEventModel ??
      DefaultUsageEvent) as typeof DefaultUsageEvent;
    this.#disputeModel = (models.disputeModel ?? DefaultDispute) as typeof DefaultDispute;
    this.#auditEventModel = (models.auditEventModel ??
      DefaultAuditEvent) as typeof DefaultAuditEvent;
    // So `dropBillingTables()` can invalidate the memo below. Without it a suite that drops
    // the tables between groups leaves this store certain they still exist, and every
    // following query fails on a table nothing will re-create.
    registerBillingSchemaCache(() => {
      this.#schemaReady = undefined;
      this.#columnCache.clear();
    });
  }

  /**
   * Create the billing tables if they are not there. Idempotent, and safe to call from an
   * app that already ran the published migration — every statement is `IF NOT EXISTS`.
   *
   * Public because an app that turns `autoCreateSchema` off may still want it in a seeder or
   * a test bootstrap without reaching for the standalone function.
   */
  /**
   * Turn the automatic schema creation off after construction.
   *
   * One direction only, and deliberately: the flag exists to keep a library from running
   * DDL against a database somebody else owns, so honouring `false` wherever it appears is
   * the safe move and there is no way to switch it back on from here.
   *
   * It exists because the flag can arrive after the store does. An app that builds its own
   * store — `billing.store: () => lucidBillingStore({ paymentModel: MyPayment })` — has
   * already constructed it by the time the provider reads the config, and skipping the flag
   * there would create tables in exactly the shared database it was set to protect.
   */
  disableAutoCreateSchema(): void {
    this.#autoCreateSchema = false;
  }

  async ensureSchema(): Promise<void> {
    // NOT gated by `#ready()`: that is what calls this, and awaiting it here would have the
    // promise await itself. A deadlock, not a crash — every query would hang forever.
    await createBillingTables(this.#paymentModel.query().client as unknown as LucidDatabase);
  }

  /**
   * Awaited at the top of every public method.
   *
   * Every one, not just the writes: a read against a table that does not exist is the same
   * error, and it is the first thing an app hits — a dashboard opened before the first
   * charge. `test/lucid_store_schema.spec.ts` enumerates this class's public methods and
   * fails when one of them skips this, because "I added a method and forgot" is exactly how
   * a lazily-created schema becomes a schema that exists most of the time.
   */
  async #ready(): Promise<void> {
    if (!this.#autoCreateSchema) return;
    if (!this.#schemaReady) this.#schemaReady = this.ensureSchema();
    return this.#schemaReady;
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
   * reason: `billing_disputes` arrives in a THIRD migration (an earlier schema), so an
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
    return this.#hasTable(this.#disputeModel);
  }

  /**
   * Does this install have `billing_audit_events`?
   *
   * Same question, same tolerance: the table arrives after the package shipped, and every write
   * to it is ADDITIONAL to an action that already happened. Refusing a refund the gateway
   * already accepted because the audit note could not be filed would be strictly worse than
   * filing no note.
   */
  async #hasAuditTable(): Promise<boolean> {
    return this.#hasTable(this.#auditEventModel);
  }

  /**
   * "Does this table exist?", cached beside the column answers and resolved the same way:
   * `columnsInfo` on a missing table yields no columns at all. A probe that itself fails
   * answers "present", so the real query then says exactly what is wrong.
   */
  async #hasTable(model: {
    table: string;
    query(): { client: { columnsInfo(table: string): Promise<unknown> } };
  }): Promise<boolean> {
    const key = `${model.table}.*`;
    let answer = this.#columnCache.get(key);
    if (answer === undefined) {
      answer = model
        .query()
        .client.columnsInfo(model.table)
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
    await this.#ready();
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
    await this.#ready();
    return (await this.#customerModel.findBy('gateway_id', gatewayId)) as CustomerInstance | null;
  }

  async findCustomerByOwner(
    ownerType: string,
    ownerId: string,
    provider: string,
  ): Promise<CustomerInstance | null> {
    await this.#ready();
    return (await this.#customerModel
      .query()
      .where('owner_type', ownerType)
      .where('owner_id', ownerId)
      .where('provider', provider)
      .first()) as CustomerInstance | null;
  }

  async listCustomers(query: CustomerListQuery): Promise<CustomerListItem[]> {
    await this.#ready();
    const builder = this.#customerModel.query().orderBy('created_at', 'desc');
    if (query.provider !== undefined) builder.where('provider', query.provider);
    if (query.ownerType !== undefined) builder.where('owner_type', query.ownerType);
    if (query.ownerId !== undefined) builder.where('owner_id', query.ownerId);
    if (query.gatewayId !== undefined) builder.where('gateway_id', query.gatewayId);
    const rows = (await builder
      .limit(clampLimit(query.limit))
      .offset(clampOffset(query.offset))) as CustomerInstance[];
    return rows.map(customerItem);
  }

  async listCustomersByGatewayIds(gatewayIds: readonly string[]): Promise<CustomerListItem[]> {
    await this.#ready();
    // No ids means no query. `whereIn('gateway_id', [])` is a guaranteed-empty scan on some
    // dialects and a syntax error on others; either way it is a round trip for a known answer.
    if (gatewayIds.length === 0) return [];
    const rows = (await this.#customerModel
      .query()
      .whereIn('gateway_id', [...new Set(gatewayIds)])) as CustomerInstance[];
    return rows.map(customerItem);
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
    await this.#ready();
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
    await this.#ready();
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
    await this.#ready();
    const builder = this.#subscriptionModel.query().count('* as total').pojo();
    if (query.status !== undefined) builder.where('status', query.status);
    if (query.createdBefore !== undefined) builder.where('created_at', '<', query.createdBefore);
    if (query.createdAfter !== undefined) builder.where('created_at', '>=', query.createdAfter);
    return toCount(await builder);
  }

  async findSubscriptionByGatewayId(gatewayId: string): Promise<SubscriptionInstance | null> {
    await this.#ready();
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
    refundedAmount?: number | null;
    payload?: Record<string, unknown>;
  }): Promise<PaymentInstance> {
    await this.#ready();
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
    // An ABSENT `paidAt` does not erase the stored one — the same leave-alone rule as the
    // reference above, and with a sharper consequence. `payment.refunded`,
    // `payment.disputed` and `payment.dispute_closed` all call this WITHOUT a `paidAt`
    // (a refund/dispute payload carries no settlement date), and `revenue()` filters on
    // `status = 'paid' AND paid_at >= from AND paid_at < to`. Writing `null` through meant a
    // dispute closed as WON restored `status = 'paid'` with `paid_at = NULL`, so the recovered
    // money vanished from every windowed revenue figure — permanently, because `paid_at` is
    // the only record of when the charge landed. `null` still clears it, explicitly.
    if (payment.paidAt !== undefined) {
      row.paidAt = payment.paidAt === null ? null : DateTime.fromJSDate(payment.paidAt);
    }
    // Same leave-alone rule, same reason: only a partial-refund event knows this figure, and
    // every other write about the payment would otherwise reset it to zero.
    if (
      payment.refundedAmount !== undefined &&
      (await this.#hasColumn(this.#paymentModel, 'refunded_amount'))
    ) {
      row.refundedAmount = payment.refundedAmount;
    }
    row.payload = payment.payload ?? {};
    await row.save();
    return row;
  }

  async findPaymentByGatewayId(gatewayId: string): Promise<PaymentInstance | null> {
    await this.#ready();
    const row = await this.#paymentModel.findBy('gateway_id', gatewayId);
    return row as PaymentInstance | null;
  }

  async findPaymentByExternalReference(reference: string): Promise<PaymentInstance | null> {
    await this.#ready();
    // An install that has not run an earlier schema has no column to match on,
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

  async listPayments(query: PaymentListQuery): Promise<PaymentListItem[]> {
    await this.#ready();
    const builder = this.#paymentModel.query().orderBy('created_at', 'desc');
    if (query.status !== undefined) builder.where('status', query.status);
    if (query.provider !== undefined) builder.where('provider', query.provider);
    if (query.gatewayId !== undefined) builder.where('gateway_id', query.gatewayId);
    if (query.customerId !== undefined) builder.where('customer_id', query.customerId);
    // Guarded like `findPaymentByExternalReference`: an install that has not run the ALTER has
    // no column to match on, and every row it holds would answer nothing anyway. Returning an
    // empty page beats raising `column "external_reference" does not exist` at a filter box.
    if (query.externalReference !== undefined) {
      if (!(await this.#hasColumn(this.#paymentModel, 'external_reference'))) return [];
      builder.where('external_reference', query.externalReference);
    }
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
      // `bigint` arrives as a STRING on Postgres, and `undefined` on an install whose table
      // predates the column — both normalize to the same honest answer.
      refundedAmount:
        row.refundedAmount === null || row.refundedAmount === undefined
          ? null
          : Number(row.refundedAmount),
      paidAt: toDate(row.paidAt),
      createdAt: toDate(row.createdAt),
    }));
  }

  async countPayments(query: BillingCountQuery): Promise<number> {
    await this.#ready();
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
    await this.#ready();
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
    await this.#ready();
    if (!(await this.#hasDisputesTable())) return null;
    return (await this.#disputeModel.findBy('gateway_id', gatewayId)) as DisputeInstance | null;
  }

  async findOpenDisputeByPayment(paymentGatewayId: string): Promise<DisputeInstance | null> {
    await this.#ready();
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
    await this.#ready();
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
    await this.#ready();
    if (!(await this.#hasDisputesTable())) return 0;
    const builder = this.#disputeModel.query().count('* as total').pojo();
    if (query.status !== undefined) builder.where('status', query.status);
    if (query.createdBefore !== undefined) builder.where('created_at', '<', query.createdBefore);
    if (query.createdAfter !== undefined) builder.where('created_at', '>=', query.createdAfter);
    return toCount(await builder);
  }

  async listDisputesDueWithin(query: DisputeDeadlineQuery): Promise<DisputeListItem[]> {
    await this.#ready();
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
    await this.#ready();
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

  async listOpenDisputes(query: OpenDisputeQuery): Promise<DisputeListItem[]> {
    await this.#ready();
    if (!(await this.#hasDisputesTable())) return [];
    // Oldest FIRST, and it is the opposite of every other list here. With no deadline to sort
    // on, "nobody has answered this for eleven days" is the only priority signal there is.
    const builder = this.#disputeModel
      .query()
      .whereIn('status', [...OPEN_DISPUTE_STATUSES])
      .orderBy('created_at', 'asc');
    if (query.provider !== undefined) builder.where('provider', query.provider);
    const rows = (await builder
      .limit(clampLimit(query.limit))
      .offset(clampOffset(query.offset))) as DisputeInstance[];
    return rows.map(disputeItem);
  }

  async countOpenDisputes(query: { provider?: string }): Promise<number> {
    await this.#ready();
    if (!(await this.#hasDisputesTable())) return 0;
    const builder = this.#disputeModel
      .query()
      .whereIn('status', [...OPEN_DISPUTE_STATUSES])
      .count('* as total')
      .pojo();
    if (query.provider !== undefined) builder.where('provider', query.provider);
    return toCount(await builder);
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
  }): Promise<AuditEventListItem | null> {
    await this.#ready();
    if (!(await this.#hasAuditTable())) return null;
    const row = new this.#auditEventModel() as AuditEventInstance;
    row.action = event.action;
    row.actor = event.actor ?? null;
    row.provider = event.provider ?? null;
    row.subjectType = event.subjectType ?? null;
    row.subjectId = event.subjectId ?? null;
    row.amount = event.amount ?? null;
    row.currency = event.currency ?? null;
    row.message = event.message ?? null;
    row.metadata = event.metadata ?? null;
    if (event.createdAt !== undefined) row.createdAt = DateTime.fromJSDate(event.createdAt);
    await row.save();
    return auditItem(row);
  }

  async listAuditEvents(query: AuditEventQuery): Promise<AuditEventListItem[]> {
    await this.#ready();
    if (!(await this.#hasAuditTable())) return [];
    const builder = this.#auditEventModel.query().orderBy('created_at', 'desc');
    this.#applyAuditFilters(builder, query);
    const rows = (await builder
      .limit(clampLimit(query.limit))
      .offset(clampOffset(query.offset))) as AuditEventInstance[];
    return rows.map(auditItem);
  }

  async countAuditEvents(query: AuditEventCountQuery): Promise<number> {
    await this.#ready();
    if (!(await this.#hasAuditTable())) return 0;
    const builder = this.#auditEventModel.query().count('* as total').pojo();
    this.#applyAuditFilters(builder, query);
    return toCount(await builder);
  }

  /** The audit filter, applied identically by the list and the count — see `#matchesCount`'s
   *  note in the in-memory store: a bound one of them ignored would report a healthy zero. */
  #applyAuditFilters(
    builder: {
      where(column: string, value: unknown): unknown;
      where(column: string, operator: string, value: unknown): unknown;
      whereIn(column: string, values: unknown[]): unknown;
    },
    query: AuditEventCountQuery,
  ): void {
    if (query.action !== undefined) builder.where('action', query.action);
    if (query.actions !== undefined) builder.whereIn('action', [...query.actions]);
    if (query.actor !== undefined) builder.where('actor', query.actor);
    if (query.provider !== undefined) builder.where('provider', query.provider);
    if (query.subjectType !== undefined) builder.where('subject_type', query.subjectType);
    if (query.subjectId !== undefined) builder.where('subject_id', query.subjectId);
    if (query.createdBefore !== undefined) builder.where('created_at', '<', query.createdBefore);
    if (query.createdAfter !== undefined) builder.where('created_at', '>=', query.createdAfter);
  }

  async recordWebhookEvent(event: {
    gatewayEventId: string;
    provider: string;
    type: string;
    payload: Record<string, unknown>;
    normalized?: unknown;
  }): Promise<WebhookEventInstance | null> {
    await this.#ready();
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
    await this.#ready();
    const row = await this.#webhookEventModel.find(id);
    if (row) {
      row.status = 'processed';
      await row.save();
    }
  }

  async markWebhookFailed(id: string, error: string): Promise<void> {
    await this.#ready();
    const row = await this.#webhookEventModel.find(id);
    if (row) {
      row.status = 'failed';
      row.error = error;
      await row.save();
    }
  }

  async listWebhookEvents(query: WebhookEventListQuery): Promise<WebhookEventListItem[]> {
    await this.#ready();
    const builder = this.#webhookEventModel.query().orderBy('created_at', 'desc');
    if (query.status !== undefined) builder.where('status', query.status);
    if (query.provider !== undefined) builder.where('provider', query.provider);
    if (query.type !== undefined) builder.where('type', query.type);
    const rows = (await builder
      .limit(clampLimit(query.limit))
      .offset(clampOffset(query.offset))) as WebhookEventInstance[];
    return rows.map(webhookEventItem);
  }

  async listWebhookEventsForPayment(
    paymentGatewayId: string,
    query: { limit?: number } = {},
  ): Promise<WebhookEventListItem[]> {
    await this.#ready();
    // An empty needle would match the whole table — the timeline of "no payment at all".
    if (paymentGatewayId === '') return [];
    // The payload column's type differs per dialect (JSONB / JSON / TEXT) and only one of the
    // three can be compared to a string directly, so it is cast. MySQL spells the text type
    // `CHAR`; Postgres and SQLite take `TEXT`.
    const dialect = detectDialect(
      this.#webhookEventModel.query().client as unknown as LucidDatabase,
    );
    const textType = /mysql|mariadb/i.test(dialect ?? '') ? 'CHAR' : 'TEXT';
    const rows = (await this.#webhookEventModel
      .query()
      .whereRaw(`CAST(payload AS ${textType}) LIKE ?`, [`%${paymentGatewayId}%`])
      .orderBy('created_at', 'desc')
      .limit(clampLimit(query.limit))) as WebhookEventInstance[];
    return rows.map(webhookEventItem);
  }

  async findWebhookEventByGatewayEventId(
    gatewayEventId: string,
  ): Promise<WebhookEventListItem | null> {
    await this.#ready();
    const row = (await this.#webhookEventModel.findBy(
      'gateway_event_id',
      gatewayEventId,
    )) as WebhookEventInstance | null;
    if (!row) return null;
    return webhookEventItem(row);
  }

  async countWebhookEvents(query: BillingCountQuery): Promise<number> {
    await this.#ready();
    const builder = this.#webhookEventModel.query().count('* as total').pojo();
    if (query.status !== undefined) builder.where('status', query.status);
    if (query.createdBefore !== undefined) builder.where('created_at', '<', query.createdBefore);
    if (query.createdAfter !== undefined) builder.where('created_at', '>=', query.createdAfter);
    return toCount(await builder);
  }

  async webhookEventBreakdown(query: BillingCountQuery): Promise<WebhookEventBreakdownLine[]> {
    await this.#ready();
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
    await this.#ready();
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
    await this.#ready();
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
    await this.#ready();
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
    await this.#ready();
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
