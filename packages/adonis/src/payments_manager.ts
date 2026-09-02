import type { BillingStore } from './billing/billing_store.js';
import type { PaymentsConfig } from './define_config.js';
import type { PaymentsDriver } from './driver.js';
import type { InvoiceManager } from './invoice/invoice_manager.js';
import { gatewayPerforms, type SubscriptionOperation } from './subscription_lifecycle.js';
import { resolveSubscriptionMode, type SubscriptionsConfig } from './subscription_mode.js';
import { SubscriptionsApi } from './subscriptions_api.js';
import type { PaymentMethodName } from './types.js';
import { PAYMENT_METHOD_NAMES } from './types.js';

export interface PaymentsManagerOptions {
  drivers: Map<string, PaymentsDriver>;
  invoices?: InvoiceManager;
  /** Method → provider name routing (`config.methods`). */
  methods?: Partial<Record<PaymentMethodName, string>>;
  /** Who owns the recurrence, globally and per provider (`config.subscriptions`). */
  subscriptions?: SubscriptionsConfig;
  /**
   * The billing store, resolved LAZILY.
   *
   * A getter and not the store itself because the manager is built before the billing layer
   * — the provider constructs it inside a container singleton, and the store needs a booted
   * database. Managed subscriptions are the only thing that reads it, so a gateway-only app
   * never calls this and never needs a store at all.
   */
  store?: () => BillingStore;
  /** Explicit default provider name (`config.default`). */
  defaultName?: string;
}

export class PaymentsManager {
  #drivers: Map<string, PaymentsDriver>;
  #invoices: InvoiceManager | undefined;
  #methods: Partial<Record<PaymentMethodName, string>>;
  #defaultName: string;
  /**
   * Method-bound driver proxies, so repeated `driver('pix')` calls return the same object.
   * Keyed by `name:method`, not method alone: the proxy closes over the name the routing
   * check compares against, so caching by method would hand a second provider the first
   * one's identity.
   */
  #boundDrivers = new Map<string, PaymentsDriver>();
  #subscriptionsConfig: SubscriptionsConfig | undefined;
  #store: (() => BillingStore) | undefined;
  #subscriptionsApi: SubscriptionsApi | undefined;

  constructor(options: PaymentsManagerOptions) {
    this.#drivers = options.drivers;
    this.#invoices = options.invoices;
    this.#methods = options.methods ?? {};
    const names = [...this.#drivers.keys()];
    if (names.length === 0) {
      throw new Error('[payments] No drivers configured. Add a provider to config/payments.ts.');
    }
    this.#defaultName = options.defaultName ?? names[0]!;
    this.#subscriptionsConfig = options.subscriptions;
    this.#store = options.store;
  }

  /**
   * Create, cancel and re-price subscriptions without the caller branching on who owns the
   * recurrence. See {@link SubscriptionsApi}.
   */
  subscriptions(): SubscriptionsApi {
    if (this.#subscriptionsApi === undefined) {
      this.#subscriptionsApi = new SubscriptionsApi({
        resolveDriver: (via?: string) => this.driver(via),
        store: () => {
          const store = this.#store?.();
          if (store === undefined) {
            throw new Error(
              "[payments] Managed subscriptions need the billing store, and none is configured. Enable `billing` in config/payments.ts, or use `subscriptions.mode: 'gateway'`.",
            );
          }
          return store;
        },
        mode: (provider, managedOnCall) =>
          resolveSubscriptionMode(this.#subscriptionsConfig, provider, managedOnCall),
        assertGatewayCan: (driver, operation) =>
          this.assertGatewaySubscriptionOperation(driver, operation),
      });
    }
    return this.#subscriptionsApi;
  }

  /**
   * Every configured driver, by the name it was configured under.
   *
   * Read-only, and there for the checks that have to look at all of them at once — the
   * boot-time webhook-verification refusal is the one that needed it.
   */
  get drivers(): ReadonlyMap<string, PaymentsDriver> {
    return this.#drivers;
  }

