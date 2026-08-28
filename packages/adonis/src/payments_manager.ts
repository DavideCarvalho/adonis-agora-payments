import type { PaymentsConfig } from './define_config.js';
import type { PaymentsDriver } from './driver.js';
import type { InvoiceManager } from './invoice/invoice_manager.js';
import { PAYMENT_METHOD_NAMES } from './types.js';
import type { PaymentMethodName } from './types.js';

export interface PaymentsManagerOptions {
  drivers: Map<string, PaymentsDriver>;
  invoices?: InvoiceManager;
  /** Method → provider name routing (`config.methods`). */
  methods?: Partial<Record<PaymentMethodName, string>>;
  /** Explicit default provider name (`config.default`). */
  defaultName?: string;
}

export class PaymentsManager {
  #drivers: Map<string, PaymentsDriver>;
  #invoices: InvoiceManager | undefined;
  #methods: Partial<Record<PaymentMethodName, string>>;
  #defaultName: string;
  /** Method-bound driver proxies, so repeated `driver('pix')` calls return the same object. */
  #boundDrivers = new Map<PaymentMethodName, PaymentsDriver>();

  constructor(options: PaymentsManagerOptions) {
    this.#drivers = options.drivers;
    this.#invoices = options.invoices;
    this.#methods = options.methods ?? {};
    const names = [...this.#drivers.keys()];
    if (names.length === 0) {
      throw new Error('[payments] No drivers configured. Add a provider to config/payments.ts.');
    }
    this.#defaultName = options.defaultName ?? names[0]!;
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
    const { name: resolved, method } = this.#resolveName(methodOrName);
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
    return method === undefined ? driver : this.#bound(driver, method);
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
  #bound(driver: PaymentsDriver, method: PaymentMethodName): PaymentsDriver {
    const cached = this.#boundDrivers.get(method);
    if (cached !== undefined) return cached;

    const bound = new Proxy(driver, {
      get(target, property, _receiver) {
        // Bound to `target`, never to the proxy: driver methods read `#private` fields, and
        // a proxy is not the instance those belong to.
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== 'function') return value;
        if (property !== 'charge' && property !== 'createSubscription') {
          return (value as (...args: unknown[]) => unknown).bind(target);
        }
        return (input: { method?: PaymentMethodName }, ...rest: unknown[]) =>
          (value as (...args: unknown[]) => unknown).call(
            target,
            // An explicit method on the input wins. Routing is a default, not an override:
            // `driver('pix')` picks the provider, and a caller who then names a method meant
            // it.
            { ...input, method: input?.method ?? method },
            ...rest,
          );
      },
    });
    this.#boundDrivers.set(method, bound);
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
    capability: 'refunds' | 'invoices' | 'subscriptions' | 'disputes',
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

  #resolveName(methodOrName?: PaymentMethodName | string): {
    name: string;
    method?: PaymentMethodName;
  } {
    if (methodOrName === undefined) return { name: this.#defaultName };
    // If it names a configured provider, use it directly.
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
