import { readFile } from 'node:fs/promises';
import { basename, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService, HttpRouterService } from '@adonisjs/core/types';
import type { BillingStore } from '../src/billing/billing_store.js';
import type { WebhookHandler } from '../src/billing/webhook_processor.js';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import { createRefundAction, createReplayAction } from '../src/dashboard/actions.js';
import {
  performLogin,
  performSession,
  type ResolvedDashboardAuth,
  readSession,
  SESSION_COOKIE_NAME,
} from '../src/dashboard/auth.js';
import {
  type PaymentsDashboardConfig,
  type ResolvedPaymentsDashboardConfig,
  resolveConfig,
} from '../src/dashboard/define_config.js';
import {
  type ApiRequest,
  type ApiResponse,
  auditEvents,
  customers,
  type DashboardActions,
  type Deps,
  disputes,
  health,
  overview,
  paymentDetail,
  payments,
  providers,
  refundPayment,
  resolveDispute,
  retryWebhookEvent,
  subscriptions,
  webhookEvents,
} from '../src/dashboard/handlers.js';
import { renderLoginPage } from '../src/dashboard/login_page.js';
import { contentTypeFor, renderIndexHtml } from '../src/dashboard/spa.js';
import type { BillingHandlers, PaymentsConfig } from '../src/define_config.js';
import { PaymentsManager } from '../src/payments_manager.js';
import { getBillingStore } from '../src/services/main.js';
import type { WebhookEvent } from '../src/types.js';
import {
  discoverWebhookHandlers,
  loadWebhookHandlersFromBarrel,
  resolveWebhookHandler,
  type WebhookHandlersBarrel,
} from '../src/webhook_handlers.js';

/**
 * Directory of the built SPA (`dist/assets/spa`, copied in by `copy:spa` — see `package.json`),
 * relative to this compiled provider (`dist/providers`). Resolved lazily (not at module scope) for
 * the same reason `@adonis-agora/durable`'s dashboard provider resolves its SPA directory lazily:
 * `fileURLToPath` throws on any non-`file:` `import.meta.url`, which would make this provider
 * unimportable under a test runner that doesn't use real file URLs.
 *
 * NOTE this reads BUILT ASSETS FROM DISK. The provider never imports `@adonis-agora/payments-dashboard`
 * — that package is a devDependency of this one purely so the workspace build orders them.
 */
let spaDir: string | undefined;
function spaDirectory(): string {
  spaDir ??= fileURLToPath(new URL('../assets/spa/', import.meta.url));
  return spaDir;
}

/**
 * Mounts the payments dashboard into an AdonisJS app: the `@adonis-agora/payments-dashboard` React
 * SPA plus a JSON API over the resolved {@link BillingStore}, served under a configurable path.
 *
 * Reads never touch a gateway. The two ACTIONS do — a refund calls the driver that took the
 * payment, and a retry re-runs a failed webhook event through the app's own handlers — so both are
 * `POST` (a refund reachable by URL is a refund a crawler can trigger) and both go through the same
 * {@link enforce} guard as every read.
 *
 * Routes (relative to the configured `path`, default `/payments`):
 * - `GET  /`                     -> the dashboard SPA's `index.html`
 * - `GET  /assets/:file`         -> the SPA's hashed JS/CSS bundle
 * - `GET  /api/health`           -> `billingHealth()` — what needs attention today
 * - `GET  /api/overview`         -> `billingOverview()` metrics for a period
 * - `GET  /api/payments`         -> a page of `billing_payments` (status/provider filters, plus
 *                                   `?reference=` / `?gatewayId=` / `?customerId=` lookups)
 * - `GET  /api/payments/:gatewayId` -> one payment: current state, owner, disputes, the ledger
 *                                   rows naming it, and who refunded it
 * - `GET  /api/customers`        -> a page of `billing_customers` — the owner mapping that ties
 *                                   a `cus_…` back to an app user
 * - `GET  /api/audit`            -> the trail: refunds issued here, disputes resolved here, and
 *                                   the gateway deliveries this endpoint REFUSED
 * - `GET  /api/disputes`         -> a page of `billing_disputes`; `?dueWithin=<hours>` for the
 *                                   open windows closing soonest
 * - `GET  /api/subscriptions`    -> a page of `billing_subscriptions` (status/provider filters)
 * - `GET  /api/webhook-events`   -> a page of `billing_webhook_events` (status/provider/type)
 * - `GET  /api/providers`        -> the gateways and event types this install has data for
 * - `POST /api/payments/:gatewayId/refund`           -> refund through the payment's own gateway
 * - `POST /api/disputes/:gatewayId/resolve`          -> record how a dispute ended, and who said so
 * - `POST /api/webhook-events/:gatewayEventId/retry` -> re-run a failed event's handlers
 *
 * Plus, when `dashboardAuth` is configured, `GET|POST <path>/login`, `POST <path>/session` and
 * `GET <path>/logout`.
 *
 * With `enabled: false` this provider registers NOTHING — not the SPA, not the API, not the auth
 * routes. The dashboard is then completely absent from the app's route table.
 */
