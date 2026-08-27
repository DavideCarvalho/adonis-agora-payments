import { randomUUID } from 'node:crypto';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import type { DateTime } from 'luxon';

/**
 * The Lucid model backing the `billing_usage_events` table — a metered subscription's
 * consumption ledger. One row per usage event (e.g. an API call, a stored GB, a message);
 * the billing layer aggregates them per meter for a period to bill usage-based plans.
 */
export class BillingUsageEvent extends BaseModel {
  /**
   * The `id` column is a `uuid` with no database-side default (see the published
   * migration), so nothing but this hook fills it. Generating it here rather than in the
   * migration keeps every supported dialect working — `gen_random_uuid()` is Postgres-only
   * — and means an app that already ran the migration needs no new one.
   */
  @beforeCreate()
  static assignUuid(row: BillingUsageEvent): void {
    if (!row.id) row.id = randomUUID();
  }

  @column({ isPrimary: true })
  declare id: string;

  /** The subscription this usage belongs to, when metered against a subscription. */
  @column()
  declare subscriptionId: string | null;

  /** The customer this usage belongs to, when metered per customer. */
  @column()
  declare customerId: string | null;

  /** The meter name, e.g. `'api_calls'`, `'storage_gb'`, `'messages'`. */
  @column()
  declare meter: string;

  /** How much of the meter this event consumed (e.g. request count, GB, minutes). */
  @column()
  declare quantity: number;

  @column({ serializeAs: null })
  declare metadata: Record<string, unknown>;

  @column.dateTime({ autoCreate: true })
  declare recordedAt: DateTime;

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime;
}
