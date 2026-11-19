import { randomUUID } from 'node:crypto';
import type { BillingStore } from '../billing/billing_store.js';
import { CONSOLE_ROUTES, serveConsoleRoute } from '../dashboard/api_core.js';
import type { PaymentsApiRoute } from '../dashboard/dev_tools.js';
import type {
  ApiRequest,
  ApiResponse,
  DashboardActions,
  ProviderCapabilities,
} from '../dashboard/handlers.js';
import { actionFingerprint, type ConsoleIdempotencyStore, IDEMPOTENCY_KEY } from './idempotency.js';
import {
  APP_UNREACHABLE,
  ConsoleChannelError,
  type ConsoleCommand,
  RedisConsoleChannel,
  type RedisLike,
} from './redis_channel.js';
import { capabilityAllows, federatedSafe, readOnlyBillingStore } from './safety.js';

/**
 * The federated payments console: one app's payments console (the Hub's) also shows and operates
 * apps that run `@adonis-agora/payments` standalone, each with its own gateways, credentials,
 * webhooks and billing store.
 *
 * - Reads (customers, subscriptions, payments, disputes, the webhook ledger, the audit trail,
 *   the overview) come straight from the owning app's billing tables, through a store that refuses
 *   every write, and are masked before they are answered.
 * - Every action (refund, cancel/resume/re-price a subscription, retry a webhook event, resolve a
 *   dispute, submit dispute evidence) is a console command on the owning app's Redis. Exactly one
 *   instance runs it, through its own console handlers, gateway drivers, validation and audit,
 *   with the console's viewer as the actor, and only when the app allow-listed that action
 *   (`consoleCommands.actions`) AND the console's `authorize` granted the viewer its capability.
 * - Every action carries an idempotency key from the console; the owning app runs a key once and
 *   answers a retry with the first answer.
 *
 * The console never holds, reads or receives a gateway credential or webhook secret: the
 * owning app's gateways are only ever called by the owning app.
 */

// ── What may cross ──────────────────────────────────────────────────────────

/** The reads a federated app answers from its own tables (console handler names). */
export const FEDERATED_READS = [
  'overview',
  'health',
  'payments',
  'paymentDetail',
  'customers',
  'audit',
  'disputes',
  'subscriptions',
  'subscriptionDetail',
  'webhookEvents',
  'providers',
] as const;

/**
 * The actions another console may ask an app to run, each with the console route it is and the
 * capability a viewer needs for it.
 */
export const FEDERATED_ACTIONS = {
  refund: { route: 'refund', capability: 'payments:refund' },
  cancelSubscription: {
    route: 'cancelSubscription',
    capability: 'payments:subscriptions:cancel',
  },
  resumeSubscription: {
    route: 'resumeSubscription',
    capability: 'payments:subscriptions:resume',
  },
  repriceSubscription: {
    route: 'repriceSubscription',
    capability: 'payments:subscriptions:reprice',
  },
  retryWebhook: { route: 'retry', capability: 'payments:webhooks:retry' },
  resolveDispute: { route: 'resolve', capability: 'payments:disputes:resolve' },
} as const satisfies Record<string, { route: keyof typeof CONSOLE_ROUTES; capability: string }>;

/** An action a federated console may send (a key of {@link FEDERATED_ACTIONS}). */
export type FederatedPaymentsAction = keyof typeof FEDERATED_ACTIONS;

const ACTION_NAMES = Object.keys(FEDERATED_ACTIONS) as FederatedPaymentsAction[];
const READ_SET: ReadonlySet<string> = new Set(FEDERATED_READS);
const ACTION_OF_ROUTE = new Map<string, FederatedPaymentsAction>(
  ACTION_NAMES.map((action) => [FEDERATED_ACTIONS[action].route, action]),
);

/** The console route name a handler is served under, or `undefined` for one that is not. */
const ROUTE_OF_HANDLER = new Map<unknown, string>(
  Object.entries(CONSOLE_ROUTES).map(([name, route]) => [route.handler, name]),
);

/** The {@link CONSOLE_ROUTES} name of a console handler (how a federated call travels). */
export function consoleRouteName(handler: unknown): string | undefined {
  return ROUTE_OF_HANDLER.get(handler);
}

/** The action a console route is, when it is one a federated app can run. */
export function federatedActionOf(route: string): FederatedPaymentsAction | undefined {
  return ACTION_OF_ROUTE.get(route);
}

