import { pathToFileURL } from 'node:url';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService, HttpRouterService } from '@adonisjs/core/types';
import type { BillingStore } from '../src/billing/billing_store.js';
import { AUDIT_ACTIONS } from '../src/billing/billing_store.js';
import { LucidBillingStore } from '../src/billing/lucid_billing_store.js';
import {
  assertRoleIsDispatchable,
  resolveDispatchMode,
  resolveRole,
} from '../src/billing/resolve_dispatch.js';
import { isInjectableAsLucid, resolveBillingStore } from '../src/billing/resolve_store.js';
import type { DurableEngineLike, WebhookDispatchMode } from '../src/billing/webhook_dispatcher.js';
import { WebhookDispatcher } from '../src/billing/webhook_dispatcher.js';
import type { WebhookHandler } from '../src/billing/webhook_processor.js';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import type { BillingHandlers, PaymentsConfig } from '../src/define_config.js';
import {
  newPaymentsTraceId,
  type PaymentsTraceFrame,
  publishWebhookVerification,
  runWithPaymentsTrace,
  webhookVerificationOutcome,
} from '../src/diagnostics.js';
import { InvoiceManager, resolveInvoiceProviders } from '../src/invoice/invoice_manager.js';
import { PaymentsManager, resolveDrivers } from '../src/payments_manager.js';
import {
  getBillingStore,
  setBillingStore,
  setPayments,
  setWebhookDispatcher,
} from '../src/services/main.js';
import {
  assertWebhookHandlerTypes,
  type DiscoveredWebhookHandler,
  discoverWebhookHandlers,
  loadWebhookHandlersFromBarrel,
  resolveWebhookHandler,
  type WebhookHandlerRegistration,
  type WebhookHandlersBarrel,
} from '../src/webhook_handlers.js';
import { assertWebhookVerification } from '../src/webhook_security.js';

/**
 * Wires `@adonis-agora/payments` into the AdonisJS application: binds a singleton
 * {@link PaymentsManager} built from `config/payments.ts`, wires the optional Lucid
 * billing layer (store + webhook processor + dispatcher), and mounts the webhook route
 * under `/payments/webhook/:provider`.
 */
