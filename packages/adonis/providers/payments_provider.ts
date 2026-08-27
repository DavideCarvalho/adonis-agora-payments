import { pathToFileURL } from 'node:url';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService, HttpRouterService } from '@adonisjs/core/types';
import type { BillingStore } from '../src/billing/billing_store.js';
import { LucidBillingStore } from '../src/billing/lucid_billing_store.js';
import {
  assertRoleIsDispatchable,
  resolveDispatchMode,
  resolveRole,
} from '../src/billing/resolve_dispatch.js';
import { isInjectableAsLucid, resolveBillingStore } from '../src/billing/resolve_store.js';
import { WebhookDispatcher } from '../src/billing/webhook_dispatcher.js';
import type { WebhookDispatchMode } from '../src/billing/webhook_dispatcher.js';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import type { WebhookHandler } from '../src/billing/webhook_processor.js';
import type { BillingHandlers, PaymentsConfig } from '../src/define_config.js';
import { InvoiceManager, resolveInvoiceProviders } from '../src/invoice/invoice_manager.js';
import { PaymentsManager, resolveDrivers } from '../src/payments_manager.js';
import { setBillingStore, setPayments } from '../src/services/main.js';
import {
  type DiscoveredWebhookHandler,
  type WebhookHandlersBarrel,
  discoverWebhookHandlers,
  loadWebhookHandlersFromBarrel,
  resolveWebhookHandler,
} from '../src/webhook_handlers.js';

/**
 * Wires `@adonis-agora/payments` into the AdonisJS application: binds a singleton
 * {@link PaymentsManager} built from `config/payments.ts`, wires the optional Lucid
 * billing layer (store + webhook processor + dispatcher), and mounts the webhook route
 * under `/payments/webhook/:provider`.
 */
export default class PaymentsProvider {
  #webhook: WebhookDispatcher | undefined;

  constructor(protected app: ApplicationService) {}

  register() {
    const config = this.app.config.get<PaymentsConfig>('payments', {});

    this.app.container.singleton(PaymentsManager, async () => {
      // Build invoice providers first so drivers can resolve them from their ctx (a
      // charge with `invoice: true|'name'` emits through the invoice provider).
      let invoices: InvoiceManager | undefined;
      if (config.invoice) {
        const providers = await resolveInvoiceProviders(config.invoice);
        invoices = new InvoiceManager(providers);
      }
      const drivers = await resolveDrivers(config, invoices);
      const manager = new PaymentsManager({
        drivers,
        ...(invoices !== undefined ? { invoices } : {}),
        ...(config.methods !== undefined ? { methods: config.methods } : {}),
        ...(config.default !== undefined ? { defaultName: config.default } : {}),
      });
      // Hand the manager to the lazy `services/main` singleton so `getPayments()` works.
      setPayments(manager);
      return manager;
    });
  }

  async boot() {
    await this.app.booted(async () => {
      const config = this.app.config.get<PaymentsConfig>('payments', {});
      // Build the billing layer here (async — resolves the app emitter + handler
      // factories), so the mounted route can emit `billing:*` and run app handlers.
      if (config.billing?.enabled !== false) {
        await this.#buildBillingLayer(config);
      }
      // Resolve the manager here so `setPayments` runs and `getPayments()` works for
      // services that read it during boot — after every provider has registered.
      await this.app.container.make(PaymentsManager);
      // A 'worker' process consumes what the api half enqueued; it must not also
      // advertise an endpoint gateways could deliver to.
      if (resolveRole(config) !== 'worker') {
        const router = await this.app.container.make('router');
        this.#registerWebhookRoute(router);
      }
    });
  }

  async #buildBillingLayer(config: PaymentsConfig): Promise<void> {
    const mode = resolveDispatchMode(config);
    const role = resolveRole(config);
    assertRoleIsDispatchable(role, mode);

