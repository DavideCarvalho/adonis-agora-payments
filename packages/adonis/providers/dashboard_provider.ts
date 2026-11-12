import { readFile } from 'node:fs/promises';
import { basename, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService, HttpRouterService } from '@adonisjs/core/types';
import {
  currentTenantFilter,
  type ResolvedPaymentsTenancy,
  resolvePaymentsTenancy,
  tenantLabels,
  tenantOwnerTypes,
} from '../src/agora/tenancy.js';
import { AUDIT_ACTIONS, type BillingStore } from '../src/billing/billing_store.js';
import { OwnerScopingUnsupportedError, scopedBillingStore } from '../src/billing/scoped_store.js';
import type { WebhookHandler } from '../src/billing/webhook_processor.js';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import {
  type AccessDeniedInfo,
  resolveAccessDeniedPage,
} from '../src/dashboard/access_denied_page.js';
import { createRefundAction, createReplayAction } from '../src/dashboard/actions.js';
import {
  type ConsoleAuthorizeDecision,
  resolveConsoleAuthorize,
} from '../src/dashboard/console_authorize.js';
import {
  listVisibleConsoles,
  otherConsoles,
  paymentsConsoleSearch,
  readAgoraConsoles,
  registerAgoraConsole,
  searchConsoles,
} from '../src/dashboard/console_switcher.js';
import {
  type PaymentsDashboardConfig,
  type ResolvedPaymentsDashboardConfig,
  resolveConfig,
} from '../src/dashboard/define_config.js';
import {
  type DevToolsDecision,
  type PaymentsApiRoute,
  registerPaymentsDevTools,
} from '../src/dashboard/dev_tools.js';
import type { ProviderCapabilities } from '../src/dashboard/handlers.js';
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
  subscriptionDetail,
  subscriptions,
  webhookEvents,
} from '../src/dashboard/handlers.js';
import { contentTypeFor, renderIndexHtml } from '../src/dashboard/spa.js';
import {
  type ConsoleTenantScope,
  ownerScopeOfConsole,
  resolveConsoleTenantScope,
} from '../src/dashboard/tenant_scope.js';
import type { BillingHandlers, PaymentsConfig } from '../src/define_config.js';
import { PaymentsManager } from '../src/payments_manager.js';
import { getBillingStore } from '../src/services/main.js';
import { gatewayPerforms } from '../src/subscription_lifecycle.js';
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

/** This console's id in the app's `'agora.consoles'` registry. */
const CONSOLE_ID = 'payments';

/** Logged once at boot when `authorize` is omitted. Same wording in every Agora console. */
export const NO_AUTHORIZE_WARNING =
  '[@adonis-agora/payments] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/payments_dashboard.ts.';

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
 * - `GET  /api/subscriptions`    -> a page of `billing_subscriptions` (status/provider/customer filters)
 * - `GET  /api/subscriptions/:id` -> one subscription: state, customer, its payments, the ledger
 *                                   rows naming them, and its audit rows
 * - `GET  /api/webhook-events`   -> a page of `billing_webhook_events` (status/provider/type)
 * - `GET  /api/providers`        -> the gateways and event types this install has data for
 * - `POST /api/payments/:gatewayId/refund`           -> refund through the payment's own gateway
 * - `POST /api/disputes/:gatewayId/resolve`          -> record how a dispute ended, and who said so
 * - `POST /api/webhook-events/:gatewayEventId/retry` -> re-run a failed event's handlers
 *
 * Sign-in is the app's own: the console has no login page. `authorize` may answer
 * `{ redirectTo: '/login' }` to send a page navigation to the app's sign-in.
 *
 * With `enabled: false` this provider registers NOTHING — not the SPA, not the API. The dashboard is then completely absent from the app's route table.
 */
export default class PaymentsDashboardProvider {
  constructor(protected app: ApplicationService) {}