/** A command this app does not answer (unknown verb). Answered `501` by the console. */
export const UNSUPPORTED = 'unsupported-request';

/** What a federated app's key may look like (it travels in the URL as `?app=`). */
export const FEDERATED_APP_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/** The idempotency key of a request: the `Idempotency-Key` header, else `idempotencyKey` in the body. */
export function idempotencyKeyOf(header: string | undefined, body: unknown): string | undefined {
  const fromBody =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as { idempotencyKey?: unknown }).idempotencyKey
      : undefined;
  const key = typeof header === 'string' && header !== '' ? header : fromBody;
  return typeof key === 'string' && key !== '' ? key.trim() : undefined;
}

function isDryRun(body: unknown): boolean {
  return (
    !!body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    (body as { dryRun?: unknown }).dryRun === true
  );
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The request without `app` (it picked the app; it is not a filter) or `idempotencyKey`. */
function cleanRequest(req: ApiRequest): ApiRequest {
  const { app: _app, tenant: _tenant, ...query } = req.query;
  const body = req.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const { app: _bodyApp, idempotencyKey: _key, ...rest } = body as Record<string, unknown>;
    return { ...req, query, body: rest };
  }
  return { ...req, query };
}

class StatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// ── The owning app's side ───────────────────────────────────────────────────

/** `consoleCommands` in config/payments.ts. */
export type ConsoleCommandsOption =
  | boolean
  | {
      /**
       * The channel prefix the console app names in `controlPlane.prefix`. Default: this app's
       * package.json name (without its scope).
       */
      prefix?: string | undefined;
      /** The `@adonisjs/redis` connection to listen on. Default: the default connection. */
      connection?: string | undefined;
      /**
       * The actions another console may ask this app to run. Every one is off unless listed
       * here; the console's `authorize` must also grant the viewer each one's capability.
       */
      actions?: readonly FederatedPaymentsAction[] | undefined;
      /**
       * Where the idempotency records of those actions live. Default: this app's Redis (the
       * `connection` above), kept 24 h.
       */
      idempotency?: ConsoleIdempotencyStore | undefined;
    };

/** `consoleCommands` with its defaults, or `undefined` when off. */
export interface ResolvedConsoleCommands {
  prefix: string;
  connection: string | undefined;
  actions: ReadonlySet<FederatedPaymentsAction>;
  idempotency: ConsoleIdempotencyStore | undefined;
}

/** Checks `consoleCommands` (config time): a typo in an action name fails the boot. */
export function validateConsoleCommands(option: unknown, topology: string | undefined): void {
  if (option === undefined || option === false) return;
  const fail = (message: string): never => {
    throw new Error(`[@adonis-agora/payments] consoleCommands: ${message}`);
  };
  if (topology === 'tenant') {
    fail("does not apply to a tenant: a tenant's payments are operated on its control plane");
  }
  if (option === true) return;
  if (!option || typeof option !== 'object') {
    fail('must be true or { prefix, connection, actions, idempotency }');
  }
  const value = option as Record<string, unknown>;
  if (value.prefix !== undefined && (typeof value.prefix !== 'string' || !value.prefix.trim())) {
    fail('`prefix` must be a non-empty string');
  }
  if (
    value.connection !== undefined &&
    (typeof value.connection !== 'string' || value.connection === '')
  ) {
    fail('`connection` must be a connection name of config/redis.ts');
  }
  if (value.actions !== undefined) {
    if (!Array.isArray(value.actions)) fail('`actions` must be a list of action names');
    for (const action of value.actions as unknown[]) {
      if (typeof action !== 'string' || !(action in FEDERATED_ACTIONS)) {
        fail(`unknown action ${JSON.stringify(action)} (one of: ${ACTION_NAMES.join(', ')})`);
      }
    }
  }
  const store = value.idempotency as Partial<ConsoleIdempotencyStore> | undefined;
  if (
    store !== undefined &&
    (typeof store?.begin !== 'function' || typeof store.finish !== 'function')
  ) {
    fail('`idempotency` must be a store with begin() and finish()');
  }
}

