import type { NormalizeConstructor } from '@adonisjs/core/types/helpers';
import { BaseModel, column } from '@adonisjs/lucid/orm';
import type { DateTime } from 'luxon';

/**
 * The Lucid model backing the `billing_subscriptions` table.
 *
 * Apps can either use this model directly, or compose `withSubscription()` into their own
 * model. Stores resolve it through the config (`billing.subscriptionModel`).
 */
export class BillingSubscription extends BaseModel {
  @column({ isPrimary: true })
  declare id: string;

  /** Gateway subscription id (Stripe `sub_...`, Asaas `sub_...`, Woovi `globalID`). */
  @column()
  declare gatewayId: string;

  @column()
  declare provider: string;

  @column()
  declare status: string;

  @column()
  declare planId: string;

  @column({ serializeAs: null })
  declare customerId: string;

  @column.dateTime({ serializeAs: null })
  declare trialEndsAt: DateTime | null;

  @column.dateTime({ serializeAs: null })
  declare endsAt: DateTime | null;

  @column({ serializeAs: null })
  declare payload: Record<string, unknown>;

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime;

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime;
}

/** Instância composta pelo mixin {@link withSubscription}. */
export interface SubscriptionRow {
  gatewayId: string;
  provider: string;
  status: string;
  planId: string;
  customerId: string;
  trialEndsAt: DateTime | null;
  endsAt: DateTime | null;
  payload: Record<string, unknown>;
  createdAt: DateTime;
  updatedAt: DateTime;
}

export type SubscriptionMixinClass<Model extends NormalizeConstructor<typeof BaseModel>> = Model & {
  new (...args: any[]): SubscriptionRow;
};

/**
 * Mixin to attach subscription columns/relationships to a custom model.
 *
 * ```ts
 * export default class Subscription extends compose(BaseModel, withSubscription()) {
 *   @column({ isPrimary: true }) declare id: string
 * }
 * ```
 */
export function withSubscription() {
  return <Model extends NormalizeConstructor<typeof BaseModel>>(
    superclass: Model,
  ): SubscriptionMixinClass<Model> => {
    class SubscriptionMixin extends superclass {
      @column()
      declare gatewayId: string;

      @column()
      declare provider: string;

      @column()
      declare status: string;

      @column()
      declare planId: string;

      @column({ serializeAs: null })
      declare customerId: string;

      @column.dateTime({ serializeAs: null })
      declare trialEndsAt: DateTime | null;

      @column.dateTime({ serializeAs: null })
      declare endsAt: DateTime | null;

      @column({ serializeAs: null })
      declare payload: Record<string, unknown>;

      @column.dateTime({ autoCreate: true })
      declare createdAt: DateTime;

      @column.dateTime({ autoCreate: true, autoUpdate: true })
      declare updatedAt: DateTime;
    }
    return SubscriptionMixin;
  };
}