  /** Warn once so a throwing `authorize` hook doesn't spam the logs on every request. */
  private warnedOnAuthorizeThrow = false;
  /** The `authorize` option turned into one guard (a lazy import is memoized inside it). */
  private authorizeGuard: (ctx: HttpContext) => Promise<ConsoleAuthorizeDecision> = async () => ({
    allowed: false,
    status: 403,
    reason: 'forbidden',
  });

  /** Each request's `authorize` verdict, read again for the console's organization scope. */
  private readonly decisions = new WeakMap<HttpContext, ConsoleAuthorizeDecision>();
  /** Each request's resolved organization scope (`null` = tenancy off). */
  private readonly scopes = new WeakMap<HttpContext, ConsoleTenantScope | null>();

  async boot() {
    const config = resolveConfig(
      this.app.config.get<PaymentsDashboardConfig>('payments_dashboard', {}),
    );
    if (!config.enabled) return;
    this.authorizeGuard = await this.resolveGuard(config);

    // Developer tools on the app's dev MCP endpoint, when `@adonis-agora/agent/mcp_provider` bound
    // its hub (its `register()` ran before any `boot()`). Gated by this console's own `authorize`.
    await this.registerDevTools(config);

    // The console switcher: this console joins the app's `'agora.consoles'` registry so the other
    // Agora consoles can link to it (and search it), and it can link to them.
    await this.registerConsole(config);

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

    this.registerSpaRoutes(router, config, apiBase);

    const json = (
      handler: (d: Deps, req: ApiRequest) => Promise<ApiResponse>,
      needsActions = false,
      needsCapabilities = false,
      /** A view over every organization (health, the webhook ledger, the audit trail). */
      everyOrganization = false,
    ) => {
      return async (ctx: HttpContext) => {
        const guard = await this.enforce(config, ctx, 'api');
        if (!guard.allowed) return;
        const result = await this.serveApi(
          config,
          ctx,
          { handler, needsActions, needsCapabilities, everyOrganization },
          toApiRequest(ctx),
          guard.actor,
        );
        return ctx.response.status(result.status).json(result.body);
      };
    };

    router
      .get(`${apiBase}/health`, json(health, false, false, true))
      .as('payments_dashboard.health');
    router.get(`${apiBase}/overview`, json(overview)).as('payments_dashboard.overview');
    router
      .get(`${apiBase}/payments`, json(payments, false, true))
      .as('payments_dashboard.payments');
    // Registered AFTER the collection route and before the refund `POST`, and the ordering is
    // only cosmetic here — `/payments` and `/payments/:gatewayId` cannot shadow each other — but
    // it keeps the read routes reading top-down.
    router
      .get(`${apiBase}/payments/:gatewayId`, json(paymentDetail, false, true))
      .as('payments_dashboard.payments.show');
    router.get(`${apiBase}/customers`, json(customers)).as('payments_dashboard.customers');
    router
      .get(`${apiBase}/audit`, json(auditEvents, false, false, true))
      .as('payments_dashboard.audit');
    // There is still no "fight" or "accept" route, on purpose: whether to submit evidence or
    // refund is a business rule that stays in the app's code. The `resolve` POST below is a
    // different thing — it records an outcome that already happened at the gateway.
    router.get(`${apiBase}/disputes`, json(disputes)).as('payments_dashboard.disputes');
    router
      .get(`${apiBase}/subscriptions`, json(subscriptions))
      .as('payments_dashboard.subscriptions');
    // One subscription in full (by this store's id or the gateway's), scoped like every read.
    router
      .get(`${apiBase}/subscriptions/:id`, json(subscriptionDetail, false, true))
      .as('payments_dashboard.subscriptions.show');
    router
      .get(`${apiBase}/webhook-events`, json(webhookEvents, false, false, true))
      .as('payments_dashboard.webhook_events');
    // `needsCapabilities`: é a única rota que precisa do manager só para LER o que os drivers
    // suportam. Resolvê-lo em toda leitura pagaria o custo em páginas que não usam o dado.
    router
      // `false, true` = não precisa das ações, precisa das capabilities.
      .get(`${apiBase}/providers`, json(providers, false, true))
      .as('payments_dashboard.providers');

    // The console's only WRITE routes. `POST` is load-bearing, not stylistic: registering either of
    // these as a `GET` would put "refund this customer" behind a link a prefetcher can follow.
    router
      .post(`${apiBase}/payments/:gatewayId/refund`, json(refundPayment, true))
      .as('payments_dashboard.payments.refund');
    router
      .post(
        `${apiBase}/webhook-events/:gatewayEventId/retry`,
        json(retryWebhookEvent, true, false, true),
      )
      .as('payments_dashboard.webhook_events.retry');
    // No `needsActions`: this one calls no gateway. It records how a dispute ENDED — the loop a
    // gateway that publishes no lost-dispute event never closes on its own — so it stays
    // available on a deployment whose payments manager is unreachable.
    router
      .post(`${apiBase}/disputes/:gatewayId/resolve`, json(resolveDispute))
      .as('payments_dashboard.disputes.resolve');

    // The console switcher: the other Agora consoles this viewer may open, and a search across them.
    router
      .get(`${apiBase}/consoles`, async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'api')).allowed) return;
        const registry = await readAgoraConsoles(this.app.container as never);
        ctx.response.header('cache-control', 'private, no-store');
        return ctx.response.status(200).json(await listVisibleConsoles(registry, CONSOLE_ID, ctx));
      })
      .as('payments_dashboard.consoles');
    router
      .get(`${apiBase}/consoles/search`, async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'api')).allowed) return;
        const registry = await readAgoraConsoles(this.app.container as never);
        const q = ctx.request.qs().q;
        ctx.response.header('cache-control', 'private, no-store');
        return ctx.response
          .status(200)
          .json(await searchConsoles(registry, CONSOLE_ID, ctx, typeof q === 'string' ? q : ''));
      })
      .as('payments_dashboard.consoles.search');

    // Organizations (tenancy): which ones this viewer may pick, and an audited record of a switch.
    // Mounted only with tenancy on; without it the console has no organization control.
    if (this.tenancy().enabled) this.registerTenantRoutes(router, config, apiBase);
  }

  /**
   * Serve one console API handler for a request that already passed `authorize`: the viewer's
   * organization scope (narrowed to `tenant` when given), the deps, the handler, and the console's
   * error answers. The JSON API and the dev tools both come through here, so both answer the same.
   */
  private async serveApi(
    config: ResolvedPaymentsDashboardConfig,
    ctx: HttpContext,
    route: PaymentsApiRoute,
    req: ApiRequest,
    actor: string | undefined,
    tenant?: string,
  ): Promise<ApiResponse> {
    let store: BillingStore;
    try {
      store = getBillingStore();
    } catch (error) {
      // The billing layer is off (or the app hasn't booted it). That is a deployment state,
      // not a bug in the request — say so with a 503 rather than a stack-trace-shaped 500.
      return {
        status: 503,
        body: { error: error instanceof Error ? error.message : 'billing store unavailable' },
      };
    }
    // Organizations (tenancy): confine every read to what this viewer may see.
    const scope = await this.consoleTenantScope(ctx, store, tenant);
    if (scope !== null && scope.ids !== undefined) {
      if (route.everyOrganization === true) {
        return {
          status: 404,
          body: { error: 'This view spans every organization; it is not available in one.' },
        };
      }
      store = scopedBillingStore(
        store,
        ownerScopeOfConsole(scope, tenantOwnerTypes(this.tenancy())),
      );
    }
    try {
      const deps: Deps = {
        store,
        currency: config.currency,
        // WHO is asking: the app's signed-in user (`ctx.auth.user`), or `bearer` for a
        // token caller. It lets a refund and a dispute resolution be recorded against a
        // person. Absent when nobody is identifiable — recorded as "unattributed", never
        // invented.
        ...(actor !== undefined ? { actor } : {}),
        // Resolved lazily and only for the routes that need it: a console whose payments
        // manager is unreachable must still serve every read.
        ...(route.needsActions === true ? { actions: await this.actions(store) } : {}),
        ...(await this.capabilityDeps(route.needsCapabilities === true)),
      };
      return await route.handler(deps, req);
    } catch (error) {
      if (error instanceof OwnerScopingUnsupportedError) {
        return { status: 501, body: { error: error.message } };
      }
      return {
        status: 500,
        body: { error: error instanceof Error ? error.message : 'internal error' },
      };
    }
  }

  /** The console gate, remembered for the request so its organization scope reads the same verdict. */
  private async decide(ctx: HttpContext): Promise<ConsoleAuthorizeDecision> {
    const decision = await this.authorizeGuard(ctx);
    this.decisions.set(ctx, decision);
    return decision;
  }

  /** Join the app's console switcher, searchable over the rows this viewer may see. */
  private async registerConsole(config: ResolvedPaymentsDashboardConfig): Promise<void> {
    try {
      await registerAgoraConsole(
        this.app.container as never,
        {
          id: CONSOLE_ID,
          title: 'Payments',
          package: '@adonis-agora/payments',
          icon: 'payments',
          path: config.path === '' ? '/' : config.path,
          order: 40,
          authorize: (ctx) => this.decide(ctx),
          search: paymentsConsoleSearch((ctx) => this.searchStore(ctx), config.path),
        },
        { warn: (message) => void this.warn(message) },
      );
    } catch (error) {
      await this.warn(
        `[@adonis-agora/payments] could not join the console switcher: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The billing store as this viewer may read it: confined to their organizations when tenancy is
   * on (the grant of `authorize`, or their own; never a `?tenant=` of another console's page), or
   * `undefined` when there is nothing they may search.
   */
  private async searchStore(ctx: HttpContext): Promise<BillingStore | undefined> {
    const store = findBillingStoreQuietly();
    if (store === undefined) return undefined;
    const decision = this.decisions.get(ctx) ?? (await this.decide(ctx));
    if (!decision.allowed) return undefined;
    const scope = await this.consoleTenantScope(ctx, store, '*');
    if (scope === null || scope.ids === undefined) return store;
    if (scope.ids.length === 0 && !scope.includeNull) return undefined;
    return scopedBillingStore(store, ownerScopeOfConsole(scope, tenantOwnerTypes(this.tenancy())));
  }

  /** Best-effort warning: a missing logger never stops the app. */
  private async warn(message: string): Promise<void> {
    try {
      const logger = await this.app.container.make('logger');
      logger.warn(message);
    } catch {
      // Logging is best-effort.
    }
  }

  /** Register the console's tools into the app's dev-tools hub, when it has one. */
  private async registerDevTools(config: ResolvedPaymentsDashboardConfig): Promise<void> {
    try {
      await registerPaymentsDevTools(
        this.app.container as unknown as Parameters<typeof registerPaymentsDevTools>[0],
        {
          authorize: async (ctx) => devToolsDecisionOf(await this.decide(ctx)),
          serve: async (ctx, route, req, { actor, tenant }) => {
            // The hub ran `authorize` for this request already; a call without it still gets it.
            const decision = this.decisions.get(ctx) ?? (await this.decide(ctx));
            if (!decision.allowed) {
              const status = decision.status === 403 ? 403 : 401;
              return {
                status,
                body: { error: status === 403 ? 'forbidden' : 'unauthenticated' },
              };
            }
            return this.serveApi(config, ctx, route, req, actor, tenant);
          },
          canRefund: async () =>
            Object.values((await this.capabilities()) ?? {}).some((c) => c.refunds),
          tenancyEnabled: () => this.tenancy().enabled,
          organizations: (ctx) => this.tenantPicker(ctx),
        },
      );
    } catch (error) {
      // An auxiliary feature: a hub that throws must not take the app's boot down with it.
      try {
        const logger = await this.app.container.make('logger');
        logger.warn(
          `[@adonis-agora/payments] could not register the developer tools: ${error instanceof Error ? error.message : String(error)}`,
        );
      } catch {
        // Logging is best-effort.
      }
    }
  }

  private registerTenantRoutes(
    router: HttpRouterService,
    config: ResolvedPaymentsDashboardConfig,
    apiBase: string,
  ): void {
    router
      .get(`${apiBase}/tenants`, async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'api')).allowed) return;
        ctx.response.header('cache-control', 'private, no-store');
        try {
          return ctx.response.status(200).json(await this.tenantPicker(ctx));
        } catch (error) {
          return ctx.response
            .status(500)
            .json({ error: error instanceof Error ? error.message : 'internal error' });
        }
      })
      .as('payments_dashboard.tenants');
    router
      .post(`${apiBase}/tenants/:id/select`, async (ctx: HttpContext) => {
        const guard = await this.enforce(config, ctx, 'api');
        if (!guard.allowed) return;
        const id = String(ctx.params.id);
        const store = findBillingStoreQuietly();
        const scope = await this.consoleTenantScope(ctx, store, id);
        const allowed =
          scope === null ||
          id === '*' ||
          scope.authorized === '*' ||
          (Array.isArray(scope.authorized) && scope.authorized.includes(id));
        if (allowed && scope !== null) {
          await store
            ?.recordAuditEvent({
              action: AUDIT_ACTIONS.tenantSelected,
              actor: guard.actor ?? null,
              subjectType: 'organization',
              subjectId: id,
            })
            .catch(() => {});
        }
        return ctx.response
          .status(allowed ? 200 : 404)
          .json(allowed ? { tenant: id } : { error: 'not found' });
      })
      .as('payments_dashboard.tenants.select');
  }

  /** `config/payments.ts`'s `tenancy`, resolved against `config/context.ts`. */
  private tenancy(): ResolvedPaymentsTenancy {
    return resolvePaymentsTenancy(this.app.config.get<PaymentsConfig>('payments', {}).tenancy);
  }

  /**
   * The organizations this viewer may see, once per request, or `null` with tenancy off.
   * `authorize` may grant `tenants` (`'*'` or a list); otherwise it is the viewer's own active
   * organization. A `?tenant=` pick outside the grant reads as empty and is audited.
   */
  private async consoleTenantScope(
    ctx: HttpContext,
    store: BillingStore | undefined,
    pickOverride?: string,
  ): Promise<ConsoleTenantScope | null> {
    const tenancy = this.tenancy();
    if (!tenancy.enabled) return null;
    const known = this.scopes.get(ctx);
    if (known !== undefined && pickOverride === undefined) return known;
    let decision = this.decisions.get(ctx);
    if (decision === undefined) {
      decision = await this.authorizeGuard(ctx);
      this.decisions.set(ctx, decision);
    }
    const granted = decision.allowed ? decision.tenants : undefined;
    // `required` makes a missing organization throw: in the console that is just "none".
    let own: { id: string; kind?: string; slug?: string } | undefined;
    try {
      const filter = currentTenantFilter(tenancy);
      if (filter.mode === 'tenant') {
        own = {
          id: filter.tenant.id,
          kind: filter.tenant.kind,
          ...(filter.tenant.slug !== undefined ? { slug: filter.tenant.slug } : {}),
        };
      }
    } catch {
      own = undefined;
    }
    const picked = pickOverride ?? ctx.request.qs().tenant;
    const scope = resolveConsoleTenantScope({
      granted,
      own,
      selected: typeof picked === 'string' ? picked : undefined,
      nullRows: tenancy.nullRows,
    });
    if (scope.forged) {
      await store
        ?.recordAuditEvent({
          action: AUDIT_ACTIONS.tenantForged,
          actor: auditActor(ctx) ?? null,
          subjectType: 'organization',
          subjectId: scope.selected ?? null,
          message: `${ctx.request.method()} ${ctx.request.url(false)}: organization outside the viewer's scope`,
        })
        .catch(() => {});
    }
    if (pickOverride === undefined) this.scopes.set(ctx, scope);
    return scope;
  }

  /**
   * What the console's "Organization" control shows: `off` (tenancy off), `none` (a viewer with no
   * organization), `fixed` (one), or `pick` (several, or every one with `all`).
   */
  private async tenantPicker(ctx: HttpContext): Promise<{
    mode: 'off' | 'none' | 'fixed' | 'pick';
    all: boolean;
    selected: string | null;
    ownerTypes: string[];
    tenants: Array<{ id: string; label: string }>;
  }> {
    const store = findBillingStoreQuietly();
    const scope = await this.consoleTenantScope(ctx, store);
    const empty = { all: false, selected: null, ownerTypes: [], tenants: [] };
    if (scope === null) return { mode: 'off', ...empty };
    const ownerTypes = tenantOwnerTypes(this.tenancy());
    // An explicit empty grant (`tenants: []`) is "no organization" too, not an empty chip.
    if (scope.authorized === 'none' || scope.authorized.length === 0) {
      return { mode: 'none', ...empty, ownerTypes };
    }
    const ids =
      scope.authorized === '*'
        ? await everyTenantId(store, ownerTypes)
        : [...new Set(scope.authorized)];
    const labels = await tenantLabels(ids, scope.own?.kind);
    if (scope.own?.slug !== undefined && labels[scope.own.id] === scope.own.id) {
      labels[scope.own.id] = scope.own.slug;
    }
    return {
      mode: scope.authorized === '*' || ids.length > 1 ? 'pick' : 'fixed',
      all: scope.authorized === '*',
      selected: scope.selected ?? null,
      ownerTypes,
      tenants: ids
        .map((id) => ({ id, label: labels[id] ?? id }))
        .sort((x, y) => x.label.localeCompare(y.label)),
    };
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

  /**
   * O que cada gateway configurado sabe fazer, para o console não oferecer o que falha.
   *
   * `undefined` quando o manager não está alcançável — a UI volta a mostrar as ações, que é o
   * comportamento anterior e melhor do que esconder tudo por falta de dado.
   */
  /** O spread de `capabilities` só quando há valor — `exactOptionalPropertyTypes` é estrito. */
  private async capabilityDeps(
    needed: boolean,
  ): Promise<{ capabilities?: Record<string, ProviderCapabilities> }> {
    if (!needed) return {};
    const capabilities = await this.capabilities();
    return capabilities === undefined ? {} : { capabilities };
  }

  private async capabilities(): Promise<Record<string, ProviderCapabilities> | undefined> {
    let manager: PaymentsManager;
    try {
      manager = await this.app.container.make(PaymentsManager);
    } catch {
      return undefined;
    }

    const capabilities: Record<string, ProviderCapabilities> = {};
    for (const [name, driver] of manager.drivers) {
      capabilities[name] = {
        refunds: driver.capabilities?.refunds === true,
        disputes: driver.capabilities?.disputes === true,
        cancelSubscription: gatewayPerforms(driver, 'cancel'),
      };
    }
    return capabilities;
  }

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
      tenancy: () => resolvePaymentsTenancy(config.tenancy),
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
          .send(
            renderIndexHtml(html, config.path, apiBase, config.currency, {
              endpoint: `${apiBase}/consoles`,
              others: otherConsoles(
                await readAgoraConsoles(this.app.container as never),
                CONSOLE_ID,
              ),
            }),
          );
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
   * The `authorize` option turned into one guard. Omitted: open outside production, every request
   * refused (`403`) in production; either way it says so once at boot (the provider boots once).
   */
  private async resolveGuard(
    config: ResolvedPaymentsDashboardConfig,
  ): Promise<(ctx: HttpContext) => Promise<ConsoleAuthorizeDecision>> {
    if (config.authorize) return resolveConsoleAuthorize(config.authorize);
    try {
      const logger = await this.app.container.make('logger');
      logger.warn(NO_AUTHORIZE_WARNING);
    } catch {
      // Logging is best-effort: a missing logger must not stop the app from booting.
    }
    if (this.app.inProduction !== true) return async () => ({ allowed: true });
    return async () => ({ allowed: false, status: 403, reason: 'forbidden' });
  }

  private async warnAuthorizeThrow(hookError: unknown): Promise<void> {
    if (this.warnedOnAuthorizeThrow) return;
    this.warnedOnAuthorizeThrow = true;
    const message = hookError instanceof Error ? hookError.message : String(hookError);
    try {
      const logger = await this.app.container.make('logger');
      logger.warn(`payments dashboard authorize hook threw; treating as denial (403). ${message}`);
    } catch {
      // Logging is best-effort: a missing logger must not turn the 403 into a 500.
    }
  }

  /**
   * Run the `authorize` gate for a dashboard resource:
   *
   * - `authorize` answered `{ redirectTo }` -> `302` there for a `page` request, `401` JSON for an
   *    `api` request. `authorize` denies -> `401` when it answered `{ allowed: false, reason: 'unauthenticated' }`,
   *    `403` otherwise (`false`, `{ allowed: false }`, `reason: 'forbidden'`, or a thrown hook):
   *    the built-in (or host-customised) access-denied PAGE for a `page` request,
   *    `{ error: 'unauthenticated' | 'forbidden' }` JSON for an `api` request (a redirect answers
   *    `401 { error: 'unauthenticated', redirectTo }`). A hook that already
   *    answered (a redirect, a queued body) keeps its answer.
   *
   * Returns `allowed: false` (and has already written the response) when the request must
   * short-circuit. On success it also carries WHO passed the gate ({@link auditActor}), which the
   * write handlers record against a refund or a dispute resolution.
   */
  private async enforce(
    config: ResolvedPaymentsDashboardConfig,
    ctx: HttpContext,
    mode: 'page' | 'api',
  ): Promise<{ allowed: boolean; actor?: string }> {
    // Never `if (!(await authorize(ctx)))`: a `{ allowed: false }` decision is truthy.
    const decision = await this.decide(ctx);
    if (!decision.allowed) {
      if (decision.status === 403 && decision.error !== undefined) {
        await this.warnAuthorizeThrow(decision.error);
      }
      if (decision.status === 302) {
        if (responseAnswered(ctx)) return { allowed: false };
        if (mode === 'page') ctx.response.redirect(decision.redirectTo);
        else {
          ctx.response
            .status(401)
            .json({ error: 'unauthenticated', redirectTo: decision.redirectTo });
        }
        return { allowed: false };
      }
      if (mode === 'page') {
        await this.denyPage(ctx, config, { status: decision.status, reason: decision.reason });
      } else if (!responseAnswered(ctx)) {
        ctx.response
          .status(decision.status)
          .json({ error: decision.status === 401 ? 'unauthenticated' : 'forbidden' });
      }
      return { allowed: false };
    }

    const actor = auditActor(ctx);
    return actor !== undefined ? { allowed: true, actor } : { allowed: true };
  }

  /**
   * Answer a refused PAGE navigation with HTML instead of the API's JSON: the built-in page, the
   * host's tweaked version of it, or whatever the host's `accessDenied` renderer produced. Stands
   * down when the request is already answered — an `authorize` hook (or the renderer) that wrote a
   * redirect keeps it; the provider never overwrites a `location` header.
   */
  private async denyPage(
    ctx: HttpContext,
    config: ResolvedPaymentsDashboardConfig,
    denial: Pick<AccessDeniedInfo, 'status' | 'reason'>,
  ): Promise<void> {
    const answered = () => responseAnswered(ctx);
    if (answered()) return;
    const nonce = cspNonce(ctx);
    const info: AccessDeniedInfo = {
      ...denial,
      basePath: config.path,
      ...(nonce !== undefined ? { nonce } : {}),
    };
    const html = await resolveAccessDeniedPage(info, config.accessDenied, ctx, answered);
    if (html === null) return;
    ctx.response
      .status(info.status)
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store, must-revalidate')
      .send(html);
  }
}

