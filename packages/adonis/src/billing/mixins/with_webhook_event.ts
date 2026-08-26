import { BaseModel, column } from '@adonisjs/lucid/orm';
import type { DateTime } from 'luxon';

/**
 * The Lucid model backing the `billing_webhook_events` table — the idempotency ledger.
 * Every webhook event is recorded here (keyed by gateway event id) so a re-delivered
 * webhook is never processed twice.
 */
export class BillingWebhookEvent extends BaseModel {
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

  /** Error message when processing failed. */
  @column({ serializeAs: null })
  declare error: string | null;

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime;

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime;
}