/** `consoleCommands` with its defaults (`prefix` falls back to `fallbackPrefix`). */
export function resolveConsoleCommands(
  option: ConsoleCommandsOption | undefined,
  fallbackPrefix: string,
): ResolvedConsoleCommands | undefined {
  if (!option) return undefined;
  const value = option === true ? {} : option;
  const prefix = value.prefix ?? fallbackPrefix;
  if (typeof prefix !== 'string' || prefix.trim() === '') {
    throw new Error('[@adonis-agora/payments] consoleCommands.prefix must not be empty');
  }
  return {
    prefix,
    connection: value.connection,
    actions: new Set(value.actions ?? []),
    idempotency: value.idempotency,
  };
}

/** What the owning app answers another console with: its store, actions and gateways. */
export interface OwningAppRuntime {
  /** This app's billing store (unscoped). */
  store(): BillingStore;
  /** The console's write ports over `store`. */
  actions(store: BillingStore): Promise<Partial<DashboardActions>>;
  /** What each configured gateway can do (booleans only, never its configuration). */
  capabilities(): Promise<Record<string, ProviderCapabilities> | undefined>;
  /** The currency the console formats money in. */
  currency: string;
}

/** What the owning app tells another console about itself (`profile`). Plain JSON, no secrets. */
export interface PaymentsConsoleProfile {
  /** Per gateway: whether it refunds, takes disputes, cancels and re-prices subscriptions. */
  capabilities: Record<string, ProviderCapabilities> | null;
  /** The actions this app runs for another console. */
  actions: FederatedPaymentsAction[];
}

/** The acting person a command carries, as the owning app's audit trail records them. */
function actorOf(command: ConsoleCommand): string {
  const clean = (value: string) =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    value.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 200);
  const who =
    typeof command.actor === 'string' && command.actor !== '' ? clean(command.actor) : 'anonymous';
  const via =
    typeof command.via === 'string' && command.via !== ''
      ? clean(command.via)
      : 'federated console';
  return `${who} (via ${via})`;
}

/**
 * Answers the commands another app's federated payments console sends this app: `profile` (what
 * its gateways can do, which actions it runs) and each allow-listed action, run through this app's
 * own console handlers, drivers and audit trail. An action needs:
 *
 * 1. to be listed in `consoleCommands.actions`;
 * 2. the viewer's capability, as the console's `authorize` granted it and the command carries it;
 * 3. an idempotency key (except a `dryRun`): the first run's answer is replayed for the same key,
 *    a key reused for something else is refused (`422`), and one still running is `409`.
 *
 * Answers are masked ({@link federatedSafe}) before they are published.
 */
export function paymentsConsoleCommandHandler(options: {
  runtime: OwningAppRuntime;
  actions: ReadonlySet<FederatedPaymentsAction>;
  idempotency: ConsoleIdempotencyStore;
  log?: ((line: string) => void) | undefined;
}): (command: ConsoleCommand) => Promise<unknown> {
  return async (command) => {
    const { verb } = command;
    const runtime = options.runtime;
    if (verb === 'profile') {
      const profile: PaymentsConsoleProfile = {
        capabilities: (await runtime.capabilities()) ?? null,
        actions: [...options.actions],
      };
      return federatedSafe(profile);
    }
    if (!(verb in FEDERATED_ACTIONS)) {
      throw Object.assign(
        new Error(`this app does not answer the payments console command ${verb}`),
        { code: UNSUPPORTED },
      );
    }
    const action = verb as FederatedPaymentsAction;
    if (!options.actions.has(action)) {
      throw new StatusError(
        `this app does not run "${action}" for another console (consoleCommands.actions)`,
        403,
      );
    }
    const { capability, route } = FEDERATED_ACTIONS[action];
    if (!capabilityAllows(command.capabilities, capability)) {
      throw new StatusError(`the console did not grant this person "${capability}"`, 403);
    }
    const raw = plainObject(command.args[0]);
    const params: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(plainObject(raw.params))) {
      if (typeof value === 'string') params[key] = value;
    }
    const req = cleanRequest({ params, query: plainObject(raw.query), body: raw.body ?? {} });
    const dryRun = isDryRun(req.body);
    const key = typeof raw.idempotencyKey === 'string' ? raw.idempotencyKey : undefined;
    if (!dryRun && (key === undefined || !IDEMPOTENCY_KEY.test(key))) {
      throw new StatusError(
        'an idempotency key (8–200 characters of A-Z a-z 0-9 _ . : -) is required',
        400,
      );
    }
    const actor = actorOf(command);
    const run = async (): Promise<ApiResponse> => {
      const store = runtime.store();
      const result = await serveConsoleRoute({
        store,
        route: CONSOLE_ROUTES[route] as PaymentsApiRoute,
        req,
        currency: runtime.currency,
        actor,
        actions: (s) => runtime.actions(s),
        capabilities: () => runtime.capabilities(),
        ...(key !== undefined && !dryRun ? { idempotencyKey: `console-${key}` } : {}),
      });
      return { status: result.status, body: federatedSafe(result.body) };
    };
    if (dryRun || key === undefined) return run();

    const fingerprint = actionFingerprint(action, { params: req.params, body: req.body });
    const known = await options.idempotency.begin(key, fingerprint);
    if (known.state === 'done') return known.reply;
    if (known.state === 'mismatch') {
      throw new StatusError(
        'this idempotency key was already used for a different action or different arguments',
        422,
      );
    }
    if (known.state === 'running') {
      throw new StatusError(
        'this action is already running (or was interrupted) under this idempotency key; check its result before sending a new one',
        409,
      );
    }
    options.log?.(
      `[payments] federated console: ${action}${params.gatewayId ? ` ${params.gatewayId}` : params.id ? ` ${params.id}` : params.gatewayEventId ? ` ${params.gatewayEventId}` : ''} by ${actor}`,
    );
    let reply: ApiResponse;
    try {
      reply = await run();
    } catch (error) {
      // Whether the gateway was reached is unknown: the key keeps this answer, it is not re-run.
      reply = {
        status: 500,
        body: federatedSafe({
          error: error instanceof Error ? error.message : 'the action failed',
        }),
      };
    }
    await options.idempotency.finish(key, fingerprint, reply);
    return reply;
  };
}