/**
 * Whether something already answered this request: a redirect (`location` header — the signal the
 * `authorize` contract has always honoured) or a body queued on the response. The body check reads
 * AdonisJS's `response.hasLazyBody` structurally so a plain-object `ctx` double in a unit test
 * (which has neither) still works.
 */
function responseAnswered(ctx: HttpContext): boolean {
  if (ctx.response.getHeader('location')) return true;
  const response = ctx.response as unknown as { hasLazyBody?: unknown; headersSent?: unknown };
  return response.hasLazyBody === true || response.headersSent === true;
}

/**
 * The request's CSP nonce when the host runs `@adonisjs/shield` with `@nonce` in its policy (shield
 * exposes it as `response.nonce`). Read structurally: this package neither depends on shield nor
 * cares which middleware minted the nonce — only that the page's inline `<style>` carries it.
 */
function cspNonce(ctx: HttpContext): string | undefined {
  const nonce = (ctx.response as unknown as { nonce?: unknown }).nonce;
  return typeof nonce === 'string' && nonce !== '' ? nonce : undefined;
}

/**
 * Who a console action is attributed to: the app's signed-in user (`ctx.auth.user`'s `email`,
 * `name` or `id`, read structurally — this package does not depend on `@adonisjs/auth`), `'bearer'`
 * for a caller with an `Authorization` header and no user, else `undefined` ("unattributed").
 */
