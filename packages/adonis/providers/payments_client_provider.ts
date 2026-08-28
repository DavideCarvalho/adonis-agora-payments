import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService, HttpRouterService } from '@adonisjs/core/types';
import type { BillingStore } from '../src/billing/billing_store.js';
import {
  type PaymentsClientConfig,
  type ResolvedPaymentsClientConfig,
  resolveConfig,
} from '../src/client/define_config.js';
import { paymentStatus } from '../src/client/handlers.js';
import { getBillingStore } from '../src/services/main.js';

/**
 * Mounts the browser-facing status endpoint from `config/payments_client.ts`.
 *
 * One route, and only one:
 *
 * - `GET <path>/status?reference=<reference>` -> `{ status, amount, currency, paidAt }`
 *
 * It exists because a Pix QR (or a boleto) is not paid until the gateway's webhook says so,
 * seconds to days later, and every app that takes Pix otherwise hand-writes the same
 * polling loop in its checkout page. It does NOT wrap any gateway's card SDK — Stripe,
 * Mercado Pago and Adyen ship their own, and eighteen of those is a surface this package
 * could not keep honest.
 *
 * Disabled by default. With `enabled: false` (the default) this provider registers NOTHING:
 * unlike the dashboard, which is an operator console behind an admin gate, this endpoint is
 * reachable by every logged-in browser, so an app takes it on deliberately.
 *
 * Registered separately from `payments_provider` for the same reason the dashboard is: the
 * webhook route lives at `/payments/webhook/:provider`, and a guard mounted over that prefix
 * is how a gateway delivery ends up answering `403`. This one mounts under
 * `/payments/client` and touches nothing above it.
 */
export default class PaymentsClientProvider {
  constructor(protected app: ApplicationService) {}

  /** Warn once, not once per poll — a denied checkout page can retry for a while. */
  private warnedOnDeny = false;

  async boot() {
    const config = resolveConfig(this.app.config.get<PaymentsClientConfig>('payments_client', {}));
    if (!config.enabled) return;

    // Registration can't happen synchronously in `boot()`: the router singleton isn't
    // committed until the app's "booted" hooks run, which fire after every provider's `boot()`.
    await this.app.booted(async () => {
      const router = await this.app.container.make('router');
      this.registerRoutes(router, config);
    });
  }

  private registerRoutes(router: HttpRouterService, config: ResolvedPaymentsClientConfig): void {
    router
      .get(`${config.path}/status`, async (ctx: HttpContext) => {
        // A payment status is per-caller and changes under you. Nothing between the browser
        // and here may keep a copy — least of all a shared proxy, which would hand one
        // customer's settled charge to the next caller with the same URL.
        ctx.response.header('cache-control', 'no-store');

        let store: BillingStore;
        try {
          store = getBillingStore();
        } catch (error) {
          // The billing layer is off, or the app has not booted it. A deployment state, not
          // a bad request — say so rather than emit a stack-trace-shaped 500.
          return ctx.response.status(503).json({
            error: error instanceof Error ? error.message : 'billing store unavailable',
          });
        }

        const reference = ctx.request.qs().reference;
        const result = await paymentStatus(
          {
            store,
            config,
            onDeny: (reason) => {
              void this.warnOnDeny(reason);
            },
          },
          ctx,
          typeof reference === 'string' ? reference : undefined,
        );
        return ctx.response.status(result.status).json(result.body);
      })
      .as('payments_client.status');
  }

  /**
   * Surface the developer-facing denial reason once.
   *
   * The browser only ever sees `403`. The single most likely cause — the app never called
   * `ensureCustomer({ store, owner })`, so `billing_customers` is empty and the default
   * guard can prove nothing — is otherwise indistinguishable from a real denial, and an
   * install would sit there refusing every poll with no clue why.
   */
  private async warnOnDeny(reason: string): Promise<void> {
    if (this.warnedOnDeny) return;
    this.warnedOnDeny = true;
    try {
      const logger = await this.app.container.make('logger');
      logger.warn(reason);
    } catch {
      // No logger (a container this bare is a test harness, not a running app).
    }
  }
}