/**
 * Start answering other consoles' commands on `client`. Returns the channel, to close at shutdown.
 */
export async function answerPaymentsConsoleCommands(options: {
  client: RedisLike;
  prefix: string;
  actions: ReadonlySet<FederatedPaymentsAction>;
  idempotency: ConsoleIdempotencyStore;
  runtime: OwningAppRuntime;
  log?: ((line: string) => void) | undefined;
  onError?: ((error: unknown) => void) | undefined;
}): Promise<RedisConsoleChannel> {
  const channel = new RedisConsoleChannel({ client: options.client, prefix: options.prefix });
  await channel.answer(
    paymentsConsoleCommandHandler({
      runtime: options.runtime,
      actions: options.actions,
      idempotency: options.idempotency,
      log: options.log,
    }),
    options.onError ? { onError: options.onError } : {},
  );
  return channel;
}

// ── The console app's side ──────────────────────────────────────────────────

/** One other app shown in this console (`config/payments_dashboard.ts` → `apps`). */
export interface FederatedPaymentsAppConfig {
  /** The name shown in the App picker. Defaults to the key. */
  label?: string | undefined;
  /**
   * Where that app keeps its billing tables: a Lucid `connection` of THIS app and the `schema` the
   * other app gives `billing.schema`. Only read, never created or altered: grant the connection's
   * role `SELECT` on them. A {@link BillingStore} instance also works (it is wrapped read-only).
   */
  store: { connection?: string | undefined; schema?: string | undefined } | BillingStore;
  /**
   * Where that app answers commands (`consoleCommands` in its config/payments.ts): the
   * `@adonisjs/redis` connection to publish on and that app's `prefix`.
   */
  controlPlane: { connection?: string | undefined; prefix: string } | RedisConsoleChannel;
  /** Whether this console may send actions to that app. Default `true`; `false` browses only. */
  actions?: boolean | undefined;
  /** How long an action waits for the app to answer, in ms. Default 15 000. */
  timeoutMs?: number | undefined;
}

function isStore(value: unknown): value is BillingStore {
  return typeof (value as BillingStore | undefined)?.listPayments === 'function';
}

