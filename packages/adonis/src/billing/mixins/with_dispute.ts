import { randomUUID } from 'node:crypto';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import type { DateTime } from 'luxon';

/**
 * The Lucid model backing the `billing_disputes` table — the only place a chargeback's
 * DEADLINE is written down.
 *
 * Until this table existed, `evidence_due_by` arrived on a webhook, was published once on
 * the diagnostics bus and was then gone: the question "which disputes are open, and which
 * windows close this week" could only be answered by opening every gateway's own dashboard,
 * one at a time. A window that closes unanswered loses the money by default rather than on
 * the merits, which makes this the one piece of billing state whose absence has a price tag.
 *
 * No mixin function ships beside it, unlike `withPayment`/`withSubscription`: a dispute row
 * is written by this library and read by operators, never composed onto an app's own model
 * the way a payment is. `BillingModels.disputeModel` still lets an app swap the model out.
 */
export class BillingDispute extends BaseModel {
  static override table = 'billing_disputes';

  /**
   * The `id` column is a `uuid` with no database-side default (see the published
   * migration), so nothing but this hook fills it. Generating it here rather than in the
   * migration keeps every supported dialect working — `gen_random_uuid()` is Postgres-only.
   */
  @beforeCreate()
  static assignUuid(row: BillingDispute): void {
    if (!row.id) row.id = randomUUID();
  }

  @column({ isPrimary: true })
  declare id: string;

  /**
   * The DISPUTE's own gateway id (Stripe `dp_...`, Adyen's dispute psp reference) — the
   * idempotency key, and the reason this column is unique.
   *
   * Several gateways send no dispute id at all. For those the processor synthesizes one
   * from the payment (`dispute:<provider>:<payment gateway id>`); see
   * `WebhookProcessor#disputeKey` for why, and for what that costs.
   */
  @column()
  declare gatewayId: string;

  /**
   * The DISPUTED PAYMENT's gateway id — the join back to `billing_payments.gateway_id`.
   * Indexed: it is how an operator gets from a dispute to the charge it is about.
   */
  @column()
  declare paymentGatewayId: string;

  @column()
  declare provider: string;

  /** One of `DisputeStatus`: `warning`, `open`, `under_review`, `won`, `lost`, `canceled`, `expired`. */
  @column()
  declare status: string;

  /** The gateway's own reason code, verbatim — the vocabulary is per-network. */
  @column()
  declare reason: string | null;

  /** Integer minor units, like every other amount in this package. Nullable: a pre-dispute
   *  alert (Stripe's early fraud warning) names a charge and a fraud type, and no money. */
  @column()
  declare amount: number | null;

  @column()
  declare currency: string | null;

  /**
   * When evidence must be submitted by. Nullable, because plenty of gateways send no
   * deadline at all — and a `null` here means "this gateway told us nothing", never "no
   * hurry". The health check only counts rows that carry one.
   */
  @column.dateTime()
  declare evidenceDueBy: DateTime | null;

  /** `won` / `lost` / `canceled` / `expired`, once the dispute closed. `null` while open. */
  @column()
  declare outcome: string | null;

  @column.dateTime()
  declare openedAt: DateTime | null;

  @column.dateTime()
  declare closedAt: DateTime | null;

  @column({ serializeAs: null })
  declare payload: Record<string, unknown>;

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime;

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime;
}
