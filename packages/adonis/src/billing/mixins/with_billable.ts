import type { NormalizeConstructor } from '@adonisjs/core/types/helpers';
import { BaseModel, column } from '@adonisjs/lucid/orm';
import type { DateTime } from 'luxon';

/** Instância composta pelo mixin {@link withBillable}. */
export interface BillableRow {
  billingCustomerId: string | null;
  billingProvider: string | null;
  billingTrialEndsAt: DateTime | null;
}

export type BillableClass<Model extends NormalizeConstructor<typeof BaseModel>> = Model & {
  new (...args: any[]): BillableRow;
};

/**
 * Adds billing customer columns/relationships to a Lucid model (typically the User).
 *
 * ```ts
 * export default class User extends compose(BaseModel, withBillable()) {
 *   @column({ isPrimary: true }) declare id: string
 * }
 * ```
 */
export function withBillable() {
  return <Model extends NormalizeConstructor<typeof BaseModel>>(
    superclass: Model,
  ): BillableClass<Model> => {
    class BillableUser extends superclass {
      /** Gateway customer id (Stripe `cus_...`, Asaas `cus_...`). */
      @column({ serializeAs: null })
      declare billingCustomerId: string | null;

      /** The gateway provider this customer belongs to (e.g. `'stripe'`). */
      @column({ serializeAs: null })
      declare billingProvider: string | null;

      /** Generic trial end date — used by gateways without native trials (e.g. Woovi). */
      @column.dateTime({ serializeAs: null })
      declare billingTrialEndsAt: DateTime | null;
    }
    return BillableUser;
  };
}