export default class PaymentsDashboardProvider {
  constructor(protected app: ApplicationService) {}

  /** Warn once so a throwing `login`/`session` hook doesn't spam the logs on every failed attempt. */
  private warnedOnHookThrow = false;

  async boot() {
    const config = resolveConfig(
      this.app.config.get<PaymentsDashboardConfig>('payments_dashboard', {}),
    );
    if (!config.enabled) return;

    // Route registration can't happen synchronously in `boot()`: the router singleton isn't
    // committed until the app's "booted" hooks run, which fire strictly AFTER every provider's
    // own `boot()`. Same note `@adonis-agora/durable`'s dashboard provider carries.
    await this.app.booted(async () => {
      const router = await this.app.container.make('router');
      this.registerRoutes(router, config);
    });
  }

  private registerRoutes(router: HttpRouterService, config: ResolvedPaymentsDashboardConfig): void {
    const apiBase = `${config.path}/api`;

    // Built-in `dashboardAuth` (Mode A `session` and/or Mode B `login`, opt-in). Registered ONLY
    // when configured. These endpoints are public (behind NEITHER guard): they MINT the session
    // the guard checks for.
    if (config.dashboardAuth) {
      this.registerAuthRoutes(router, config, config.dashboardAuth);
    }

    this.registerSpaRoutes(router, config, apiBase);

    const json = (
      handler: (d: Deps, req: ApiRequest) => Promise<ApiResponse>,
      needsActions = false,
    ) => {
      return async (ctx: HttpContext) => {
        const guard = await this.enforce(config, ctx, 'api');
        if (!guard.allowed) return;
        let store: BillingStore;
        try {
          store = getBillingStore();
        } catch (error) {
          // The billing layer is off (or the app hasn't booted it). That is a deployment state,
          // not a bug in the request — say so with a 503 rather than a stack-trace-shaped 500.
          return ctx.response.status(503).json({
            error: error instanceof Error ? error.message : 'billing store unavailable',
          });
        }
        try {
          const deps: Deps = {
            store,
            currency: config.currency,
            // WHO is asking. The guard has already verified a signed session carrying a user;
            // passing it through is what lets a refund and a dispute resolution be recorded
            // against a person instead of against nobody. Absent when this deployment
            // configures no `dashboardAuth` — recorded as "unattributed", never invented.
            ...(guard.actor !== undefined ? { actor: guard.actor } : {}),
            // Resolved lazily and only for the routes that need it: a console whose payments
            // manager is unreachable must still serve every read.
            ...(needsActions ? { actions: await this.actions(store) } : {}),
          };
          const result = await handler(deps, toApiRequest(ctx));
          return ctx.response.status(result.status).json(result.body);
        } catch (error) {
          return ctx.response
            .status(500)
            .json({ error: error instanceof Error ? error.message : 'internal error' });
        }
      };
    };

    router.get(`${apiBase}/health`, json(health)).as('payments_dashboard.health');
    router.get(`${apiBase}/overview`, json(overview)).as('payments_dashboard.overview');
    router.get(`${apiBase}/payments`, json(payments)).as('payments_dashboard.payments');
    // Registered AFTER the collection route and before the refund `POST`, and the ordering is
    // only cosmetic here — `/payments` and `/payments/:gatewayId` cannot shadow each other — but
    // it keeps the read routes reading top-down.
    router
      .get(`${apiBase}/payments/:gatewayId`, json(paymentDetail))
      .as('payments_dashboard.payments.show');
    router.get(`${apiBase}/customers`, json(customers)).as('payments_dashboard.customers');
    router.get(`${apiBase}/audit`, json(auditEvents)).as('payments_dashboard.audit');
    // There is still no "fight" or "accept" route, on purpose: whether to submit evidence or
    // refund is a business rule that stays in the app's code. The `resolve` POST below is a
    // different thing — it records an outcome that already happened at the gateway.
    router.get(`${apiBase}/disputes`, json(disputes)).as('payments_dashboard.disputes');
    router
      .get(`${apiBase}/subscriptions`, json(subscriptions))
      .as('payments_dashboard.subscriptions');
    router
      .get(`${apiBase}/webhook-events`, json(webhookEvents))
      .as('payments_dashboard.webhook_events');
    router.get(`${apiBase}/providers`, json(providers)).as('payments_dashboard.providers');

    // The console's only WRITE routes. `POST` is load-bearing, not stylistic: registering either of
    // these as a `GET` would put "refund this customer" behind a link a prefetcher can follow.
    router
      .post(`${apiBase}/payments/:gatewayId/refund`, json(refundPayment, true))
      .as('payments_dashboard.payments.refund');
    router
      .post(`${apiBase}/webhook-events/:gatewayEventId/retry`, json(retryWebhookEvent, true))
      .as('payments_dashboard.webhook_events.retry');
    // No `needsActions`: this one calls no gateway. It records how a dispute ENDED — the loop a
    // gateway that publishes no lost-dispute event never closes on its own — so it stays
    // available on a deployment whose payments manager is unreachable.
    router
      .post(`${apiBase}/disputes/:gatewayId/resolve`, json(resolveDispute))
      .as('payments_dashboard.disputes.resolve');
  }

