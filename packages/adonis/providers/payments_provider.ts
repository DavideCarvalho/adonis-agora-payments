import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService, HttpRouterService } from '@adonisjs/core/types';
import { LucidBillingStore } from '../src/billing/lucid_billing_store.js';
import { WebhookDispatcher } from '../src/billing/webhook_dispatcher.js';
import type { WebhookDispatchMode } from '../src/billing/webhook_dispatcher.js';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import type { PaymentsConfig } from '../src/define_config.js';
import { InvoiceManager, resolveInvoiceProviders } from '../src/invoice/invoice_manager.js';
import { PaymentsManager, resolveDrivers } from '../src/payments_manager.js';
import { setPayments } from '../src/services/main.js';

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

    // Wire the billing layer (subscription store + webhook processing) when enabled.
    if (config.billing?.enabled !== false) {
      const store = new LucidBillingStore();
      const processor = new WebhookProcessor({ store });
      this.#webhook = new WebhookDispatcher({
        processor,
        mode: this.#resolveMode(config),
        // In 'auto', durable is used only when its engine is resolvable in the app
        // (i.e. the durable provider is registered) — not merely installed.
        durableAvailable: () => this.#isDurableAvailable(),
      });
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
  #resolveMode(config: PaymentsConfig): WebhookDispatchMode {
    const setting = config.billing?.durable ?? 'auto';
    if (setting === true) return 'durable';
    if (setting === false) return 'in-process';
    return 'auto';
  }

  async boot() {
    // Mount the webhook route once the app has booted (same deferral as the media provider).
    await this.app.booted(async () => {
      // Resolve the manager here so `setPayments` runs and `getPayments()` works for
      // services that read it during boot — after every provider has registered.
      await this.app.container.make(PaymentsManager);
      const router = await this.app.container.make('router');
      this.#registerWebhookRoute(router);
    });
  }

  #registerWebhookRoute(router: HttpRouterService) {
    router
      .post('/payments/webhook/:provider', async (ctx: HttpContext) => {
        const manager = await this.app.container.make(PaymentsManager);
        const provider = String(ctx.params.provider);
        try {
          const driver = manager.driver(provider);
          const rawBody = ctx.request.raw() ?? '';
          const event = driver.parseWebhook(rawBody, ctx.request.headers());
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
