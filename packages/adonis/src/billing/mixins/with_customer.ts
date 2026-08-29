import { randomUUID } from 'node:crypto';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import type { DateTime } from 'luxon';

/**
 * The Lucid model backing the `billing_customers` table — the polymorphic mapping between
 * an app's own rows and the customers they have at each gateway.
 *
 * It is deliberately NOT the primary lookup path: the [Billable mixin](./with_billable.js)
 * keeps `billingCustomerId` on the app's own model, and that is what a charge reads. This
 * table exists for the questions that one cannot answer — enumerating every gateway
 * customer (which is what `payments:sync --all` reconciles over), and holding a mapping for
 * an owner that has customers at MORE than one gateway, where a single column on the user
 * row has nowhere to put the second.
 */
export class BillingCustomer extends BaseModel {
  /**
   * The `id` column is a `uuid` with no database-side default (see the published
   * migration), so nothing but this hook fills it. Generating it here rather than in the
   * migration keeps every supported dialect working — `gen_random_uuid()` is Postgres-only
   * — and means an app that already ran the migration needs no new one.
   */
  @beforeCreate()
  static assignUuid(row: BillingCustomer): void {
    if (!row.id) row.id = randomUUID();
  }

  @column({ isPrimary: true })
  declare id: string;

  /** The app-side model this customer belongs to, e.g. `'User'`. Free-form. */
  @column()
  declare ownerType: string | null;

  /** The app-side row id, stringified — ids are not uniformly numeric across apps. */
  @column()
  declare ownerId: string | null;

  /** The gateway's customer id (Stripe `cus_...`, Asaas `cus_...`). Unique. */
  @column()
  declare gatewayId: string;

  /** Which configured provider the `gatewayId` belongs to. */
  @column()
  declare provider: string;

  @column()
  declare email: string | null;

  @column()
  declare name: string | null;

  /** CPF/CNPJ (BR gateways) or tax id. */
  @column()
  declare taxId: string | null;

  @column({ serializeAs: null })
  declare metadata: Record<string, unknown> | null;

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime;

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime;
}
