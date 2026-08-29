import type { BillingStore } from '../billing/billing_store.js';
import type { WebhookDispatcher } from '../billing/webhook_dispatcher.js';
import type { PaymentsDriver } from '../driver.js';
import { PaymentsManager } from '../payments_manager.js';
import type { PaymentMethodName } from '../types.js';

/**
 * Lazy singleton accessor for the payments manager. Set by the provider when it builds
 * the manager; importing this module never triggers the app boot (media/authkit pattern).
 */
let payments: PaymentsManager | undefined;

export function getPayments(): PaymentsManager {
  if (!payments) {
    throw new Error(
      '[payments] PaymentsManager is not ready yet. Make sure the PaymentsProvider is registered and the app has booted.',
    );
  }
  return payments;
}

/** The manager if there is one, without the throw — for callers that can handle absence. */
export function findPayments(): PaymentsManager | undefined {
  return payments;
}

/** Set by the provider once the manager is built. */
export function setPayments(manager: PaymentsManager): void {
  payments = manager;
}

/**
 * The billing store the provider resolved from `config.billing.store` — the Lucid
 * store over the published tables unless the app configured another one.
 *
 * `@inject()`-ing `LucidBillingStore` covers the default case; this accessor is what
 * reaches a **custom** store, which has no class to use as a DI token.
 */
let billingStore: BillingStore | undefined;

export function getBillingStore(): BillingStore {
  if (!billingStore) {
    throw new Error(
      '[payments] The billing store is not ready yet. Make sure the PaymentsProvider is registered, the app has booted, and `billing.enabled` is not false.',
    );
  }
  return billingStore;
}

/** The store if there is one, without the throw. */
export function findBillingStore(): BillingStore | undefined {
  return billingStore;
}

/** Set by the provider once the store is resolved. */
export function setBillingStore(store: BillingStore): void {
  billingStore = store;
}

/**
 * The webhook dispatcher the provider built for this app, when the billing layer is on.
 *
 * Published for the same reason as the store: it is built inside the provider from config
 * nothing else can reconstruct, and tests need to reach it — `flushWebhooks()` in
 * `@adonis-agora/payments/testing` is the whole reason it is here.
 */
let webhookDispatcher: WebhookDispatcher | undefined;

export function getWebhookDispatcher(): WebhookDispatcher {
  if (!webhookDispatcher) {
    throw new Error(
      '[payments] The webhook dispatcher is not ready yet. Make sure the PaymentsProvider is ' +
        'registered, the app has booted, and `billing.enabled` is not false.',
    );
  }
  return webhookDispatcher;
}

/** The dispatcher if there is one, without throwing — for callers that can do nothing. */
export function findWebhookDispatcher(): WebhookDispatcher | undefined {
  return webhookDispatcher;
}

/** Set by the provider once the billing layer is built. */
export function setWebhookDispatcher(dispatcher: WebhookDispatcher | undefined): void {
  webhookDispatcher = dispatcher;
}

/**
 * A stand-in that resolves the real singleton on FIRST PROPERTY ACCESS, not when it is
 * built.
 *
 * `getPayments()` throws until the provider's `booted()` hook runs, and providers that
 * registered earlier boot first — `@adonis-agora/durable` boots workflows whose services are
 * constructed before payments has set anything. So `private payments = getPayments()` in a
 * constructor throws, and every app hits it: the ecosystem app that found this had the SAME
 * four-line comment copy-pasted into four files explaining why it could not resolve in a
 * constructor.
 *
 * These accessors make the field initializer safe. Nothing is resolved until the service
 * actually CALLS something, which by definition happens after boot.
 *
 * ```ts
 * export default class GrantAccess {
 *   #payments = lazyPayments()          // safe in a field initializer
 *   #store = lazyBillingStore()
 *   #pix = lazyPaymentsDriver('pix')
 * }
 * ```
 *
 * `getPayments()`/`getBillingStore()` are unchanged for callers that WANT the eager throw —
 * a `start/` file asserting the wiring is right is a legitimate use of it.
 */
function lazyProxy<T extends object>(resolve: () => T, prototype: object): T {
  // `Object.create(prototype)` rather than `{}`: `instanceof PaymentsManager` and
  // `Object.getPrototypeOf` then answer what a caller expects, and a Proxy may not lie about
  // an invariant its target does not have.
  return new Proxy(Object.create(prototype) as T, {
    get(_target, property) {
      const instance = resolve();
      const value = Reflect.get(instance as object, property, instance) as unknown;
      // Bound to the instance, never to the proxy: these classes read `#private` fields, and
      // a proxy is not the object those belong to.
      return typeof value === 'function' ? value.bind(instance) : value;
    },
    set(_target, property, value) {
      return Reflect.set(resolve() as object, property, value);
    },
    has(_target, property) {
      return Reflect.has(resolve() as object, property);
    },
    getPrototypeOf() {
      return prototype;
    },
  });
}

/** A {@link PaymentsManager} that resolves on first use. Safe in a field initializer. */
export function lazyPayments(): PaymentsManager {
  return lazyProxy(getPayments, PaymentsManager.prototype);
}

/** The billing store, resolved on first use. Safe in a field initializer. */
export function lazyBillingStore(): BillingStore {
  return lazyProxy(getBillingStore, Object.prototype);
}

/**
 * One driver — by method or by provider name — resolved on first use.
 *
 * The shape the ecosystem app actually wanted: `private driver = lazyPaymentsDriver('pix')`.
 * Note the routing is resolved lazily too, so a driver named in `config.methods` does not
 * have to exist yet when the field is initialized.
 */
export function lazyPaymentsDriver(methodOrName?: PaymentMethodName | string): PaymentsDriver {
  return lazyProxy(() => getPayments().driver(methodOrName), Object.prototype);
}

/**
 * Forget the resolved singletons.
 *
 * Exists for tests: `@adonis-agora/payments/testing`'s `swapPayments()` restores what was
 * there before, and "before" is legitimately *nothing at all* — the app under test may never
 * have booted a provider. Without this, a restore had to call `setPayments` with a value it
 * did not have.
 */
export function resetPayments(): void {
  payments = undefined;
}

export function resetBillingStore(): void {
  billingStore = undefined;
}

export default getPayments;
