import { pathToFileURL } from 'node:url';
import type { ResolvedPaymentsTenancy } from '../agora/tenancy.js';
import type { BillingStore } from '../billing/billing_store.js';
import type { BillingOwnerScope } from '../billing/owner_scope.js';
import { OwnerScopingUnsupportedError, scopedBillingStore } from '../billing/scoped_store.js';
import { type WebhookHandler, WebhookProcessor } from '../billing/webhook_processor.js';
import type { BillingHandlers } from '../define_config.js';
import type { PaymentsDriver } from '../driver.js';
import { gatewayPerforms } from '../subscription_lifecycle.js';
import type { SubscriptionsApi } from '../subscriptions_api.js';
import type { WebhookEvent } from '../types.js';
import {
  discoverWebhookHandlers,
  loadWebhookHandlersFromBarrel,
  resolveWebhookHandler,
  type WebhookHandlersBarrel,
} from '../webhook_handlers.js';
import {
  createEvidenceAction,
  createRefundAction,
  createReplayAction,
  type EvidenceCapableDriver,
  type RefundCapableDriver,
} from './actions.js';
import type { PaymentsApiRoute } from './dev_tools.js';
import {
  type ApiRequest,
  type ApiResponse,
  auditEvents,
  cancelSubscription,
  customers,
  type DashboardActions,
  type Deps,
  disputes,
  health,
  overview,
  type ProviderCapabilities,
  paymentDetail,
  payments,
  providers,
  refundPayment,
  repriceSubscription,
  resolveDispute,
  resumeSubscription,
  retryWebhookEvent,
  submitDisputeEvidence,
  subscriptionDetail,
  subscriptions,
  webhookEvents,
} from './handlers.js';

/**
 * Every console handler with the switches it is served with. The console's JSON API, its dev
 * tools and the `payments:*` commands all serve these, so a handler answers the same everywhere.
 * `everyOrganization` views are refused to a caller scoped to some organizations.
 */
export const CONSOLE_ROUTES = {
  overview: { handler: overview },
  health: { handler: health, everyOrganization: true },
  payments: { handler: payments, needsCapabilities: true },
  paymentDetail: { handler: paymentDetail, needsCapabilities: true },
  customers: { handler: customers },
  audit: { handler: auditEvents, everyOrganization: true },
  disputes: { handler: disputes },
  subscriptions: { handler: subscriptions },
  subscriptionDetail: { handler: subscriptionDetail, needsCapabilities: true },
  webhookEvents: { handler: webhookEvents, everyOrganization: true },
  providers: { handler: providers, needsCapabilities: true },
  refund: { handler: refundPayment, needsActions: true },
  retry: { handler: retryWebhookEvent, needsActions: true, everyOrganization: true },
  resolve: { handler: resolveDispute },
  evidence: { handler: submitDisputeEvidence, needsActions: true },
  cancelSubscription: {
    handler: cancelSubscription,
    needsActions: true,
    needsCapabilities: true,
  },
  resumeSubscription: { handler: resumeSubscription, needsActions: true },
  repriceSubscription: {
    handler: repriceSubscription,
    needsActions: true,
    needsCapabilities: true,
  },
} satisfies Record<string, PaymentsApiRoute>;

/**
 * The console's operator core: what the console's JSON API, its dev tools and the `payments:*`
 * ace commands all go through to serve one console handler. One place builds the deps (the
 * organization-scoped store, the write ports, the gateway capabilities) and turns a throw into the
 * console's error answers, so the three surfaces answer the same thing for the same input.
 */

/** What {@link serveConsoleRoute} needs besides the route and the request. */
export interface ServeConsoleRouteOptions {
  /** The app's billing store, unscoped. */
  store: BillingStore;
  route: PaymentsApiRoute;
  req: ApiRequest;
  /** The console's display currency. */
  currency: string;
  /** Who the audit trail records for an action (`undefined` = unattributed). */
  actor?: string | undefined;
  /** The organizations the reads are confined to; `undefined` = every organization. */
  ownerScope?: BillingOwnerScope | undefined;
  /** The write ports, built over the (scoped) store. Only called for a route that needs them. */
  actions?: (store: BillingStore) => Promise<Partial<DashboardActions>>;
  /** What each configured gateway can do. Only called for a route that needs it. */
  capabilities?: () => Promise<Record<string, ProviderCapabilities> | undefined>;
  now?: () => Date;
}

/**
 * Serve one console handler: the organization scope (a view over every organization is refused to
 * a scoped caller), the deps, and the console's error answers (`501` for a store that cannot scope,
 * `500` with the message otherwise).
 */