export default class PaymentsProvider {
  #webhook: WebhookDispatcher | undefined;
  /** Held for the webhook route: a REFUSED delivery is filed here, having no ledger row. */
  #store: BillingStore | undefined;

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
        ...(config.subscriptions !== undefined ? { subscriptions: config.subscriptions } : {}),
        // Lazy on purpose: this runs before the billing layer is built in `boot()`, so
        // resolving the store here would either fail or force billing on apps that route
        // every subscription to the gateway and never need it.
        store: () => getBillingStore(),
      });
      // Hand the manager to the lazy `services/main` singleton so `getPayments()` works.
      setPayments(manager);
      return manager;
    });
  }

  /** Kept so `shutdown()` can release the channel claims it took. */
  #telescopeWatcher: { dispose(): void } | undefined;

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
      const manager = await this.app.container.make(PaymentsManager);
      // Before the route goes up, not after: a driver with an empty webhook-credential slot
      // verifies nothing, and the route it would be mounted behind is reachable from the
      // public internet. Fail closed at boot, the way the dashboard does on a missing session
      // secret.
      assertWebhookVerification(manager.drivers, {
        ...(config.allowUnverifiedWebhooks !== undefined
          ? { allowUnverifiedWebhooks: config.allowUnverifiedWebhooks }
          : {}),
      });
      // A 'worker' process consumes what the api half enqueued; it must not also
      // advertise an endpoint gateways could deliver to.
      if (resolveRole(config) !== 'worker') {
        const router = await this.app.container.make('router');
        this.#registerWebhookRoute(router);
      }
    });
  }

  /**
   * Wire the typed `payments` Telescope watcher, if telescope is in this app and nobody has
   * already wired one.
   *
   * In `ready()`, not `boot()`, and that is the load-bearing part: `start/` files run before
   * `ready`, so an app that registers its own `PaymentsWatcher` — the way the docs used to
   * say to — has already claimed the payments channels by the time this looks, and this
   * stands down. Doing it in `boot()` would race that and record every payment event twice
   * for exactly the apps that followed the instructions.
   *
   * There is no config option. Every one that was drafted described something the code can
   * detect: the claims registry answers "I wire my own", and a failed import answers "I do
   * not use telescope".
   */
  async ready() {
    const { registerPaymentsWatcher } = await import('../src/telescope/register.js');
    this.#telescopeWatcher = await registerPaymentsWatcher(this.app);
  }

  /** Release the watcher's channel claims and subscriptions on shutdown. */
  async shutdown(): Promise<void> {
    this.#telescopeWatcher?.dispose();
    this.#telescopeWatcher = undefined;
  }

  async #buildBillingLayer(config: PaymentsConfig): Promise<void> {
    const mode = resolveDispatchMode(config);
    const role = resolveRole(config);
    assertRoleIsDispatchable(role, mode);

    const store = await this.#resolveBillingStore(config);
    this.#store = store;
    let handlers: Record<string, WebhookHandler> | undefined;
    if (role === 'api') {
      // The handlers run on the worker, so resolving them here would scan the folder and
      // build services this process never calls. The TYPES are still checked, from config
      // alone: a misspelled key is a config error on both halves of the deployment, and the
      // api process is usually the one a developer boots first.
      assertWebhookHandlerTypes(
        Object.keys(config.billing?.handlers ?? {}).map((type) => ({
          type,
          source: 'billing.handlers',
        })),
        {
          ...(config.billing?.passthroughEvents !== undefined
            ? { passthroughEvents: config.billing.passthroughEvents }
            : {}),
        },
      );
    } else {
      handlers = await this.#resolveAllHandlers(
        config.billing?.handlers,
        config.billing?.passthroughEvents,
      );
    }
    const processor = new WebhookProcessor({
      store,
      ...(handlers !== undefined ? { handlers } : {}),
    });
    const dispatcher = new WebhookDispatcher({
      processor,
      mode,
      // In 'auto', durable is used only when its engine is resolvable in the app
      // (i.e. the durable provider is registered) — not merely installed.
      durableAvailable: () => this.#isDurableAvailable(),
      // The engine itself, not just "is it there": the dispatcher has to REGISTER the
      // webhook workflow on the app's engine before it can start a run on it.
      durableEngine: () => this.#resolveDurableEngine(),
    });
    this.#webhook = dispatcher;
    // Published so tests can reach it: `flushWebhooks()` from
    // `@adonis-agora/payments/testing` awaits the in-flight processing that durable mode
    // deliberately does not await. Bound in the container too, for an app that prefers
    // `@inject()` over the service accessor.
    setWebhookDispatcher(dispatcher);
    this.app.container.singleton(WebhookDispatcher, () => dispatcher);
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
    passthroughEvents: readonly string[] | undefined,
  ): Promise<Record<string, WebhookHandler> | undefined> {
    const discovered = await this.#discoverFolderHandlers();
    // Validated BEFORE anything is wired, so the app never boots half-registered. A handler
    // for an event type that will never be delivered is a silent no-op — the ledger records
    // the delivery as processed and the grant simply never happens — and two handlers for
    // one type mean the second overwrote the first in the map below.
    const registrations: WebhookHandlerRegistration[] = [
      ...Object.keys(configHandlers ?? {}).map((type) => ({
        type,
        source: 'billing.handlers',
      })),
      ...discovered.map((entry) => ({
        type: entry.type,
        source: entry.source ?? 'app/payment_handlers',
      })),
    ];
    assertWebhookHandlerTypes(registrations, {
      ...(passthroughEvents !== undefined ? { passthroughEvents } : {}),
    });

    const handlers: Record<string, WebhookHandler> = {};
    if (configHandlers) {
      for (const [type, entry] of Object.entries(configHandlers)) {
        handlers[type] = await resolveWebhookHandler(entry, this.app.container);
      }
    }
    for (const entry of discovered) {
      handlers[entry.type] = await resolveWebhookHandler(entry.entry, this.app.container);
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
      await this.#resolveDurableEngine();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The app's durable engine, from the container.
   *
   * Deliberately the app's own instance and never a fresh one: the engine is bound to the
   * store and transport the app configured, and a second engine would persist runs that
   * nothing picks up.
   */
  async #resolveDurableEngine(): Promise<DurableEngineLike> {
    const { WorkflowEngine } = await import('@adonis-agora/durable');
    return (await this.app.container.make(WorkflowEngine)) as unknown as DurableEngineLike;
  }

  /** Map `billing.durable` (`'auto' | boolean`) onto the dispatcher's mode. */

  #registerWebhookRoute(router: HttpRouterService) {
    router
      .post('/payments/webhook/:provider', async (ctx: HttpContext) => {
        const manager = await this.app.container.make(PaymentsManager);
        return handleWebhookDelivery(ctx, {
          manager,
          dispatcher: this.#webhook,
          ...(this.#store !== undefined ? { store: this.#store } : {}),
        });
      })
      .as('payments.webhook');
  }
}

/**
 * One webhook delivery, from raw body to HTTP status — the body of the mounted
 * `POST /payments/webhook/:provider` route.
 *
 * Exported so the delivery can be tested for what it actually promises the gateway (the
 * status code IS the retry instruction) without standing up an application, a router and a
 * container around it.
 */