  /**
   * The two write actions, built once and reused.
   *
   * Both need the app's `PaymentsManager` — the refund needs the driver that took the payment, and
   * the retry needs that driver to rebuild the normalized event from the stored payload. Neither is
   * fatal when it is missing: the ports are simply absent and the handlers answer `503` with a
   * sentence saying so.
   *
   * Only a successful build is cached. A failure here usually means "the app has not finished
   * booting", and caching THAT would disable both buttons for the life of the process.
   */
  private actionsCache: Partial<DashboardActions> | undefined;

  private async actions(store: BillingStore): Promise<Partial<DashboardActions>> {
    if (this.actionsCache) return this.actionsCache;

    let manager: PaymentsManager;
    try {
      manager = await this.app.container.make(PaymentsManager);
    } catch {
      return {};
    }

    // The retry re-runs the app's OWN handlers, not just the built-in store sync — a retry that
    // skipped them would silently do half the job, which is worse than no button. They are
    // resolved the same way `payments_provider.ts` resolves them (config entries plus the
    // `app/payment_handlers/` convention).
    const config = this.app.config.get<PaymentsConfig>('payments', {});
    const handlers = await this.resolveHandlers(config.billing?.handlers);
    const processor = new WebhookProcessor({
      store,
      ...(handlers !== undefined ? { handlers } : {}),
    });

    const actions: Partial<DashboardActions> = {
      refund: createRefundAction((provider) => manager.driver(provider)),
      replayWebhook: createReplayAction({
        store,
        // The event is rebuilt from the ledger's own `payload` + `normalized` columns and run
        // straight through the processor — no driver, no `parseWebhook`, so no signature to
        // re-verify from headers nobody kept. That is what makes a Stripe or Adyen row
        // replayable at all. A row recorded before the `normalized` column existed is reported
        // to the operator as `422`, ledger row untouched.
        process: (event) => processor.process(event as WebhookEvent),
      }),
    };
    this.actionsCache = actions;
    return actions;
  }

  /** Webhook handlers from `config.billing.handlers` plus `app/payment_handlers/` (build-time
   *  barrel, runtime scan as fallback) — the same two sources the payments provider merges. */
  private async resolveHandlers(
    configHandlers: BillingHandlers | undefined,
  ): Promise<Record<string, WebhookHandler> | undefined> {
    const handlers: Record<string, WebhookHandler> = {};
    if (configHandlers) {
      for (const [type, entry] of Object.entries(configHandlers)) {
        handlers[type] = await resolveWebhookHandler(entry, this.app.container);
      }
    }
    for (const discovered of await this.discoverHandlers()) {
      handlers[discovered.type] = await resolveWebhookHandler(discovered.entry, this.app.container);
    }
    return Object.keys(handlers).length > 0 ? handlers : undefined;
  }

