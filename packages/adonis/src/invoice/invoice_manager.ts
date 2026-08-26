import type { InvoiceConfig } from '../define_config.js';
import type { InvoiceProvider } from './invoice_provider.js';

/** Resolves named invoice providers from config, mirroring the payment providers map. */
export class InvoiceManager {
  #providers: Map<string, InvoiceProvider>;

  constructor(providers: Map<string, InvoiceProvider>) {
    this.#providers = providers;
  }

  /** Resolve a provider by name. Falls back to the configured default when `name` is omitted. */
  provider(name?: string): InvoiceProvider {
    const resolved = name ?? this.#defaultName;
    const driver = this.#providers.get(resolved);
    if (!driver) {
      throw new Error(
        `[payments] Invoice provider "${resolved}" is not configured. ` +
          `Available providers: ${[...this.#providers.keys()].join(', ') || '(none)'}.`,
      );
    }
    return driver;
  }

  get #defaultName(): string {
    const names = [...this.#providers.keys()];
    if (names.length === 0) {
      throw new Error(
        '[payments] No invoice providers configured. Add a provider to invoice.providers in config/payments.ts.',
      );
    }
    return names[0]!;
  }
}

/** Build the invoice provider map from config. */
export async function resolveInvoiceProviders(
  config: InvoiceConfig,
): Promise<Map<string, InvoiceProvider>> {
  const factories = config.providers ?? {};
  const ctx = { config: () => config };
  const map = new Map<string, InvoiceProvider>();
  for (const [name, factory] of Object.entries(factories)) {
    map.set(name, await factory(ctx));
  }
  return map;
}