export async function handleWebhookDelivery(
  ctx: HttpContext,
  deps: {
    manager: PaymentsManager;
    dispatcher?: WebhookDispatcher | undefined;
    /** Where a REFUSED delivery is recorded. Absent when the billing layer is off. */
    store?: Pick<BillingStore, 'recordAuditEvent'> | undefined;
  },
): Promise<unknown> {
  const provider = String(ctx.params.provider);
  // ONE trace per delivery ATTEMPT, shared by every event the delivery carries — not one
  // trace per event.
  //
  // The trace answers "what happened to this HTTP request", and the facts it correlates are
  // request-scoped: the body that arrived, the signature check over it, the response the
  // gateway got. Minting a trace per event would leave the single `webhook.verification`
  // report attached to one arbitrary event and orphan the rest, and it would erase the one
  // thing a batch makes worth knowing — that these four events arrived together, so a
  // failure that hit all four is one delivery's problem and not four payments' problem.
  //
  // Per-event identity is not lost by sharing: `webhook.received`/`processed`/`failed` each
  // carry the event's own `id` and `type`, and the processor publishes them once per event.
  // So a delivery of four events is four lifecycle triples under one traceId, which is
  // exactly what happened — never one event's worth of noise.
  //
  // (A redelivery gets its own id, which is what you want when the question is "why did the
  // retry behave differently".)
  const frame: PaymentsTraceFrame = { traceId: newPaymentsTraceId(), provider };
  return runWithPaymentsTrace(frame, async () => {
    const startedAt = Date.now();
    // The catch below also sees failures from parsing, which happen before the delivery was
    // authenticated — one delivery must not report two outcomes.
    let verificationPublished = false;
    try {
      const driver = deps.manager.driver(provider);
      const rawBody = ctx.request.raw() ?? '';
      // Awaited: `parseWebhook` may be async. A gateway whose callback carries only an
      // id (Mollie) has to fetch the payment to know what happened, and that fetch is
      // also the only thing authenticating the call.
      //
      // May be ONE event or SEVERAL: Adyen's `notificationItems` and Efí's `pix` are both
      // lists. `dispatchAll` takes either, so no driver is forced to wrap its single event
      // in an array.
      const parsed = await driver.parseWebhook(rawBody, ctx.request.headers());
      // Reported by the shared `webhook_security` helpers during parseWebhook. No
      // report means nothing verified through them: the driver used its own SDK, or
      // it has no webhook credential configured and skipped the check entirely.
      publishWebhookVerification({
        provider,
        ...webhookVerificationOutcome(frame),
        durationMs: Date.now() - startedAt,
      });
      verificationPublished = true;
      if (deps.dispatcher) {
        const result = await deps.dispatcher.dispatchAll(parsed);
        if (result.failures.length > 0) {
          // A 2xx tells the gateway "done, never send this again". Answering it over an
          // event that failed is how a payment is lost for good — Adyen queues a failed
          // delivery for up to 30 days of retries and Efí makes 9 attempts, and both of
          // those only ever start if the response is not a 2xx. So a delivery with ANY
          // failed event is a failed delivery.
          //
          // The events that DID succeed are not re-run by that redelivery: their ledger
          // rows are `processed`, so the claim answers `null` and they skip. The gateway
          // resending all four costs one redelivery and re-runs exactly the one that failed.
          const failed = result.failures.map((failure) => failure.event.id);
          return ctx.response.status(500).json({
            received: true,
            // What the delivery actually did, rather than a bare error — an operator reading
            // the gateway's failed-delivery log needs to know the other three landed.
            processed: result.dispatched,
            failed,
            error: result.failures[0]?.error.message ?? 'webhook processing failed',
          });
        }
      }
      return ctx.response.status(200).json({ received: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid webhook';
      // A throw out of `parseWebhook` is a REJECTED delivery — a bad signature, an
      // unparsable body, an unknown provider — and the reason is the single most-wanted
      // fact when a gateway reports failing callbacks. It stays a 400: unlike a processing
      // failure, redelivering it would fail identically, and a forged batch must not be
      // answered with an invitation to send it again.
      if (!verificationPublished) {
        publishWebhookVerification({
          provider,
          ...webhookVerificationOutcome(frame, message),
          durationMs: Date.now() - startedAt,
        });
      }
      // A rejected delivery is the ONLY webhook outcome that leaves no ledger row — it is
      // refused before an event exists to record. That is why a rotated webhook token looks
      // exactly like a quiet gateway from the inside: zero events, zero failures, every
      // health check green. The audit row is what the `rejected_deliveries` check counts.
      //
      // Best-effort on purpose: the delivery is already being refused, and failing to file
      // the note must not change the status the gateway sees. The store itself returns
      // `null` when the install predates the table.
      await deps.store
        ?.recordAuditEvent({
          action: AUDIT_ACTIONS.webhookRejected,
          provider,
          message,
        })
        .catch(() => {});
      return ctx.response.status(400).json({ error: message });
    }
  });
}