/** Checks one `apps` entry at boot, so a misconfigured app fails the boot, not its first request. */
export function validateFederatedPaymentsApp(key: string, entry: FederatedPaymentsAppConfig): void {
  const fail = (message: string): never => {
    throw new Error(`[@adonis-agora/payments] payments_dashboard.apps["${key}"]: ${message}`);
  };
  if (!FEDERATED_APP_KEY.test(key)) fail('the key must be 1–64 letters, digits, "_", "-" or "."');
  if (!entry || typeof entry !== 'object') fail('must be an object');
  if (entry.label !== undefined && (typeof entry.label !== 'string' || entry.label === '')) {
    fail('`label` must be a non-empty string');
  }
  const store = entry.store;
  if (!store || typeof store !== 'object') fail('`store` is required ({ connection, schema })');
  if (!isStore(store)) {
    const { connection, schema } = store as { connection?: unknown; schema?: unknown };
    if (connection !== undefined && (typeof connection !== 'string' || connection === '')) {
      fail('`store.connection` must be a connection name of config/database.ts');
    }
    if (schema !== undefined && (typeof schema !== 'string' || schema === '')) {
      fail('`store.schema` must be a non-empty string');
    }
  }
  const plane = entry.controlPlane;
  if (!(plane instanceof RedisConsoleChannel)) {
    if (!plane || typeof plane !== 'object') {
      fail('`controlPlane` is required ({ connection, prefix })');
    }
    if (typeof plane.prefix !== 'string' || plane.prefix.trim() === '') {
      fail("`controlPlane.prefix` must be the other app's `consoleCommands.prefix` (not empty)");
    }
    if (
      plane.connection !== undefined &&
      (typeof plane.connection !== 'string' || plane.connection === '')
    ) {
      fail('`controlPlane.connection` must be a connection name of config/redis.ts');
    }
  }
  if (entry.actions !== undefined && typeof entry.actions !== 'boolean') {
    fail('`actions` must be a boolean');
  }
  if (
    entry.timeoutMs !== undefined &&
    (typeof entry.timeoutMs !== 'number' ||
      !Number.isFinite(entry.timeoutMs) ||
      entry.timeoutMs <= 0)
  ) {
    fail('`timeoutMs` must be a positive number of milliseconds');
  }
}

/** What a federated console needs from the app it runs in. */
export interface FederationContext {
  /** A billing store over `connection`/`schema` of this app's Lucid (read-only use). */
  store?(options: { connection?: string | undefined; schema?: string | undefined }): BillingStore;
  /** The Redis client for `connection` (an ioredis client or an `@adonisjs/redis` connection). */
  redis(connection?: string): Promise<RedisLike>;
}

/** One federated app as the App picker lists it. */
export interface FederatedAppInfo {
  id: string;
  label: string;
  mode: 'federated';
  /** `app`: actions are sent to the app, which runs them. `none`: this console only browses it. */
  actions: 'app' | 'none';
}

/** Who acts, and what the console granted them, as a command carries it. */
export interface FederatedCallMeta {
  actor?: string | undefined;
  /** The viewer's `capabilities`, as the console's `authorize` granted them. */
  capabilities?: readonly string[] | undefined;
  /** This console's name (`appLabel`), recorded by the owning app. */
  via?: string | undefined;
  /** The request's `Idempotency-Key`. */
  idempotencyKey?: string | undefined;
}

/** How long a profile is reused before it is asked for again. */
const PROFILE_TTL_MS = 30_000;
/** How long an action waits for its answer by default. */
const COMMAND_TIMEOUT_MS = 15_000;

class FederatedApp {
  readonly label: string;
  readonly actions: boolean;
  readonly #entry: FederatedPaymentsAppConfig;
  readonly #context: FederationContext;
  #store: Promise<BillingStore> | undefined;
  #channel: Promise<RedisConsoleChannel> | undefined;
  #profile: { at: number; profile: PaymentsConsoleProfile } | undefined;
  #asking: Promise<PaymentsConsoleProfile> | undefined;

  constructor(
    readonly key: string,
    entry: FederatedPaymentsAppConfig,
    context: FederationContext,
  ) {
    this.#entry = entry;
    this.#context = context;
    this.label = entry.label ?? key;
    this.actions = entry.actions !== false;
  }

  info(): FederatedAppInfo {
    return {
      id: this.key,
      label: this.label,
      mode: 'federated',
      actions: this.actions ? 'app' : 'none',
    };
  }

