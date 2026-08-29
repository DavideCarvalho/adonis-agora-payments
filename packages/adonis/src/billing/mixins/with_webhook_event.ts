import { randomUUID } from 'node:crypto';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import type { DateTime } from 'luxon';

/**
 * The Lucid model backing the `billing_webhook_events` table — the idempotency ledger.
 * Every webhook event is recorded here (keyed by gateway event id) so a re-delivered
 * webhook is never processed twice.
 */
export class BillingWebhookEvent extends BaseModel {
  /**
   * The `id` column is a `uuid` with no database-side default (see the published
   * migration), so nothing but this hook fills it. Generating it here rather than in the
   * migration keeps every supported dialect working — `gen_random_uuid()` is Postgres-only
   * — and means an app that already ran the migration needs no new one.
   */
  @beforeCreate()
  static assignUuid(row: BillingWebhookEvent): void {
    if (!row.id) row.id = randomUUID();
  }

  @column({ isPrimary: true })
  declare id: string;

  /** Gateway event id — the idempotency key. */
  @column()
  declare gatewayEventId: string;

  @column()
  declare provider: string;

  @column()
  declare type: string;

  @column()
  declare status: 'received' | 'processed' | 'failed';

  @column({ serializeAs: null })
  declare payload: Record<string, unknown>;

  /**
   * The NORMALIZED event (`WebhookEvent.data`) this delivery carried.
   *
   * Stored so the dashboard's retry can rebuild the event without calling `parseWebhook`,
   * which would re-verify a signature computed from headers the ledger never kept — the
   * reason a retry used to answer `422` on every gateway that signs its webhooks.
   *
   * `null` on rows written before an earlier schema ran; the
   * retry says so rather than replaying half an event.
   */
  @column({ serializeAs: null })
  declare normalized: Record<string, unknown> | null;

  /** Error message when processing failed. */
  @column({ serializeAs: null })
  declare error: string | null;

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime;

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime;
}
