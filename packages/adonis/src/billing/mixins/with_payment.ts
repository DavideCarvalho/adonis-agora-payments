import { randomUUID } from 'node:crypto';
import type { NormalizeConstructor } from '@adonisjs/core/types/helpers';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import type { DateTime } from 'luxon';

/**
 * The Lucid model backing the `billing_payments` table. Mirrors the gateway payment —
 * kept locally so webhook processing and the app can query payment history without
 * calling the gateway API.
 */
export class BillingPayment extends BaseModel {
  /**
   * The `id` column is a `uuid` with no database-side default (see the published
   * migration), so nothing but this hook fills it. Generating it here rather than in the
   * migration keeps every supported dialect working — `gen_random_uuid()` is Postgres-only
   * — and means an app that already ran the migration needs no new one.
   */
  @beforeCreate()
  static assignUuid(row: BillingPayment): void {
    if (!row.id) row.id = randomUUID();
  }

  @column({ isPrimary: true })
  declare id: string;

  /** Gateway payment id (Stripe `pi_...`, Asaas `pay_...`, Woovi cobr `globalID`). */
  @column()
  declare gatewayId: string;

  @column()
  declare provider: string;

  @column()
  declare status: string;

  /**
   * Minor units, as an integer — and `consume` is what makes that true on Postgres.
   *
   * The column is `BIGINT`, and node-postgres returns bigints as STRINGS: reading beyond
   * 2^53 would lose precision silently, so it refuses to guess. The type here said `number`
   * and the value was `'1990'`, which means `payment.amount + fee` concatenated instead of
   * adding. `Number()` is safe for this column specifically: these are minor units, and 2^53
   * of them is ninety trillion reais.
   */
  @column({ consume: (value: unknown) => (value === null ? null : Number(value)) })
  declare amount: number;

  @column()
  declare currency: string;

  @column({ serializeAs: null })
  declare customerId: string | null;

  @column({ serializeAs: null })
  declare subscriptionId: string | null;

  /**
   * The app's own id for this charge (`ChargeInput.externalReference`), as the gateway
   * echoed it back on the webhook. Nullable, and indexed — this is the key an app looks a
   * payment up by, and an unindexed one on a table that grows with every charge is a
   * sequential scan on the hot path.
   *
   * `null` on rows written before an earlier schema ran.
   */
  @column()
  declare externalReference: string | null;

  /**
   * How much of {@link BillingPayment.amount} has been refunded, in the SAME integer minor
   * units. `0` on a charge nothing came back from, `null` on a row written before an earlier
   * schema ran.
   *
   * It exists because a PARTIAL refund had nowhere to be recorded: the only honest options
   * were to overwrite `status` with `refunded` (writing off the whole charge) or to drop the
   * event, and the library dropped it — so a R$10 refund on a R$100 charge left R$100 of
   * revenue standing forever. Net revenue is `amount - refunded_amount`; NEVER divide either.
   *
   * Same `consume` as `amount`, and for the same reason: the column is `BIGINT` and
   * node-postgres hands bigints back as strings.
   */
  @column({ consume: (value: unknown) => (value === null ? null : Number(value)) })
  declare refundedAmount: number | null;

  @column({ serializeAs: null })
  declare payload: Record<string, unknown>;

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime;

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime;

  @column.dateTime({ serializeAs: null })
  declare paidAt: DateTime | null;
}

/** Instância composta pelo mixin {@link withPayment}. */
export interface PaymentRow {
  gatewayId: string;
  provider: string;
  status: string;
  amount: number;
  currency: string;
  customerId: string | null;
  subscriptionId: string | null;
  externalReference: string | null;
  /** Integer minor units already refunded. See {@link BillingPayment.refundedAmount}. */
  refundedAmount: number | null;
  payload: Record<string, unknown>;
  createdAt: DateTime;
  updatedAt: DateTime;
  paidAt: DateTime | null;
}

export type PaymentMixinClass<Model extends NormalizeConstructor<typeof BaseModel>> = Model & {
  new (...args: any[]): PaymentRow;
};

/**
 * Mixin to attach payment columns to a custom model.
 */
export function withPayment() {
  return <Model extends NormalizeConstructor<typeof BaseModel>>(
    superclass: Model,
  ): PaymentMixinClass<Model> => {
    class PaymentMixin extends superclass {
      @column()
      declare gatewayId: string;

      @column()
      declare provider: string;

      @column()
      declare status: string;

      // See the note on `BillingPayment.amount`: BIGINT arrives as a string on Postgres.
      @column({ consume: (value: unknown) => (value === null ? null : Number(value)) })
      declare amount: number;

      @column()
      declare currency: string;

      @column({ serializeAs: null })
      declare customerId: string | null;

      @column({ serializeAs: null })
      declare subscriptionId: string | null;

      /** See {@link BillingPayment.externalReference}. */
      @column()
      declare externalReference: string | null;

      /** See {@link BillingPayment.refundedAmount}. Integer minor units; NEVER divide. */
      @column({ consume: (value: unknown) => (value === null ? null : Number(value)) })
      declare refundedAmount: number | null;

      @column({ serializeAs: null })
      declare payload: Record<string, unknown>;

      @column.dateTime({ autoCreate: true })
      declare createdAt: DateTime;

      @column.dateTime({ autoCreate: true, autoUpdate: true })
      declare updatedAt: DateTime;

      @column.dateTime({ serializeAs: null })
      declare paidAt: DateTime | null;
    }
    return PaymentMixin;
  };
}
