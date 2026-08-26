import type { NormalizeConstructor } from '@adonisjs/core/types/helpers';
import { BaseModel, column } from '@adonisjs/lucid/orm';
import type { DateTime } from 'luxon';

/**
 * The Lucid model backing the `billing_payments` table. Mirrors the gateway payment —
 * kept locally so webhook processing and the app can query payment history without
 * calling the gateway API.
 */
export class BillingPayment extends BaseModel {
  @column({ isPrimary: true })
  declare id: string;

  /** Gateway payment id (Stripe `pi_...`, Asaas `pay_...`, Woovi cobr `globalID`). */
  @column()
  declare gatewayId: string;

  @column()
  declare provider: string;

  @column()
  declare status: string;

  @column()
  declare amount: number;

  @column()
  declare currency: string;

  @column({ serializeAs: null })
  declare customerId: string | null;

  @column({ serializeAs: null })
  declare subscriptionId: string | null;

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

      @column()
      declare amount: number;

      @column()
      declare currency: string;

      @column({ serializeAs: null })
      declare customerId: string | null;

      @column({ serializeAs: null })
      declare subscriptionId: string | null;

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
