import { randomUUID } from 'node:crypto';
import type { NormalizeConstructor } from '@adonisjs/core/types/helpers';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import type { DateTime } from 'luxon';

/**
 * The Lucid model backing the `billing_subscriptions` table.
 *
 * Apps can either use this model directly, or compose `withSubscription()` into their own
 * model. Stores resolve it through the config (`billing.subscriptionModel`).
 */
export class BillingSubscription extends BaseModel {
  /**
   * The `id` column is a `uuid` with no database-side default (see the published
   * migration), so nothing but this hook fills it. Generating it here rather than in the
   * migration keeps every supported dialect working — `gen_random_uuid()` is Postgres-only
   * — and means an app that already ran the migration needs no new one.
   */
  @beforeCreate()
  static assignUuid(row: BillingSubscription): void {
    if (!row.id) row.id = randomUUID();
  }

  @column({ isPrimary: true })
  declare id: string;

  /**
   * Gateway subscription id (Stripe `sub_...`, Asaas `sub_...`, Woovi `globalID`).
   *
   * `null` on a managed subscription: the library owns that recurrence and never created
   * anything at the gateway, so there is no id to hold. The column has always been nullable
   * — the type said otherwise, which also blocked the free-plan case where a row exists and
   * no gateway subscription does.
   */
  @column()
  declare gatewayId: string | null;

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

  // ── Managed subscriptions (`subscriptions.mode: 'managed'`) ─────────────────────────
  //
  // Null on a gateway-mode row, where the gateway holds all of this and is the truth. On a
  // managed one there is no gateway subscription to ask, so the recurrence is described
  // here and each cycle is issued as an ordinary charge.

  /** Whether this library drives the recurrence rather than the gateway. */
  @column()
  declare managed: boolean | null;

  /**
   * Amount per cycle, integer minor units — same unit as `billing_payments.amount`.
   *
   * `consume` for the same reason it is on that column: `BIGINT` comes back from
   * node-postgres as a STRING, because reading beyond 2^53 would lose precision silently.
   * Without it the renewal runner hands `'9900'` to `driver.charge({ amount })` — a string
   * where every driver expects a number, straight into the request that moves money.
   * `Number()` is safe here specifically: these are minor units, and 2^53 of them is ninety
   * trillion reais.
   */
  @column({ consume: (value: unknown) => (value === null ? null : Number(value)) })
  declare amount: number | null;

  @column()
  declare currency: string | null;

  /** `MONTHLY`, `YEARLY`, … — the cycle the period is advanced by on each renewal. */
  @column()
  declare cycle: string | null;

  /** Payment method each cycle's charge goes out on (`pix`, `credit_card`, …). */
  @column()
  declare method: string | null;

  @column()
  declare description: string | null;

  /**
   * The app's own reference, copied onto every cycle's charge.
   *
   * This is what makes managed mode route webhooks without any per-gateway special case: a
   * renewal arrives as a normal payment carrying the app's reference, exactly like a one-off.
   */
  @column()
  declare externalReference: string | null;

  @column.dateTime()
  declare currentPeriodStart: DateTime | null;

  @column.dateTime()
  declare currentPeriodEnd: DateTime | null;

  /** When the next cycle is due. `null` once the subscription stops renewing. */
  @column.dateTime()
  declare nextChargeAt: DateTime | null;

  /** Cancel requested, but the paid period is not over — stop renewing, keep access. */
  @column()
  declare cancelAtPeriodEnd: boolean | null;

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