  /**
   * Resolve a driver by payment method (e.g. `'pix'`), by provider name, or by the
   * configured default when nothing is given.
   *
   * ```ts
   * payments.driver()          // default provider
   * payments.driver('pix')     // provider routed in config.methods.pix
   * payments.driver('stripe')  // provider by name
   * ```
   */
  driver(methodOrName?: PaymentMethodName | string): PaymentsDriver {
    const { name: resolved, method, unrouted } = this.#resolveName(methodOrName);
    const driver = this.#drivers.get(resolved);
    if (!driver) {
      throw new Error(
        `[payments] Driver "${resolved}" is not configured. ` +
          `Available drivers: ${[...this.#drivers.keys()].join(', ') || '(none)'}.`,
      );
    }
    // When the call routed a payment method, make sure the provider actually supports it —
    // e.g. routing credit_card to a Pix-only gateway (AbacatePay, Woovi) is a config error.
    if (method !== undefined && !driver.supportedMethods.includes(method)) {
      throw new Error(
        `[payments] Driver "${resolved}" does not support payment method "${method}". ` +
          `Supported methods: ${[...driver.supportedMethods].join(', ')}. ` +
          `Route "${method}" to a different provider in config.methods.`,
      );
    }
    // Routing picked the provider; it must also reach the charge. Without this the method
    // is only ever set when the CALLER repeats it — `driver('pix').charge({ method: 'pix' })`
    // — and every driver that varies by method (Stripe's `payment_method_types`, Asaas' and
    // AbacatePay's `billingType`) silently fell back to the gateway's dashboard default. A
    // charge routed as Pix could come back a card.
    // `resolved` is the CONFIG KEY, not `driver.provider` — `config.methods` is written in
    // terms of the keys under `config.providers`, and the two differ whenever an app names a
    // provider something of its own (`providers: { primary: payments.stripe(…) }`). Passing
    // the driver's own name here made the routing check compare "stripe" against "primary"
    // and refuse a charge that was routed exactly right.
    if (method !== undefined) return this.#bound(driver, method, resolved);
    // `driver()` with no argument used to skip `config.methods` entirely, which is the same
    // trap one level up: an app that configured pix/credit_card/boleto routing and then
    // calls `driver()` got a driver bound to NOTHING, and every charge fell back to the
    // gateway's dashboard default unless the caller happened to repeat `method:`.
    if (unrouted !== undefined) return this.#unrouted(driver, resolved, unrouted);
    // (`method === undefined` and no routing map entry: nothing to bind, nothing to check.)
    return driver;
  }