export async function serveConsoleRoute(options: ServeConsoleRouteOptions): Promise<ApiResponse> {
  const { route } = options;
  let store = options.store;
  if (options.ownerScope !== undefined) {
    if (route.everyOrganization === true) {
      return {
        status: 404,
        body: { error: 'This view spans every organization; it is not available in one.' },
      };
    }
    store = scopedBillingStore(store, options.ownerScope);
  }
  try {
    const capabilities =
      route.needsCapabilities === true ? await options.capabilities?.() : undefined;
    const deps: Deps = {
      store,
      currency: options.currency,
      ...(options.actor !== undefined ? { actor: options.actor } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      // Resolved lazily and only for the routes that need it: a console whose payments manager is
      // unreachable must still serve every read.
      ...(route.needsActions === true && options.actions !== undefined
        ? { actions: await options.actions(store) }
        : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
    };
    return await route.handler(deps, options.req);
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

/** What each configured gateway can do, as the console needs to know it. */
export function consoleCapabilities(
  drivers: ReadonlyMap<string, PaymentsDriver>,
): Record<string, ProviderCapabilities> {
  const capabilities: Record<string, ProviderCapabilities> = {};
  for (const [name, driver] of drivers) {
    capabilities[name] = {
      refunds: driver.capabilities?.refunds === true,
      disputes: driver.capabilities?.disputes === true,
      cancelSubscription: gatewayPerforms(driver, 'cancel'),
      updateSubscription: gatewayPerforms(driver, 'update'),
    };
  }
  return capabilities;
}

/** The slice of `PaymentsManager` the write ports use. */
export interface ConsoleActionsManager {
  driver(name: string): RefundCapableDriver & EvidenceCapableDriver;
  subscriptions?(): Pick<SubscriptionsApi, 'cancel' | 'resume' | 'update'>;
}

/**
 * The console's write ports over a store: the refund (through the payment's own gateway), the
 * webhook replay (through a `WebhookProcessor` running the app's own handlers, not just the
 * built-in sync — a retry that skipped them would silently do half the job), dispute evidence
 * (through the dispute's gateway) and the subscription operations (`manager.subscriptions()`).
 */
export function createConsoleActions(deps: {
  manager: ConsoleActionsManager;
  store: BillingStore;
  handlers?: Record<string, WebhookHandler> | undefined;
  tenancy: () => ResolvedPaymentsTenancy;
}): Partial<DashboardActions> {
  const processor = new WebhookProcessor({
    store: deps.store,
    ...(deps.handlers !== undefined ? { handlers: deps.handlers } : {}),
    tenancy: deps.tenancy,
  });
  return {
    refund: createRefundAction((provider) => deps.manager.driver(provider)),
    submitEvidence: createEvidenceAction((provider) => deps.manager.driver(provider)),
    // The event is rebuilt from the ledger's own `payload` + `normalized` columns and run
    // straight through the processor — no driver, no `parseWebhook`, so no signature to
    // re-verify from headers nobody kept.
    replayWebhook: createReplayAction({
      store: deps.store,
      process: (event) => processor.process(event as WebhookEvent),
    }),
    ...(typeof deps.manager.subscriptions === 'function'
      ? { subscriptions: deps.manager.subscriptions() }
      : {}),
  };
}

/**
 * The app's webhook handlers from `config.billing.handlers` plus `app/payment_handlers/`
 * (build-time barrel, runtime scan as fallback) — the two sources the payments provider merges.
 */
export async function resolveAppWebhookHandlers(
  app: {
    makePath(...paths: string[]): string;
    container: Parameters<typeof resolveWebhookHandler>[1];
  },
  configHandlers: BillingHandlers | undefined,
): Promise<Record<string, WebhookHandler> | undefined> {
  const handlers: Record<string, WebhookHandler> = {};
  if (configHandlers) {
    for (const [type, entry] of Object.entries(configHandlers)) {
      handlers[type] = await resolveWebhookHandler(entry, app.container);
    }
  }
  for (const discovered of await discoverAppHandlers(app)) {
    handlers[discovered.type] = await resolveWebhookHandler(discovered.entry, app.container);
  }
  return Object.keys(handlers).length > 0 ? handlers : undefined;
}

async function discoverAppHandlers(app: { makePath(...paths: string[]): string }) {
  try {
    const path = app.makePath('.adonisjs/payments/webhook_handlers.js');
    const mod = (await import(pathToFileURL(path).href)) as {
      webhookHandlers?: WebhookHandlersBarrel;
    };
    if (mod.webhookHandlers) return loadWebhookHandlersFromBarrel(mod.webhookHandlers);
  } catch {
    // No generated barrel — fall through to the runtime scan.
  }
  return discoverWebhookHandlers(app.makePath('app/payment_handlers'));
}

/** The page size and page cap of the organization listing. */
const TENANT_SCAN_PAGE = 200;
const TENANT_SCAN_PAGES = 50;

/** Every organization that owns a billing customer (bounded scan of `billing_customers`). */
export async function everyTenantId(
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