    const store = await this.#resolveBillingStore(config);
    // On an 'api' process the handlers run on the worker, so resolving them here
    // would scan the folder and build services this process never calls.
    const handlers =
      role === 'api' ? undefined : await this.#resolveAllHandlers(config.billing?.handlers);
    const processor = new WebhookProcessor({
      store,
      ...(handlers !== undefined ? { handlers } : {}),
    });
    this.#webhook = new WebhookDispatcher({
      processor,
      mode,
      // In 'auto', durable is used only when its engine is resolvable in the app
      // (i.e. the durable provider is registered) — not merely installed.
      durableAvailable: () => this.#isDurableAvailable(),
    });
  }

  /**
   * The billing store from `config.billing.store`, defaulting to Lucid over the
   * published tables.
   *
   * The resolved store is published on `services/main` (which reaches any store) and,
   * when it is the Lucid one, bound in the container so a service can `@inject()` it
   * like any other dependency.
   */
  async #resolveBillingStore(config: PaymentsConfig): Promise<BillingStore> {
    const store = await resolveBillingStore(config);

    setBillingStore(store);
    if (isInjectableAsLucid(store)) {
      this.app.container.singleton(LucidBillingStore, () => store);
    }
    return store;
  }

  /**
   * Merge webhook handlers from the two sources:
   * 1. `config.billing.handlers` (functions or service classes),
   * 2. the conventions folder `app/payment_handlers/` (build-time barrel, runtime scan
   *    as fallback) — the durable-style discovery.
   */
  async #resolveAllHandlers(
    configHandlers: BillingHandlers | undefined,
  ): Promise<Record<string, WebhookHandler> | undefined> {
    const handlers: Record<string, WebhookHandler> = {};
    if (configHandlers) {
      for (const [type, entry] of Object.entries(configHandlers)) {
        handlers[type] = await resolveWebhookHandler(entry, this.app.container);
      }
    }
    for (const discovered of await this.#discoverFolderHandlers()) {
      handlers[discovered.type] = await resolveWebhookHandler(discovered.entry, this.app.container);
    }
    return Object.keys(handlers).length > 0 ? handlers : undefined;
  }

  /** Discover handlers in `app/payment_handlers/`: build-time barrel, else runtime scan. */
  async #discoverFolderHandlers(): Promise<DiscoveredWebhookHandler[]> {
    const barrel = await this.#loadGeneratedBarrel();
    if (barrel) return loadWebhookHandlersFromBarrel(barrel);
    const dir = this.app.makePath('app/payment_handlers');
    return discoverWebhookHandlers(dir);
  }

  /** Import the Assembler `init`-hook barrel (`.adonisjs/payments/webhook_handlers.js`). */
  async #loadGeneratedBarrel(): Promise<WebhookHandlersBarrel | null> {
    const path = this.app.makePath('.adonisjs/payments/webhook_handlers.js');
    try {
      const mod = (await import(pathToFileURL(path).href)) as {
        webhookHandlers?: WebhookHandlersBarrel;
      };
      return mod.webhookHandlers ?? null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Whether the app has a resolvable durable workflow engine. */
  async #isDurableAvailable(): Promise<boolean> {
    try {
      const { WorkflowEngine } = await import('@adonis-agora/durable');
      await this.app.container.make(WorkflowEngine);
      return true;
    } catch {
      return false;
    }
  }

  /** Map `billing.durable` (`'auto' | boolean`) onto the dispatcher's mode. */

  #registerWebhookRoute(router: HttpRouterService) {
    router
      .post('/payments/webhook/:provider', async (ctx: HttpContext) => {
        const manager = await this.app.container.make(PaymentsManager);
        const provider = String(ctx.params.provider);
        try {
          const driver = manager.driver(provider);
          const rawBody = ctx.request.raw() ?? '';
          // Awaited: `parseWebhook` may be async. A gateway whose callback carries only an
          // id (Mollie) has to fetch the payment to know what happened, and that fetch is
          // also the only thing authenticating the call.
          //
          // Dropping this `await` is a compile error, not a silent bug — the contract
          // returns `WebhookEvent | Promise<WebhookEvent>` and `dispatch` takes the former.
          const event = await driver.parseWebhook(rawBody, ctx.request.headers());
          if (this.#webhook) {
            await this.#webhook.dispatch(event);
          }
          return ctx.response.status(200).json({ received: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'invalid webhook';
          return ctx.response.status(400).json({ error: message });
        }
      })
      .as('payments.webhook');
  }
}