  private async discoverHandlers() {
    try {
      const path = this.app.makePath('.adonisjs/payments/webhook_handlers.js');
      const mod = (await import(pathToFileURL(path).href)) as {
        webhookHandlers?: WebhookHandlersBarrel;
      };
      if (mod.webhookHandlers) return loadWebhookHandlersFromBarrel(mod.webhookHandlers);
    } catch {
      // No generated barrel — fall through to the runtime scan.
    }
    return discoverWebhookHandlers(this.app.makePath('app/payment_handlers'));
  }

  /** Mount the React SPA at `config.path` plus its hashed asset bundle. */
  private registerSpaRoutes(
    router: HttpRouterService,
    config: ResolvedPaymentsDashboardConfig,
    apiBase: string,
  ): void {
    const indexPath = config.path === '' ? '/' : config.path;

    router
      .get(indexPath, async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'page')).allowed) return;
        let html: string;
        try {
          html = await readFile(resolvePath(spaDirectory(), 'index.html'), 'utf8');
        } catch {
          return ctx.response
            .status(404)
            .send(
              'The payments dashboard SPA is not built. Run `pnpm --filter @adonis-agora/payments-dashboard build` (or the package build) to emit dist/spa.',
            );
        }
        return ctx.response
          .header('content-type', 'text/html; charset=utf-8')
          .header('cache-control', 'no-store, must-revalidate')
          .send(renderIndexHtml(html, config.path, apiBase, config.currency));
      })
      .as('payments_dashboard.index');

    router
      .get(`${config.path}/assets/:file`, async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'page')).allowed) return;
        const file = basename(String(ctx.params.file));
        const root = resolvePath(spaDirectory(), 'assets');
        const assetPath = resolvePath(root, file);
        if (!assetPath.startsWith(root)) return ctx.response.status(404).send('');
        let bytes: Buffer;
        try {
          bytes = await readFile(assetPath);
        } catch {
          return ctx.response.status(404).send('');
        }
        return ctx.response
          .header('content-type', contentTypeFor(file))
          .header('cache-control', 'public, max-age=31536000, immutable')
          .send(bytes);
      })
      .as('payments_dashboard.assets');
  }

  /**
   * Mount the built-in `dashboardAuth` endpoints under `basePath`. All are public (no guard): they
   * create/destroy the session the {@link enforce} guard checks for.
   *
   * - `GET  <base>/login`   -> the server-rendered login page (Mode B only).
   * - `POST <base>/login`   -> verifies credentials via the host `login` hook and mints the cookie.
   * - `POST <base>/session` -> Mode A: verifies the HOST APP's own auth (off the raw request) via
   *    the `session` hook and mints the cookie. `204` on success, uniform `401` on denial.
   * - `GET  <base>/logout`  -> clears the cookie and redirects to the login page (Mode B) or the
   *    dashboard root (Mode A only).
   */
  private registerAuthRoutes(
    router: HttpRouterService,
    config: ResolvedPaymentsDashboardConfig,
    auth: ResolvedDashboardAuth,
  ): void {
    const loginPath = `${config.path}/login`;
    const sessionPath = `${config.path}/session`;
    const logoutPath = `${config.path}/logout`;

    if (auth.login) {
      router
        .get(loginPath, async (ctx) => {
          ctx.response.header('content-type', 'text/html; charset=utf-8');
          ctx.response.header('cache-control', 'no-store, must-revalidate');
          return ctx.response.send(renderLoginPage(config.path));
        })
        .as('payments_dashboard.login.page');

      router
        .post(loginPath, async (ctx) => {
          const outcome = await performLogin(auth, ctx.request.body(), config.path);
          if (outcome.kind === 'bad-request') {
            return ctx.response.status(400).json({ error: outcome.message });
          }
          if (outcome.kind === 'unauthorized') {
            await this.warnHookThrow(outcome.hookError);
            return ctx.response.status(401).json({ error: outcome.message });
          }
          this.writeSessionCookie(ctx, auth, outcome.cookieValue);
          return ctx.response.status(200).json({ redirectTo: outcome.redirectTo });
        })
        .as('payments_dashboard.login.submit');
    }

    if (auth.session) {
      router
        .post(sessionPath, async (ctx) => {
          const outcome = await performSession(auth, ctx.request.request);
          if (outcome.kind === 'unauthorized') {
            await this.warnHookThrow(outcome.hookError);
            return ctx.response.status(401).json({ error: 'unauthorized' });
          }
          this.writeSessionCookie(ctx, auth, outcome.cookieValue);
          return ctx.response.status(204).send('');
        })
        .as('payments_dashboard.session.mint');
    }

    router
      .get(logoutPath, async (ctx) => {
        ctx.response.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
        return ctx.response.redirect().toPath(auth.login ? loginPath : config.path || '/');
      })
      .as('payments_dashboard.logout');
  }

  private async warnHookThrow(hookError: unknown): Promise<void> {
    if (hookError === undefined || this.warnedOnHookThrow) return;
    this.warnedOnHookThrow = true;
    const message = hookError instanceof Error ? hookError.message : String(hookError);
    const logger = await this.app.container.make('logger');
    logger.warn(`dashboardAuth login/session hook threw; treating as denial. ${message}`);
  }

  /**
   * Run the guards for a dashboard resource. Composes the `authorize` hook (bearer token/custom)
   * with the optional `dashboardAuth` session guard — BOTH must pass:
   *
   * 1. `authorize` fails -> `403`.
   * 2. `dashboardAuth` configured AND no valid session -> for a `page` request, redirect `302` to
   *    the login page (Mode B) carrying a sanitized `returnTo`, or a `401` notice (Mode A only);
   *    for an `api` request, `401 { error: 'unauthorized', auth: { modes } }`.
   *
   * Returns `allowed: false` (and has already written the response) when the request must
   * short-circuit. On success it also carries WHO passed the gate: the session's user, which
   * the write handlers record against a refund or a dispute resolution. `undefined` when this
   * deployment configures no `dashboardAuth` — there is genuinely nobody to name, and inventing
   * one would be worse than an honest "unattributed".
   */
  private async enforce(
    config: ResolvedPaymentsDashboardConfig,
    ctx: HttpContext,
    mode: 'page' | 'api',
  ): Promise<{ allowed: boolean; actor?: string }> {
    const allowed = await config.authorize(ctx);
    if (!allowed) {
      if (!ctx.response.getHeader('location')) {
        ctx.response.status(403).json({ error: 'forbidden' });
      }
      return { allowed: false };
    }

    const auth = config.dashboardAuth;
    if (!auth) return { allowed: true };

    const session = readSession(auth, this.readSessionCookie(ctx));
    // The display name when the host supplied one, the stable id otherwise. `sub` alone is
    // unambiguous but often unreadable; a name alone is readable and not unique.
    if (session) {
      return {
        allowed: true,
        actor: session.name !== undefined ? `${session.name} <${session.sub}>` : session.sub,
      };
    }

    if (mode === 'page') {
      if (auth.login) {
        const returnTo = ctx.request.url(true);
        ctx.response.redirect().withQs('returnTo', returnTo).toPath(`${config.path}/login`);
        return { allowed: false };
      }
      // Mode A only: there's no login page to send the browser to — this deployment expects the
      // host app to mint a session via `POST <path>/session` before ever navigating here.
      ctx.response
        .status(401)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store, must-revalidate')
        .send(
          '<!doctype html><html><body style="font-family:ui-monospace,monospace;background:#09090b;color:#e7e7ea;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>Open this console from your application.</p></body></html>',
        );
      return { allowed: false };
    }
    ctx.response.status(401).json({ error: 'unauthorized', auth: { modes: auth.modes } });
    return { allowed: false };
  }

  private readSessionCookie(ctx: HttpContext): string | undefined {
    const value = ctx.request.plainCookie(SESSION_COOKIE_NAME, undefined, false);
    return typeof value === 'string' && value !== '' ? value : undefined;
  }

  private writeSessionCookie(ctx: HttpContext, auth: ResolvedDashboardAuth, value: string): void {
    ctx.response.plainCookie(SESSION_COOKIE_NAME, value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.request.secure(),
      path: '/',
      maxAge: Math.floor(auth.ttlMs / 1000),
      encode: false,
    });
  }
}

/** Adapt an AdonisJS `HttpContext` to the framework-light {@link ApiRequest}. */
function toApiRequest(ctx: HttpContext): ApiRequest {
  return {
    params: ctx.params as Record<string, string | undefined>,
    query: ctx.request.qs() as Record<string, string | string[] | undefined>,
    body: ctx.request.body(),
  };
}