export function auditActor(ctx: HttpContext): string | undefined {
  const user = (ctx as unknown as { auth?: { user?: Record<string, unknown> | null } }).auth?.user;
  if (user) {
    for (const key of ['email', 'name', 'id'] as const) {
      const value = user[key];
      if (typeof value === 'string' && value !== '') return value;
      if (typeof value === 'number') return String(value);
    }
  }
  return ctx.request.header('authorization') !== undefined ? 'bearer' : undefined;
}

/** Adapt an AdonisJS `HttpContext` to the framework-light {@link ApiRequest}. */
function toApiRequest(ctx: HttpContext): ApiRequest {
  // `tenant` picks the console's organization (see `consoleTenantScope`); it is not a row filter.
  const { tenant: _tenant, ...query } = ctx.request.qs() as Record<
    string,
    string | string[] | undefined
  >;
  return {
    params: ctx.params as Record<string, string | undefined>,
    query,
    body: ctx.request.body(),
  };
}

/** The billing store, or `undefined` when the billing layer is off. */
function findBillingStoreQuietly(): BillingStore | undefined {
  try {
    return getBillingStore();
  } catch {
    return undefined;
  }
}

/** The page size and page cap of the organization listing. */
const TENANT_SCAN_PAGE = 200;
const TENANT_SCAN_PAGES = 50;

/** Every organization that owns a billing customer (bounded scan of `billing_customers`). */
async function everyTenantId(
  store: BillingStore | undefined,
  ownerTypes: readonly string[],
): Promise<string[]> {
  if (store === undefined) return [];
  const ids = new Set<string>();
  for (const ownerType of ownerTypes) {
    for (let page = 1; page <= TENANT_SCAN_PAGES; page++) {
      const rows = await store.listCustomers({ ownerType, page, size: TENANT_SCAN_PAGE });
      for (const row of rows) if (row.ownerId !== null && row.ownerId !== '') ids.add(row.ownerId);
      if (rows.length < TENANT_SCAN_PAGE) break;
    }
  }
  return [...ids];
}

/** The console decision as the dev-tools hub reads it. */
function devToolsDecisionOf(decision: ConsoleAuthorizeDecision): DevToolsDecision {
  if (decision.allowed) return { allowed: true };
  if (decision.status === 302) {
    return { allowed: false, reason: 'unauthenticated', redirectTo: decision.redirectTo };
  }
  if (decision.status === 401) return { allowed: false, reason: 'unauthenticated' };
  return {
    allowed: false,
    reason: 'forbidden',
    ...(decision.error !== undefined ? { error: decision.error } : {}),
  };
}