  /**
   * The default driver when `config.methods` is configured but this call named no method.
   *
   * Three cases, and only the first can be answered silently:
   *
   * - **Exactly one method routes here.** The routing is unambiguous, so it is applied — the
   *   same binding `driver('pix')` would have produced.
   * - **Several methods route here.** There is no honest answer: `methods` says this provider
   *   takes pix AND boleto AND card, and picking one would be inventing the charge's payment
   *   method. The charge is refused with the two ways to say what you meant. It refuses at
   *   `charge`/`createSubscription` rather than at `driver()`, so the app that already passes
   *   `method:` on every call — which is what makes this correct today — keeps working
   *   unchanged.
   * - **A method is passed that `methods` routes ELSEWHERE.** The routing map and the call
   *   disagree about where the money goes; that is a config error either way, and running it
   *   would send a card charge to the provider configured for Pix.
   */
  #unrouted(
    driver: PaymentsDriver,
    name: string,
    candidates: readonly PaymentMethodName[],
  ): PaymentsDriver {
    if (candidates.length === 1) {
      return this.#bound(driver, candidates[0] as PaymentMethodName, name);
    }
    return new Proxy(driver, {
      get: (target, property, _receiver) => {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== 'function') return value;
        if (property !== 'charge' && property !== 'createSubscription') {
          return (value as (...args: unknown[]) => unknown).bind(target);
        }
        // `async`, so the refusal below is a rejected promise rather than a synchronous
        // throw: every caller of `charge` awaits it, and a sync throw out of an awaited call
        // skips a `.catch()` the caller reasonably attached.
        return async (input: { method?: PaymentMethodName }, ...rest: unknown[]) => {
          const method = input?.method;
          if (method === undefined) {
            throw new Error(
              [
                `[payments] driver() resolved "${name}", and config.methods routes`,
                `${candidates.join(', ')} to it — so this ${String(property)} has no payment`,
                'method and would fall back to whatever the gateway dashboard defaults to.',
                `Name it: driver('${candidates[0]}') or`,
                `${String(property)}({ method: '${candidates[0]}' }).`,
              ].join(' '),
            );
          }
          this.#assertRoutedHere(method, name, String(property));
          return (value as (...args: unknown[]) => unknown).call(target, input, ...rest);
        };
      },
    });
  }

  /**
   * The driver, with the routed method filled in on the inputs that carry one.
   *
   * A Proxy rather than a hand-written wrapper for one reason: the driver contract has
   * optional members (`findDispute`, `submitDisputeEvidence`, `capabilities`), and callers
   * test for them with `typeof driver.x === 'function'`. A wrapper that defines every method
   * turns "this gateway cannot do that" into "it can, until you call it" — which is the class
   * of bug this package keeps finding. A Proxy passes absence through as absence.
   *
   * Cached per method so `driver('pix') === driver('pix')` still holds. Note that a driver
   * resolved by NAME is returned untouched: `driver('stripe')` routed nothing, so there is no
   * method to thread and no reason to wrap.
   */
  #bound(driver: PaymentsDriver, method: PaymentMethodName, name?: string): PaymentsDriver {
    const cacheKey = `${name ?? driver.provider}:${method}`;
    const cached = this.#boundDrivers.get(cacheKey);
    if (cached !== undefined) return cached;

    const bound = new Proxy(driver, {
      // An arrow, so `this` is still the manager: the routing check below is its business.
      get: (target, property, _receiver) => {
        // Bound to `target`, never to the proxy: driver methods read `#private` fields, and
        // a proxy is not the instance those belong to.
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== 'function') return value;
        if (property !== 'charge' && property !== 'createSubscription') {
          return (value as (...args: unknown[]) => unknown).bind(target);
        }
        return async (input: { method?: PaymentMethodName }, ...rest: unknown[]) => {
          // An explicit method on the input wins. Routing is a default, not an override:
          // `driver('pix')` picks the provider, and a caller who then names a method meant it
          // — as long as the routing map does not send that method somewhere else.
          const chosen = input?.method ?? method;
          this.#assertRoutedHere(chosen, name ?? driver.provider, String(property));
          return (value as (...args: unknown[]) => unknown).call(
            target,
            { ...input, method: chosen },
            ...rest,
          );
        };
      },
    });
    this.#boundDrivers.set(cacheKey, bound);
    return bound;
  }

  /**
   * Resolve an invoice provider by name (falls back to the configured default). Throws
   * when no invoice provider is configured — a charge with `invoice: true` needs one.
   */
  invoice(name?: string) {
    if (!this.#invoices) {
      throw new Error(
        '[payments] No invoice providers configured. Add `invoice.providers` to config/payments.ts.',
      );
    }
    return this.#invoices.provider(name);
  }

  /**
   * Check a driver capability before delegating, so callers discover the limitation
   * early (e.g. Woovi/OpenPix has no refunds) instead of at the gateway.
   */
  assertCapability(
    driver: PaymentsDriver,
    capability: 'refunds' | 'invoices' | 'subscriptions' | 'disputes' | 'cardTokenization',
  ): void {
    if (
      driver.capabilities?.[capability] === false ||
      driver.capabilities?.[capability] === undefined
    ) {
      // Only the capabilities actually set to `true`. Listing every KEY meant a driver that
      // spells out `{ invoices: false }` — as the newer ones do — had the capability it was
      // just refused named back to it as supported.
      const supported = Object.entries(driver.capabilities ?? {})
        .filter(([, enabled]) => enabled === true)
        .map(([name]) => name);
      throw new Error(
        `[payments] Driver "${driver.provider}" does not support ${capability}. ` +
          `Supported capabilities: ${supported.join(', ') || '(none)'}.`,
      );
    }
  }

  /**
   * Refuse a subscription operation the GATEWAY does not perform, naming the alternative.
   *
   * Separate from {@link assertCapability} because the answer is not a single boolean: a
   * gateway can create subscriptions and be unable to cancel them (Woovi/OpenPix), so
   * `subscriptions` alone cannot decide this call. And unlike a missing refund API, this
   * limitation has a way out that costs nothing at the gateway — `subscriptions.mode:
   * 'managed'`, where the library owns the recurrence — so the error says so rather than
   * leaving the reader to conclude the feature is impossible.
   */
  assertGatewaySubscriptionOperation(
    driver: PaymentsDriver,
    operation: SubscriptionOperation,
  ): void {
    if (gatewayPerforms(driver, operation)) return;
    throw new Error(
      `[payments] Gateway "${driver.provider}" cannot ${operation} a subscription through its API. ` +
        `Set \`subscriptions.mode: 'managed'\` (globally, per provider, or \`managed: true\` on the ` +
        `call) to have the library own the recurrence and make this a local operation.`,
    );
  }

  #resolveName(methodOrName?: PaymentMethodName | string): {
    name: string;
    method?: PaymentMethodName;
    /** Methods `config.methods` routes to this provider, when the call named none. */
    unrouted?: readonly PaymentMethodName[];
  } {
    if (methodOrName === undefined) {
      const candidates = this.#methodsRoutedTo(this.#defaultName);
      return candidates.length > 0
        ? { name: this.#defaultName, unrouted: candidates }
        : { name: this.#defaultName };
    }
    // If it names a configured provider, use it directly. Naming the provider is an
    // explicit choice, so `config.methods` is deliberately not consulted — it says which
    // provider a METHOD goes to, and this call already answered that question.
    if (this.#drivers.has(methodOrName)) return { name: methodOrName };
    // Otherwise treat it as a payment method and route via config.methods.
    const method = methodOrName as PaymentMethodName;
    const routed = this.#methods[method];
    if (routed !== undefined) return { name: routed, method };
    // Unknown method/name: throw a helpful error pointing at the routing config.
    const providers = [...this.#drivers.keys()].join(', ') || '(none)';
    throw new Error(
      `[payments] "${methodOrName}" is neither a configured provider nor a method routed in config.methods. Configured providers: ${providers}. Known methods: ${PAYMENT_METHOD_NAMES.join(', ')}.`,
    );
  }

  /**
   * Refuse a call whose payment method `config.methods` routes to a DIFFERENT provider.
   *
   * The routing map and the call disagree about where the money goes. Running it anyway sends
   * a card charge to the provider configured for Pix — the same class of silence as an
   * unbound driver, one level up.
   */
  #assertRoutedHere(method: PaymentMethodName, name: string, operation: string): void {
    const routed = this.#methods[method];
    if (routed === undefined || routed === name) return;
    throw new Error(
      [
        `[payments] config.methods routes "${method}" to "${routed}", but this ${operation} is`,
        `going to "${name}". Call driver('${method}') to use the routed provider, or name the`,
        `provider explicitly (driver('${name}')) if the override is deliberate.`,
      ].join(' '),
    );
  }

  /** Which payment methods `config.methods` routes to a given provider. */
  #methodsRoutedTo(name: string): PaymentMethodName[] {
    return Object.entries(this.#methods)
      .filter(([, provider]) => provider === name)
      .map(([method]) => method as PaymentMethodName);
  }
}

/** Build the driver map from config, resolving every configured factory. */
export async function resolveDrivers(
  config: PaymentsConfig,
  invoices?: InvoiceManager,
): Promise<Map<string, PaymentsDriver>> {
  const factories = config.providers ?? {};
  const ctx = {
    config: () => config,
    // Hand drivers the invoice resolver so a charge with `invoice: true|'name'` can emit
    // a fiscal note through the configured invoice provider — independent of the gateway.
    ...(invoices !== undefined ? { invoice: (name?: string) => invoices.provider(name) } : {}),
  };
  const map = new Map<string, PaymentsDriver>();
  for (const [name, factory] of Object.entries(factories)) {
    map.set(name, await factory(ctx));
  }
  return map;
}
