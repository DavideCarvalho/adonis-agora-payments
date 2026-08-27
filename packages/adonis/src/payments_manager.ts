import type { PaymentsConfig } from './define_config.js';
import type { PaymentsDriver } from './driver.js';
import type { InvoiceManager } from './invoice/invoice_manager.js';
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
    return driver;
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
    capability: 'refunds' | 'invoices' | 'subscriptions',
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
      `[payments] "${methodOrName}" is neither a configured provider nor a method routed in config.methods. Configured providers: ${providers}. Known methods: pix, credit_card, debit_card, boleto, undefined.`,
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