  /** The app's billing store, read-only. */
  store(): Promise<BillingStore> {
    this.#store ??= (async () => {
      const spec = this.#entry.store;
      if (isStore(spec)) return readOnlyBillingStore(spec);
      const custom = this.#context.store?.(spec);
      if (custom) return readOnlyBillingStore(custom);
      // Imported here: `@adonisjs/lucid` is an optional peer, and only this path needs it.
      const { LucidBillingStore } = await import('../billing/lucid_billing_store.js');
      return readOnlyBillingStore(
        new LucidBillingStore(
          {},
          {
            autoCreateSchema: false,
            ...(spec.connection !== undefined ? { connection: spec.connection } : {}),
            ...(spec.schema !== undefined ? { schema: spec.schema } : {}),
          },
        ),
      );
    })();
    this.#store.catch(() => {
      this.#store = undefined;
    });
    return this.#store;
  }

  channel(): Promise<RedisConsoleChannel> {
    this.#channel ??= (async () => {
      const plane = this.#entry.controlPlane;
      if (plane instanceof RedisConsoleChannel) return plane;
      return new RedisConsoleChannel({
        client: await this.#context.redis(plane.connection),
        prefix: plane.prefix,
      });
    })();
    // A connection that could not be made (a typo, Redis not installed) is retried next time.
    this.#channel.catch(() => {
      this.#channel = undefined;
    });
    return this.#channel;
  }

  /** Send a command and wait for the app's answer (throws when nobody answers or it refused). */
  async send(verb: string, args: unknown[], meta: FederatedCallMeta = {}): Promise<unknown> {
    const channel = await this.channel();
    const reply = await channel.send(
      {
        id: randomUUID(),
        verb,
        args,
        ...(meta.actor !== undefined ? { actor: meta.actor } : {}),
        ...(meta.capabilities !== undefined ? { capabilities: [...meta.capabilities] } : {}),
        ...(meta.via !== undefined ? { via: meta.via } : {}),
      },
      { timeoutMs: this.#entry.timeoutMs ?? COMMAND_TIMEOUT_MS },
    );
    if (reply.ok) return reply.data;
    throw Object.assign(new Error(reply.error.message), {
      ...(reply.error.code !== undefined ? { code: reply.error.code } : {}),
      ...(reply.error.status !== undefined ? { status: reply.error.status } : {}),
    });
  }

  /** The app's profile (what its gateways can do), reused for 30 s; `undefined` when it is down. */
  async profile(): Promise<{ profile: PaymentsConsoleProfile | undefined; reachable: boolean }> {
    const cached = this.#profile;
    if (cached && Date.now() - cached.at < PROFILE_TTL_MS) {
      return { profile: cached.profile, reachable: true };
    }
    try {
      this.#asking ??= (this.send('profile', []) as Promise<PaymentsConsoleProfile>).finally(() => {
        this.#asking = undefined;
      });
      const profile = profileOf(await this.#asking);
      this.#profile = { at: Date.now(), profile };
      return { profile, reachable: true };
    } catch {
      return { profile: cached?.profile, reachable: false };
    }
  }

  async close(): Promise<void> {
    const channel = await this.#channel?.catch(() => undefined);
    // A channel handed over in the config belongs to whoever made it.
    if (channel && !(this.#entry.controlPlane instanceof RedisConsoleChannel)) {
      await channel.close();
    }
  }
}

/** A profile as received, every field checked (booleans only for the gateways). */
function profileOf(raw: unknown): PaymentsConsoleProfile {
  const value = plainObject(raw);
  const capabilities: Record<string, ProviderCapabilities> = {};
  for (const [name, caps] of Object.entries(plainObject(value.capabilities))) {
    const c = plainObject(caps);
    capabilities[name] = {
      refunds: c.refunds === true,
      disputes: c.disputes === true,
      cancelSubscription: c.cancelSubscription === true,
      updateSubscription: c.updateSubscription === true,
    };
  }
  return {
    capabilities: value.capabilities === null ? null : capabilities,
    actions: Array.isArray(value.actions)
      ? (value.actions.filter(
          (a) => typeof a === 'string' && a in FEDERATED_ACTIONS,
        ) as FederatedPaymentsAction[])
      : [],
  };
}

