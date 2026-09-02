import type { BillingStore } from './billing/billing_store.js';
import {
  cancelManagedSubscription,
  createManagedSubscription,
  type RenewalOutcome,
  renewDueManagedSubscriptions,
  updateManagedSubscription,
} from './billing/managed_subscriptions.js';
import type { CreateSubscriptionInput, PaymentsDriver } from './driver.js';
import { resolveSubscriptionMode, type SubscriptionMode } from './subscription_mode.js';
import type { Payment } from './types.js';

/** Creating a subscription, either way. */
export interface CreateSubscriptionRequest extends CreateSubscriptionInput {
  /** Payment method or provider name, resolved exactly like `payments.driver(...)`. */
  via?: string;
  /**
   * Force the mode for this one call, overriding config. `true` means the library owns the
   * recurrence; `false` means the gateway does.
   */
  managed?: boolean;
  currency?: string;
}

/** What a caller gets back, whichever side owns the recurrence. */
export interface SubscriptionHandle {
  /** The id to cancel/update with. The local row in managed mode, the gateway id otherwise. */
  id: string;
  mode: SubscriptionMode;
  provider: string;
  status: string;
  /** `null` in managed mode — no gateway subscription exists. */
  gatewayId: string | null;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  /** Managed mode only: the first cycle's charge, so a Pix QR code is available at once. */
  charge?: Payment;
}

export interface SubscriptionsApiDeps {
  resolveDriver: (via?: string) => PaymentsDriver;
  /** Lazy: the store exists only after the provider has booted the billing layer. */
  store: () => BillingStore;
  mode: (provider: string, managedOnCall?: boolean) => SubscriptionMode;
  assertGatewayCan: (driver: PaymentsDriver, op: 'create' | 'update' | 'cancel') => void;
}

/**
 * One place to create, cancel and re-price a subscription, whoever owns the recurrence.
 *
 * The two modes are genuinely different products — one is a gateway object you administer in
 * the gateway's dashboard, the other is rows in your database and a charge per cycle — and
 * teams legitimately want either. What they should not have to write is the branch between
 * them at every call site, because that branch is where "Woovi cannot cancel" ends up
 * hard-coded into an application that should never have heard of Woovi.
 */
export class SubscriptionsApi {
  #deps: SubscriptionsApiDeps;

  constructor(deps: SubscriptionsApiDeps) {
    this.#deps = deps;
  }

  async create(request: CreateSubscriptionRequest): Promise<SubscriptionHandle> {
    const { via, managed, currency, ...input } = request;
    const driver = this.#deps.resolveDriver(via);
    const mode = this.#deps.mode(driver.provider, managed);

    if (mode === 'gateway') {
      this.#deps.assertGatewayCan(driver, 'create');
      const subscription = await driver.createSubscription(input);
      return {
        id: subscription.gatewayId,
        mode,
        provider: driver.provider,
        status: subscription.status,
        gatewayId: subscription.gatewayId,
      };
    }

    const result = await createManagedSubscription(driver, this.#deps.store(), {
      ...input,
      ...(currency !== undefined ? { currency } : {}),
    });
    return {
      id: result.id,
      mode,
      provider: driver.provider,
      status: result.status,
      gatewayId: null,
      currentPeriodStart: result.currentPeriodStart,
      currentPeriodEnd: result.currentPeriodEnd,
      charge: result.charge,
    };
  }

  /**
   * Cancel by the id `create` returned.
   *
   * In managed mode this never reaches the gateway, which is the entire reason the mode
   * exists: it works on gateways that cannot cancel a subscription at all.
   */
  async cancel(
    id: string,
    options: { via?: string; managed?: boolean; atPeriodEnd?: boolean } = {},
  ): Promise<void> {
    const driver = this.#deps.resolveDriver(options.via);
    const mode = this.#deps.mode(driver.provider, options.managed);

    if (mode === 'gateway') {
      this.#deps.assertGatewayCan(driver, 'cancel');
      await driver.cancelSubscription(id, {
        ...(options.atPeriodEnd !== undefined ? { atPeriodEnd: options.atPeriodEnd } : {}),
      });
      return;
    }

    await cancelManagedSubscription(this.#deps.store(), id, {
      ...(options.atPeriodEnd !== undefined ? { atPeriodEnd: options.atPeriodEnd } : {}),
    });
  }

  /** Re-price or re-describe. In managed mode it takes effect on the next cycle. */
  async update(
    id: string,
    patch: { amount?: number; description?: string | null; cycle?: string },
    options: { via?: string; managed?: boolean } = {},
  ): Promise<void> {
    const driver = this.#deps.resolveDriver(options.via);
    const mode = this.#deps.mode(driver.provider, options.managed);

    if (mode === 'gateway') {
      this.#deps.assertGatewayCan(driver, 'update');
      await driver.updateSubscription(id, {
        ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
        ...(patch.description != null ? { description: patch.description } : {}),
      });
      return;
    }

    await updateManagedSubscription(this.#deps.store(), id, patch);
  }

  /**
   * Managed subscriptions due at or before `now`, WITHOUT charging anything.
   *
   * What `payments:renew --dry-run` reads. It runs the same store query the real pass does,
   * so the preview cannot disagree with what would actually happen.
   */
  async due(options: { now?: Date; limit?: number } = {}): Promise<{ id: string }[]> {
    const rows = await this.#deps
      .store()
      .listDueManagedSubscriptions(options.now ?? new Date(), options.limit ?? 100);
    return (rows as unknown as { id: string }[]).map((row) => ({ id: row.id }));
  }

  /**
   * Charge every managed subscription whose cycle is due. Drive it from `payments:renew`
   * (a cron, a durable schedule) — nothing renews on its own.
   */
  async renewDue(options: { now?: Date; limit?: number } = {}): Promise<RenewalOutcome[]> {
    return renewDueManagedSubscriptions(
      (provider) => this.#deps.resolveDriver(provider),
      this.#deps.store(),
      options,
    );
  }
}

export { resolveSubscriptionMode };
