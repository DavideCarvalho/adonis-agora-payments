import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService, HttpRouterService } from '@adonisjs/core/types';
import { CARD_SCRIPT } from '../src/account_console/card_script.js';
import {
  ACCOUNT_EXTENSIONS_BINDING,
  type AccountExtensionRegistry,
} from '../src/account_console/contract.js';
import { accountPath, paymentsAccountExtension } from '../src/account_console/extension.js';
import { handleCardTokenize } from '../src/account_console/tokenize_endpoint.js';
import { resolvePaymentsTenancy } from '../src/agora/tenancy.js';
import type { BillingStore } from '../src/billing/billing_store.js';
import { AUDIT_ACTIONS } from '../src/billing/billing_store.js';
import { LucidBillingStore } from '../src/billing/lucid_billing_store.js';
import {
  assertRoleIsDispatchable,
  resolveDispatchMode,
  resolveRole,
} from '../src/billing/resolve_dispatch.js';
import { isInjectableAsLucid, resolveBillingStore } from '../src/billing/resolve_store.js';
import type { DurableEngineLike } from '../src/billing/webhook_dispatcher.js';
import { WebhookDispatcher } from '../src/billing/webhook_dispatcher.js';
import type { WebhookHandler } from '../src/billing/webhook_processor.js';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import {
  consoleCapabilities,
  createConsoleActions,
  resolveAppWebhookHandlers,
} from '../src/dashboard/api_core.js';
import type { BillingHandlers, PaymentsConfig } from '../src/define_config.js';
import {
  newPaymentsTraceId,
  type PaymentsTraceFrame,
  publishWebhookVerification,
  runWithPaymentsTrace,
  webhookVerificationOutcome,
} from '../src/diagnostics.js';
import { registerDoctorChecks } from '../src/doctor/agora_doctor.js';
import { paymentsDoctorChecks } from '../src/doctor/checks.js';
import type { PaymentsDriver } from '../src/driver.js';
import {
  answeringAuthError,
  CONSOLE_KEY_PURPOSE,
  detectAuthkitClient,
  detectCryptoRuntime,
  publishesAppKey,
  resolveAnsweringAuth,
} from '../src/federation/auto_auth.js';
import {
  answerPaymentsConsoleCommands,
  appKeyOf,
  consoleCommandKeys,
  resolveConsoleCommands,
  validateConsoleCommands,
} from '../src/federation/console.js';
import { idempotencyClientOf, redisIdempotencyStore } from '../src/federation/idempotency.js';
import {
  ConsoleCommandRefused,
  type RedisConsoleChannel,
  resolveRedisConnection,
} from '../src/federation/redis_channel.js';
import { InvoiceManager, resolveInvoiceProviders } from '../src/invoice/invoice_manager.js';
import { PaymentsManager, resolveDrivers } from '../src/payments_manager.js';
import {
  getBillingStore,
  setBillingStore,
  setPayments,
  setWebhookDispatcher,
} from '../src/services/main.js';
import { resolvePaymentsTenant } from '../src/topology/authkit_tenant.js';
import { GATEWAY_IDEMPOTENCY, type PaymentsControlPlane } from '../src/topology/control_plane.js';
import { HUB_MESSAGE_VERSION } from '../src/topology/protocol.js';
import {
  buildControlPlane,
  buildTenantRuntime,
  controlPlanePath,
  resolveTopology,
  type TenantRuntime,
} from '../src/topology/runtime.js';
import {
  createPaymentsHubApi,
  describeRemoteDrivers,
  HubEventPump,
  type PaymentsHubApi,
} from '../src/topology/tenant.js';
import { serveRedisHub } from '../src/topology/transports.js';
import type { WebhookEvent } from '../src/types.js';
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
  #secret: string | undefined;
  /** `topology: 'tenant'`: the client and remote drivers. */
  #tenant: TenantRuntime | undefined;
  #pump: HubEventPump | undefined;
  #hubApi: PaymentsHubApi | undefined;
  #describeTimer: NodeJS.Timeout | undefined;
  /** `topology: 'control-plane'`. */
  #controlPlane: PaymentsControlPlane | undefined;
  /** See {@link PaymentsProvider.#resolvedConfig}. */
  #resolvedConfigPromise: Promise<PaymentsConfig> | undefined;
  #redisServer: { stop(): Promise<void>; notify(partition: string): Promise<void> } | undefined;
  /** `consoleCommands`: the channel this app answers another app's payments console on. */
  #consoleChannel: RedisConsoleChannel | undefined;
  /** `consoleCommands` resolved at boot (with its authentication), started in `ready()`. */
  #consoleCommands:
    | {
        option: NonNullable<ReturnType<typeof resolveConsoleCommands>>;
        auth: ReturnType<typeof resolveAnsweringAuth>;
      }
    | undefined;

  constructor(protected app: ApplicationService) {}

  register() {
    const config = this.app.config.get<PaymentsConfig>('payments', {});
    // A typo in an action name (or `consoleCommands` on a tenant) fails the boot, not a refund.
    validateConsoleCommands(config.consoleCommands, config.topology);

    /*
     * String alias for the manager, so `services/payments` can resolve it the way every
     * first-party AdonisJS service module does (`'lucid.db'`, `'drive.manager'`,
     * `'mail.manager'`). Without it the container binding is decorative: application code
     * reaches the manager through a module-level getter, and nothing can be substituted
     * through the container.
     */
    this.app.container.alias('payments.manager', PaymentsManager);

    this.app.container.singleton(PaymentsManager, async () => {
      // A tenant's url/token/partition: what config/payments.ts sets, else authkit-client's.
      const config = await this.#resolvedConfig();
      // Build invoice providers first so drivers can resolve them from their ctx (a
      // charge with `invoice: true|'name'` emits through the invoice provider).
      let invoices: InvoiceManager | undefined;
      if (config.invoice) {
        const providers = await resolveInvoiceProviders(config.invoice);
        invoices = new InvoiceManager(providers);
      }
      const topology = resolveTopology(config);
      if (topology === 'tenant') {
        this.#tenant ??= buildTenantRuntime(config);
        this.#hubApi ??= createPaymentsHubApi(
          this.#tenant.client,
          () => this.#pump ?? this.#manualPump(config),
        );
      }
      const drivers =
        topology === 'tenant'
          ? new Map<string, PaymentsDriver>(this.#tenant?.drivers ?? new Map())
          : await resolveDrivers(config, invoices);
      const manager = new PaymentsManager({
        drivers,
        ...(invoices !== undefined ? { invoices } : {}),
        ...(config.methods !== undefined ? { methods: config.methods } : {}),
        ...(config.default !== undefined ? { defaultName: config.default } : {}),
        ...(config.subscriptions !== undefined ? { subscriptions: config.subscriptions } : {}),
        ...(config.tenancy !== undefined ? { tenancy: config.tenancy } : {}),
        ...(config.userOwnerType !== undefined ? { userOwnerType: config.userOwnerType } : {}),
        // Lazy on purpose: this runs before the billing layer is built in `boot()`, so
        // resolving the store here would either fail or force billing on apps that route
        // every subscription to the gateway and never need it.
        store: () => getBillingStore(),
        hub: () => this.#hubApi,
      });
      // Hand the manager to the lazy `services/main` singleton so `getPayments()` works.
      setPayments(manager);
      return manager;
    });
  }

  /** Kept so `shutdown()` can release the channel claims it took. */
  #telescopeWatcher: { dispose(): void } | undefined;

  async boot() {
    // `node ace agora:doctor` reads these after boot.
    await registerDoctorChecks(
      this.app.container,
      paymentsDoctorChecks({ store: () => this.#store }),
    ).catch(() => undefined);

    // The billing pages in the authkit account console, when authkit's registry is in the app. No
    // import of authkit: a binding name and an object literal.
    await this.#registerAccountPages();

    await this.app.booted(async () => {
      const raw = this.app.config.get<PaymentsConfig>('payments', {});
      let config: PaymentsConfig;
      try {
        config = await this.#resolvedConfig();
      } catch (error) {
        // A tenant whose url/token/partition resolve from neither config/payments.ts nor
        // authkit-client fails the boot of a process that serves (web, or the billing worker),
        // naming both fixes. An ace command logs it and goes on; using payments there throws it.
        if (this.#serves(raw)) throw error;
        void this.#warn((error as Error).message);
        return;
      }
      // Build the billing layer here (async — resolves the app emitter + handler
      // factories), so the mounted route can emit `billing:*` and run app handlers.
      if (config.billing?.enabled !== false) {
        await this.#buildBillingLayer(config);
        // The api half only enqueues, and has no handlers to run an event with.
        if (resolveRole(config) !== 'api') await this.#webhook?.prepare();
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
      const topology = resolveTopology(config);
      if (resolveRole(config) !== 'worker') {
        const router = await this.app.container.make('router');
        // A tenant has no gateway credentials: its webhooks go to the control plane.
        if (topology !== 'tenant') this.#registerWebhookRoute(router);
        this.#registerAccountRoutes(router, config);
        if (topology === 'control-plane') this.#registerControlPlaneRoute(router, config);
      }
      if (topology === 'control-plane') await this.#startControlPlane(config);
      if (topology === 'tenant') await this.#startTenant(config);
      // Before the HTTP server listens: an app that cannot authenticate the console fails here.
      await this.#resolveConsoleCommands();
    });
  }

  /**
   * `config/payments.ts`, with a tenant's missing `url`/`token`/`partition` filled in from
   * `@adonis-agora/authkit-client` (`tenantOf`, detected by shape). Resolved once; throws, naming
   * both fixes, when a field resolves from neither.
   */
  #resolvedConfig(): Promise<PaymentsConfig> {
    this.#resolvedConfigPromise ??= resolvePaymentsTenant(
      this.app.config.get<PaymentsConfig>('payments', {}),
      this.app.container as never,
    ).then((resolved) => resolved.config);
    return this.#resolvedConfigPromise;
  }

  /** The control plane, built once (the webhook processor forwards through it). */
  #controlPlaneFor(config: PaymentsConfig): PaymentsControlPlane {
    this.#controlPlane ??= buildControlPlane(config, {
      manager: () => this.app.container.make(PaymentsManager),
      store: () => this.#store,
      notify: async (partition) => {
        await this.#redisServer?.notify(partition);
      },
      logger: { warn: (message) => void this.#warn(message) },
    });
    return this.#controlPlane;
  }

  async #warn(message: string): Promise<void> {
    try {
      const logger = await this.app.container.make('logger');
      logger.warn(message);
    } catch {
      /* logging never breaks payments */
    }
  }

  /** `POST <controlPlane.path>/rpc`: the HTTP side of the tenant calls. */
  #registerControlPlaneRoute(router: HttpRouterService, config: PaymentsConfig): void {
    const path = controlPlanePath(config);
    router
      .post(`${path}/rpc`, async (ctx: HttpContext) => {
        ctx.response.header('cache-control', 'no-store');
        const reply = await this.#controlPlaneFor(config).handle(ctx.request.body());
        const status = reply.ok
          ? 200
          : reply.error?.code === 'unauthorized'
            ? 401
            : reply.error?.code === 'forbidden'
              ? 403
              : reply.error?.code === 'bad_request'
                ? 400
                : reply.error?.code === 'not_found'
                  ? 404
                  : reply.error?.code === 'conflict' || reply.error?.code === 'indeterminate'
                    ? 409
                    : reply.error?.code === 'gateway'
                      ? 502
                      : 503;
        return ctx.response.status(status).json(reply);
      })
      .as('payments.control_plane.rpc');
    router
      .get(`${path}/health`, async (ctx: HttpContext) =>
        ctx.response.json({ v: HUB_MESSAGE_VERSION, ok: true }),
      )
      .as('payments.control_plane.health');
  }

  async #startControlPlane(config: PaymentsConfig): Promise<void> {
    const plane = this.#controlPlaneFor(config);
    const redis = config.controlPlane?.redis;
    if (redis && resolveRole(config) !== 'api' && !this.app.inTest && this.#serves(config)) {
      this.#redisServer = serveRedisHub((message) => plane.handle(message), {
        connection: redis.connection,
        ...(redis.writer !== undefined ? { writer: redis.writer } : {}),
        ...(redis.prefix !== undefined ? { prefix: redis.prefix } : {}),
        ...(redis.blockSeconds !== undefined ? { blockSeconds: redis.blockSeconds } : {}),
        logger: { warn: (message) => void this.#warn(message) },
      });
    }
  }

  /** Whether this process serves: the web server, or a process explicitly in the worker role. */
  #serves(config: PaymentsConfig): boolean {
    const environment = (this.app as { getEnvironment?: () => string }).getEnvironment?.();
    return environment === 'web' || resolveRole(config) === 'worker';
  }

  /** A pump that is never started, for `hub().drain()` where the loop does not run. */
  #manualPump(config: PaymentsConfig): HubEventPump | undefined {
    const runtime = this.#tenant;
    const dispatcher = this.#webhook;
    if (!runtime || !dispatcher) return undefined;
    return this.#makePump(runtime, dispatcher, config);
  }

  #makePump(
    runtime: TenantRuntime,
    dispatcher: WebhookDispatcher,
    config: PaymentsConfig,
  ): HubEventPump {
    const events = config.tenant?.events;
    return new HubEventPump({
      client: runtime.client,
      transport: runtime.transport,
      partition: config.tenant?.partition ?? '',
      deliver: async (event) => {
        const result = await dispatcher.dispatchAll(event);
        const failure = result.failures[0];
        if (failure) throw failure.error;
      },
      ...(events && events.batch !== undefined ? { batch: events.batch } : {}),
      ...(events && events.idleSeconds !== undefined ? { idleSeconds: events.idleSeconds } : {}),
      logger: { warn: (message) => void this.#warn(message) },
    });
  }

  async #startTenant(config: PaymentsConfig): Promise<void> {
    const runtime = this.#tenant;
    if (!runtime) return;
    // What the control plane's providers are (capabilities, methods). Down at boot: the
    // declarations stand in, and it is asked again every minute until it answers.
    let warned = false;
    const describe = async (): Promise<void> => {
      if (await describeRemoteDrivers(runtime.client, runtime.drivers.values())) return;
      if (!warned) {
        warned = true;
        void this.#warn(
          '[payments] the payments control plane did not answer `describe` at boot; using tenant.providers until it does.',
        );
      }
      this.#describeTimer = setTimeout(() => void describe(), 60_000);
      this.#describeTimer.unref?.();
    };
    void describe();
    const events = config.tenant?.events;
    // §12: the long-lived pull loop runs only in a process that serves (web, or a billing worker),
    // never in a plain ace/repl process, which must be able to exit.
    if (events === false || resolveRole(config) === 'api' || this.app.inTest) return;
    if (!this.#serves(config)) return;
    const dispatcher = this.#webhook;
    if (!dispatcher) {
      void this.#warn(
        '[payments] topology tenant with billing disabled: the control plane forwards events nobody here processes.',
      );
      return;
    }
    this.#pump = this.#makePump(runtime, dispatcher, config);
    this.#pump.start();
  }

  /** The HMAC secret of the card form's tickets: the app key, else a process key. */
  #accountSecret(): string {
    if (this.#secret !== undefined) return this.#secret;
    const key = this.app.config.get<unknown>('app.appKey', undefined);
    const released =
      typeof key === 'string'
        ? key
        : typeof (key as { release?: unknown } | undefined)?.release === 'function'
          ? String((key as { release(): unknown }).release())
          : '';
    this.#secret = released !== '' ? released : randomBytes(32).toString('hex');
    return this.#secret;
  }

  /** Whether authkit's account console registry is bound (read structurally). */
  #hasAccountRegistry(): boolean {
    const container = this.app.container as unknown as { hasBinding?: (key: string) => boolean };
    return (
      typeof container.hasBinding === 'function' && container.hasBinding(ACCOUNT_EXTENSIONS_BINDING)
    );
  }

  async #registerAccountPages(): Promise<void> {
    const config = this.app.config.get<PaymentsConfig>('payments', {});
    if (config.accountConsole === false) return;
    const container = this.app.container as unknown as {
      hasBinding(key: string): boolean;
      make(key: string): Promise<unknown>;
    };
    try {
      if (typeof container.hasBinding !== 'function') return;
      if (!container.hasBinding(ACCOUNT_EXTENSIONS_BINDING)) return;
      const registry = (await container.make(ACCOUNT_EXTENSIONS_BINDING)) as
        | Partial<AccountExtensionRegistry>
        | undefined;
      if (typeof registry?.register !== 'function' || (registry.contract ?? 0) < 1) return;
      registry.register(
        paymentsAccountExtension({
          manager: () => this.app.container.make(PaymentsManager),
          store: () => this.#store,
          options: config.accountConsole ?? {},
          ...(config.userOwnerType !== undefined ? { userOwnerType: config.userOwnerType } : {}),
          secret: this.#accountSecret(),
        }),
      );
    } catch (error) {
      try {
        const logger = await this.app.container.make('logger');
        logger.warn(
          `[@adonis-agora/payments] could not add the account console pages: ${error instanceof Error ? error.message : String(error)}`,
        );
      } catch {
        /* logging must never break boot */
      }
    }
  }

  /**
   * The account console card form's script and its tokenize endpoint, under
   * `accountConsole.path` (default `/payments/account`). With `publicUrl` (pages shown by an IdP
   * in another app) both answer CORS.
   */
  #registerAccountRoutes(router: HttpRouterService, config: PaymentsConfig): void {
    if (config.accountConsole === false || !this.#hasAccountRegistry()) return;
    const options = config.accountConsole ?? {};
    const base = accountPath(options);
    const remote = options.publicUrl !== undefined;
    const cors = (ctx: HttpContext) => {
      if (!remote) return;
      ctx.response.header('access-control-allow-origin', '*');
      ctx.response.header('access-control-allow-methods', 'POST, OPTIONS');
      ctx.response.header('access-control-allow-headers', 'content-type, x-payments-card-ticket');
    };
    router
      .get(`${base}/card.js`, async (ctx: HttpContext) => {
        if (remote) ctx.response.header('access-control-allow-origin', '*');
        return ctx.response
          .header('content-type', 'text/javascript; charset=utf-8')
          .header('cache-control', 'public, max-age=300')
          .send(CARD_SCRIPT);
      })
      .as('payments.account.card_script');
    if (remote) {
      router
        .route(`${base}/card/tokenize`, ['OPTIONS'], async (ctx: HttpContext) => {
          cors(ctx);
          return ctx.response.status(204).send('');
        })
        .as('payments.account.card_tokenize.preflight');
    }
    router
      .post(`${base}/card/tokenize`, async (ctx: HttpContext) => {
        cors(ctx);
        ctx.response.header('cache-control', 'no-store');
        const manager = await this.app.container.make(PaymentsManager);
        const result = await handleCardTokenize(
          {
            header: (name) => ctx.request.header(name),
            body: ctx.request.body(),
            ip: ctx.request.ip(),
          },
          {
            driver: async (provider) =>
              manager.drivers.get(provider) ??
              [...manager.drivers.values()].find((d) => d.provider === provider),
            secret: this.#accountSecret(),
          },
        );
        return ctx.response.status(result.status).json(result.body);
      })
      .as('payments.account.card_tokenize');
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
    await this.#answerConsoleCommands();
  }

  /**
   * `consoleCommands`: answer another app's federated payments console over Redis. Web processes
   * only (a short-lived `ace` command that won a command's claim could exit before it answers).
   *
   * Authentication is resolved first, and its absence fails the boot: `consoleCommands`' own
   * `secret` / `crypto` / `verifyTenant`, else `@adonis-agora/crypto` booted in this app (commands
   * sealed with its `console-payments` key), authkit's verifier of calls between apps, and on a
   * control plane its own `verifyTenant`. A Redis that cannot be reached, or cannot claim a command,
   * is logged, not fatal.
   */
  async #resolveConsoleCommands(): Promise<void> {
    const config = await this.#resolvedConfig();
    if (!config.consoleCommands || resolveTopology(config) === 'tenant') return;
    if (this.app.getEnvironment() !== 'web' || resolveRole(config) === 'worker') return;
    const logger = await this.app.container.make('logger');
    const option = resolveConsoleCommands(config.consoleCommands, this.#packageName());
    if (!option) return;
    const container = this.app.container as unknown as {
      hasBinding(binding: string): boolean;
      make(binding: string): Promise<unknown>;
    };
    const appKey = await appKeyOf(this.app);
    const authkit = await detectAuthkitClient(container);
    const auth = resolveAnsweringAuth({
      option,
      crypto: await detectCryptoRuntime(container),
      authkit,
      controlPlaneVerifyTenant:
        resolveTopology(config) === 'control-plane' ? config.controlPlane?.verifyTenant : undefined,
      keys: () =>
        appKey !== undefined && appKey.length >= 16
          ? consoleCommandKeys(appKey, option.prefix)
          : undefined,
      logKey: (note) => logger[note.level](note.line),
    });
    // Redis is not a trust boundary: an app that cannot tell the real console from anyone who can
    // publish there does not start.
    if (auth.modes.length === 0) throw answeringAuthError(auth.notes);
    const actions =
      option.actions.size > 0
        ? 'actions on'
        : 'actions off (set consoleCommands.actions to let the console act)';
    logger.info(`[@adonis-agora/payments] console commands: ${auth.modes.join(' + ')}; ${actions}`);
    // §2e.B / §13a: the app publishes its command key only when token mode is how it is reached
    // (no crypto): a published key is what tells the console to use a token. With crypto, crypto
    // is enough: nothing is published and nothing is logged (§13e).
    if (auth.keys && publishesAppKey(auth)) {
      if (typeof authkit?.publishAppKey === 'function') {
        // Only the public half; the call never rejects and retries in the background.
        const { d: _private, ...jwk } = auth.keys.publicKey;
        try {
          void authkit.publishAppKey({ purpose: CONSOLE_KEY_PURPOSE, jwk }).catch(() => undefined);
        } catch {
          /* never fails the boot */
        }
      } else if (authkit !== undefined) {
        logger.warn(
          "[@adonis-agora/payments] console commands: this app is reached by token only, but authkit-client cannot publish its key (configure authkit-client's `service`), so the console needs `controlPlane.publicKey` (`node ace payments:console-key`)",
        );
      }
    }
    if (auth.ensureKey) {
      try {
        const done = await auth.ensureKey();
        if (done) logger.info(`[@adonis-agora/payments] console commands: ${done}`);
      } catch (error) {
        // Never fails the boot: one actionable line, and the first command tries again.
        logger.warn(
          `[@adonis-agora/payments] console commands: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // A crypto tenant's key: checked once (never fails the boot; one line when it needs action).
    await auth.checkKey?.();
    this.#consoleCommands = { option, auth };
  }

  async #answerConsoleCommands(): Promise<void> {
    const resolved = this.#consoleCommands;
    if (!resolved) return;
    const config = this.app.config.get<PaymentsConfig>('payments', {});
    const logger = await this.app.container.make('logger');
    const { option, auth } = resolved;
    const keys = auth.keys;
    try {
      const client = await resolveRedisConnection(this.app.container, option.connection);
      let idempotency = option.idempotency;
      if (!idempotency) {
        const kv = idempotencyClientOf(client);
        if (!kv) throw new Error('its Redis connection cannot GET/SET idempotency records');
        idempotency = redisIdempotencyStore(kv, option.prefix);
      }
      const dashboard = this.app.config.get<{ currency?: string } | undefined>(
        'payments_dashboard',
        undefined,
      );
      let handlers: Promise<Record<string, WebhookHandler> | undefined> | undefined;
      this.#consoleChannel = await answerPaymentsConsoleCommands({
        client,
        prefix: option.prefix,
        partition: option.partition,
        actions: option.actions,
        idempotency,
        ...(auth.secret !== undefined ? { secret: auth.secret } : {}),
        ...(auth.crypto !== undefined ? { crypto: auth.crypto } : {}),
        ...(auth.verifyTenant !== undefined ? { verifyTenant: auth.verifyTenant } : {}),
        ...(auth.cryptoTokenOptional ? { cryptoTokenOptional: true } : {}),
        ...(keys ? { keys } : {}),
        runtime: {
          currency: typeof dashboard?.currency === 'string' ? dashboard.currency : 'BRL',
          store: () => getBillingStore(),
          capabilities: async () =>
            consoleCapabilities((await this.app.container.make(PaymentsManager)).drivers),
          actions: async (store) => {
            const manager = await this.app.container.make(PaymentsManager);
            handlers ??= resolveAppWebhookHandlers(this.app, config.billing?.handlers).catch(
              (error: unknown) => {
                handlers = undefined;
                throw error;
              },
            );
            return createConsoleActions({
              manager,
              store,
              handlers: await handlers,
              tenancy: () => resolvePaymentsTenancy(config.tenancy),
              // The console's idempotency key reaches the gateway only where it deduplicates on it.
              gatewayIdempotency: (provider) =>
                GATEWAY_IDEMPOTENCY[provider]?.honours.includes('refund') === true,
            });
          },
        },
        log: (line) => logger.info(line),
        // A rejected or garbage message is dropped and logged once per reason: anyone who can
        // publish on Redis must not be able to flood the log, nor crash the process.
        onError: oncePerReason((error: unknown) =>
          logger.warn(
            error instanceof ConsoleCommandRefused
              ? `[@adonis-agora/payments] console commands: refused a command (${error.reason})`
              : `[@adonis-agora/payments] console commands: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
      });
    } catch (error) {
      logger.warn(
        `[@adonis-agora/payments] consoleCommands is on, but ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The app's package.json name without its scope (`@acme/shop` → `shop`): the default prefix. */
  #packageName(): string {
    try {
      const pkg = JSON.parse(readFileSync(this.app.makePath('package.json'), 'utf8')) as {
        name?: unknown;
      };
      if (typeof pkg.name === 'string' && pkg.name !== '') return pkg.name.replace(/^@[^/]+\//, '');
    } catch {
      // No package.json: the caller's `prefix` is then required.
    }
    return '';
  }

  /** Release the watcher's channel claims and subscriptions on shutdown. */
  async shutdown(): Promise<void> {
    await this.#consoleChannel?.close();
    this.#consoleChannel = undefined;
    if (this.#describeTimer) clearTimeout(this.#describeTimer);
    await this.#pump?.stop();
    this.#pump = undefined;
    await this.#redisServer?.stop();
    this.#redisServer = undefined;
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
      tenancy: () => resolvePaymentsTenancy(config.tenancy),
      // The control plane hands each processed event to the app that owns its payment.
      ...(resolveTopology(config) === 'control-plane'
        ? { afterProcess: (event: WebhookEvent) => this.#controlPlaneFor(config).forward(event) }
        : {}),
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
   * Bound in the container under `'payments.billingStore'`, whatever the implementation.
   *
   * `BillingStore` is an INTERFACE, so there is no class to use as a DI token — which is
   * why a custom store used to be reachable only through the module-level accessor on
   * `services/main`. A string binding is how AdonisJS itself solves this (`'lucid.db'`
   * aliases the `Database` singleton), and it buys the two things the accessor could not:
   * `@inject()` on the token, and `container.swap()` in tests instead of a bespoke setter.
   *
   * The Lucid class binding stays alongside it, so `@inject() constructor(store:
   * LucidBillingStore)` keeps working for the default case.
   */
  async #resolveBillingStore(config: PaymentsConfig): Promise<BillingStore> {
    const store = await resolveBillingStore(config);

    setBillingStore(store);
    this.app.container.singleton('payments.billingStore', () => store);
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
 * Whether every event in this delivery is already in the ledger and not `failed` — a
 * redelivery the processor would skip anyway. Asked before `parseWebhook` only of a driver that
 * can name its events without calling the gateway (`webhookEventIds`); a `failed` or unseen
 * event, or any doubt, is `false`, and the delivery is parsed as usual.
 */
async function isKnownRedelivery(
  driver: PaymentsDriver,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  store: Partial<Pick<BillingStore, 'findWebhookEventByGatewayEventId'>> | undefined,
): Promise<boolean> {
  if (
    driver.webhookEventIds === undefined ||
    store?.findWebhookEventByGatewayEventId === undefined
  ) {
    return false;
  }
  const find = store.findWebhookEventByGatewayEventId.bind(store);
  try {
    const ids = driver.webhookEventIds(rawBody, headers);
    if (ids === undefined || ids.length === 0) return false;
    const rows = await Promise.all(ids.map((id) => find(id)));
    return rows.every((row) => row !== null && row.status !== 'failed');
  } catch {
    // A read that failed proves nothing either way; the full path reports the real error.
    return false;
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
    /**
     * Where a REFUSED delivery is recorded, and where a redelivery is recognized before the
     * driver calls its gateway. Absent when the billing layer is off.
     */
    store?:
      | (Pick<BillingStore, 'recordAuditEvent'> &
          Partial<Pick<BillingStore, 'findWebhookEventByGatewayEventId'>>)
      | undefined;
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
      if (await isKnownRedelivery(driver, rawBody, ctx.request.headers(), deps.store)) {
        publishWebhookVerification({
          provider,
          ...webhookVerificationOutcome(frame),
          durationMs: Date.now() - startedAt,
        });
        return ctx.response.status(200).json({ received: true });
      }
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

/**
 * An error reporter that logs each distinct reason once (the first 200 distinct reasons), so a
 * stream of bad messages costs one line per kind. Never throws.
 */
function oncePerReason(log: (error: unknown) => void): (error: unknown) => void {
  const seen = new Set<string>();
  return (error) => {
    try {
      const reason = error instanceof Error ? error.message : String(error);
      if (seen.has(reason) || seen.size >= 200) return;
      seen.add(reason);
      log(error);
    } catch {
      /* logging never breaks the channel */
    }
  };
}