/** A command's failure as the console's answer. */
function failure(error: unknown, label: string): ApiResponse {
  if (error instanceof ConsoleChannelError) {
    return {
      status: 503,
      body: { error: `${label} did not answer: ${error.message}`, code: APP_UNREACHABLE },
    };
  }
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  const message = error instanceof Error ? error.message : String(error);
  if (code === APP_UNREACHABLE) return { status: 503, body: { error: `${label}: ${message}` } };
  if (code === UNSUPPORTED) {
    return { status: 501, body: { error: `${label} does not answer this yet: ${message}` } };
  }
  if (typeof status === 'number' && status >= 400 && status < 600) {
    return { status, body: { error: message } };
  }
  return { status: 502, body: { error: `${label} failed: ${message}` } };
}

/** An answer the app sent back, checked: `{ status, body }`. */
function responseOf(data: unknown): ApiResponse {
  const value = plainObject(data);
  if (typeof value.status !== 'number' || !('body' in value)) {
    throw new Error('malformed answer');
  }
  return { status: value.status, body: value.body };
}

/**
 * The other apps of `apps` in config/payments_dashboard.ts: which ones exist, and every console
 * call for one of them, answered from its tables or sent to the app.
 */
export class FederatedPaymentsConsole {
  readonly #apps = new Map<string, FederatedApp>();

  constructor(apps: Record<string, FederatedPaymentsAppConfig>, context: FederationContext) {
    for (const [key, entry] of Object.entries(apps)) {
      validateFederatedPaymentsApp(key, entry);
      this.#apps.set(key, new FederatedApp(key, entry, context));
    }
  }

  get size(): number {
    return this.#apps.size;
  }

  has(key: string): boolean {
    return this.#apps.has(key);
  }

  /** The apps a viewer limited to `visible` (`undefined`: every app) is offered. */
  list(visible?: (key: string) => boolean): FederatedAppInfo[] {
    return [...this.#apps.values()]
      .filter((app) => visible?.(app.key) ?? true)
      .map((app) => app.info());
  }

  /** Whether the app answers its commands right now (its profile). */
  async reachable(key: string): Promise<boolean> {
    const app = this.#apps.get(key);
    return app ? (await app.profile()).reachable : false;
  }

  /**
   * Answer one console call for the app `key`, the way the console route `route` would there:
   * reads from its tables (masked), actions sent to it (with the viewer's capabilities and the
   * request's idempotency key).
   */
  async dispatch(
    key: string,
    route: string,
    request: ApiRequest,
    options: { currency: string; meta?: FederatedCallMeta },
  ): Promise<ApiResponse> {
    const app = this.#apps.get(key);
    if (!app) return { status: 404, body: { error: `unknown app "${key}"` } };
    const meta = options.meta ?? {};
    const req = cleanRequest(request);
    try {
      if (READ_SET.has(route)) {
        const result = await serveConsoleRoute({
          store: await app.store(),
          route: CONSOLE_ROUTES[route as keyof typeof CONSOLE_ROUTES] as PaymentsApiRoute,
          req,
          currency: options.currency,
          capabilities: async () => (await app.profile()).profile?.capabilities ?? undefined,
        });
        return { status: result.status, body: federatedSafe(result.body) };
      }
      const action = federatedActionOf(route);
      if (action === undefined) {
        return { status: 501, body: { error: `${route} is not available for ${app.label}` } };
      }
      if (!app.actions) {
        return {
          status: 403,
          body: { error: `${app.label} is read-only in this console: act in ${app.label}.` },
        };
      }
      const { capability } = FEDERATED_ACTIONS[action];
      if (!capabilityAllows(meta.capabilities, capability)) {
        return {
          status: 403,
          body: {
            error: `acting on ${app.label} needs "${capability}" in the capabilities this console's authorize grants`,
          },
        };
      }
      const dryRun = isDryRun(req.body);
      const idempotencyKey = meta.idempotencyKey;
      if (!dryRun && (idempotencyKey === undefined || !IDEMPOTENCY_KEY.test(idempotencyKey))) {
        return {
          status: 400,
          body: {
            error:
              'an Idempotency-Key header (8–200 characters of A-Z a-z 0-9 _ . : -) is required to act on another app',
          },
        };
      }
      const data = await app.send(
        action,
        [
          {
            params: req.params,
            query: req.query,
            body: req.body ?? {},
            ...(idempotencyKey !== undefined && !dryRun ? { idempotencyKey } : {}),
          },
        ],
        meta,
      );
      const result = responseOf(data);
      return { status: result.status, body: federatedSafe(result.body) };
    } catch (error) {
      return failure(error, app.label);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.#apps.values()].map((app) => app.close()));
  }
}
