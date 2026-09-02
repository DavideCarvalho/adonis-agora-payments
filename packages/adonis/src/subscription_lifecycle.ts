import type { PaymentsDriver } from './driver.js';

/** The three lifecycle operations a gateway either performs or does not. */
export type SubscriptionOperation = 'create' | 'update' | 'cancel';

/** What a gateway does itself, once defaults are applied. */
export interface ResolvedSubscriptionLifecycle {
  create: boolean;
  update: boolean;
  cancel: boolean;
}

/**
 * What a driver's GATEWAY actually performs, reading `capabilities.subscriptionLifecycle`
 * and falling back to the coarse `capabilities.subscriptions`.
 *
 * The fallback is what keeps this additive: a driver written before the finer flag existed
 * said `subscriptions: true` and meant all three, so that is what it keeps meaning. Only a
 * driver that spells out the exception gets a different answer.
 */
export function gatewaySubscriptionLifecycle(
  driver: PaymentsDriver,
): ResolvedSubscriptionLifecycle {
  const coarse = driver.capabilities?.subscriptions === true;
  const fine = driver.capabilities?.subscriptionLifecycle;
  return {
    create: fine?.create ?? coarse,
    update: fine?.update ?? coarse,
    cancel: fine?.cancel ?? coarse,
  };
}

/** Whether the gateway behind `driver` performs `operation` itself. */
export function gatewayPerforms(driver: PaymentsDriver, operation: SubscriptionOperation): boolean {
  return gatewaySubscriptionLifecycle(driver)[operation];
}
