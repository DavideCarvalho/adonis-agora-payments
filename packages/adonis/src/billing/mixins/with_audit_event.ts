import { randomUUID } from 'node:crypto';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import type { DateTime } from 'luxon';

/**
 * The Lucid model backing the `billing_audit_events` table — what HAPPENED to this install
 * that no other table records.
 *
 * The three built-in actions all had exactly one trace before this existed, and it was a
 * diagnostic: a line on an event bus that an app may not subscribe to, going to a log that has
 * usually rotated by the time somebody asks who refunded a customer in March.
 *
 * - `payment.refunded` — a refund issued from the console. The payment row itself only moves when
 *   the gateway's own webhook lands, and it never names a person.
 * - `dispute.resolved` — a dispute an operator closed by hand, because several gateways publish
 *   no lost-dispute event and the row would otherwise sit `open` forever.
 * - `webhook.rejected` — a delivery the endpoint refused (bad signature, unparsable body, unknown
 *   provider). It never becomes a ledger row, so a rotated webhook token looks like silence.
 *
 * Append-only by convention: nothing in this package updates a row after inserting it.
 */
export class BillingAuditEvent extends BaseModel {
  static override table = 'billing_audit_events';

  /**
   * Same reason as every other model here: the column is a `uuid` with no database-side default,
   * `gen_random_uuid()` is Postgres-only, and generating it in the hook keeps every dialect
   * working.
   */
  @beforeCreate()
  static assignUuid(row: BillingAuditEvent): void {
    if (!row.id) row.id = randomUUID();
  }

  @column({ isPrimary: true })
  declare id: string;

  /** `payment.refunded` | `dispute.resolved` | `webhook.rejected`, or an app's own. */
  @column()
  declare action: string;

  /** WHO did it, as the dashboard session knew them. `null` is "unattributed", not "the system". */
  @column()
  declare actor: string | null;

  @column()
  declare provider: string | null;

  @column()
  declare subjectType: string | null;

  @column()
  declare subjectId: string | null;

  /**
   * Integer minor units. `BIGINT`, and node-postgres hands bigints back as STRINGS — the same
   * `consume` `BillingPayment.amount` carries, and for the same reason: without it `amount + fee`
   * concatenates instead of adding.
   */
  @column({ consume: (value: unknown) => (value === null ? null : Number(value)) })
  declare amount: number | null;

  @column()
  declare currency: string | null;

  @column()
  declare message: string | null;

  @column()
  declare metadata: Record<string, unknown> | null;

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime;

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime;
}
