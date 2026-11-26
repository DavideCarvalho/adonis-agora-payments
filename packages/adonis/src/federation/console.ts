import { randomUUID } from 'node:crypto';
import type { BillingStore } from '../billing/billing_store.js';
import { CONSOLE_ROUTES, serveConsoleRoute } from '../dashboard/api_core.js';
import {
  type ConsoleCapabilityTable,
  consoleCapabilityAllows,
} from '../dashboard/console_capabilities.js';
import type { PaymentsApiRoute } from '../dashboard/dev_tools.js';
import type {
  ApiRequest,
  ApiResponse,
  DashboardActions,
  ProviderCapabilities,
} from '../dashboard/handlers.js';
import type { HubTokenSource } from '../topology/tenant.js';
import type { TenantVerifierInput } from '../topology/verify.js';
import {
  APP_CALL_TOKEN_FAILURE,
  type AuthkitClientLike,
  ConsoleAuthConfigError,
  type CryptoRuntimeLike,
  resolveSendingAuth,
  type SendingAuth,
  sendingAuthError,
} from './auto_auth.js';
import { deriveX25519KeyPair, isX25519PublicJwk, type OkpJwk } from './console_key.js';
import { actionFingerprint, type ConsoleIdempotencyStore, IDEMPOTENCY_KEY } from './idempotency.js';
import {
  APP_UNREACHABLE,
  type ChannelSecret,
  ConsoleChannelError,
  type ConsoleCommand,
  type ConsoleCryptoOption,
  type ConsoleReply,
  RedisConsoleChannel,
  type RedisLike,
  UNAUTHORIZED_CONSOLE,
  UNSIGNED_CHANNEL,
} from './redis_channel.js';
import { federatedSafe, readOnlyBillingStore } from './safety.js';

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
 *   (`consoleCommands.actions`) AND the console's `authorize` granted the viewer its capability
 *   (in token mode, AND the console's own token carries it).
 * - Commands are authenticated (Redis is not a trust boundary): sealed with `@adonis-agora/crypto`,
 *   sealed with a token the app verifies (authkit), or HMAC'd under a shared secret. An app with
 *   none of them answers nothing.
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
  refund: {
    route: 'refund',
    capability: 'payments:refund',
    consoleCapability: 'payments:console:refund',
  },
  cancelSubscription: {
    route: 'cancelSubscription',
    capability: 'payments:subscriptions:cancel',
    consoleCapability: 'payments:console:subscriptions:cancel',
  },
  resumeSubscription: {
    route: 'resumeSubscription',
    capability: 'payments:subscriptions:resume',
    consoleCapability: 'payments:console:subscriptions:resume',
  },
  repriceSubscription: {
    route: 'repriceSubscription',
    capability: 'payments:subscriptions:reprice',
    consoleCapability: 'payments:console:subscriptions:reprice',
  },
  retryWebhook: {
    route: 'retry',
    capability: 'payments:webhooks:retry',
    consoleCapability: 'payments:console:webhooks:retry',
  },
  resolveDispute: {
    route: 'resolve',
    capability: 'payments:disputes:resolve',
    consoleCapability: 'payments:console:disputes:resolve',
  },
} as const satisfies Record<
  string,
  { route: keyof typeof CONSOLE_ROUTES; capability: string; consoleCapability: string }
>;

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

/** Reading this app through a console: its profile (what its gateways can do). */
export const CONSOLE_READ_CAPABILITY = 'payments:console:read';
/** Every action through a console (each also has its own, finer, capability). */
export const CONSOLE_WRITE_CAPABILITY = 'payments:console:write';
/**
 * What a console sends when its `authorize` does not narrow the viewer's capabilities: the whole
 * console set (the app's `consoleCommands.actions` still decides which actions run).
 */
export const CONSOLE_CAPABILITIES: readonly string[] = [
  CONSOLE_READ_CAPABILITY,
  CONSOLE_WRITE_CAPABILITY,
];
/** @deprecated The viewer-side name of {@link CONSOLE_READ_CAPABILITY}, still accepted from a viewer. */
export const PROFILE_CAPABILITY = 'payments:read';

/** A console verb: `profile` (read) or an action. */
type ConsoleVerb = 'profile' | FederatedPaymentsAction;

/** Dispute evidence: a write the console runs on its own app only (never sent to another). */
const EVIDENCE_CAPABILITIES = {
  capability: 'payments:disputes:evidence',
  consoleCapability: 'payments:console:disputes:evidence',
} as const;

/**
 * Payments' console capabilities for the shared matcher (`console_capabilities.ts`): each read
 * and each write, under its console name and the viewer name the console has always used. A
 * `payments:console:write` grant covers the writes, `payments:console:read` the reads, and a
 * trailing-`*` grant under `payments:` its subtree (`payments:console:subscriptions:*`).
 */
export const PAYMENTS_CONSOLE_CAPABILITIES: ConsoleCapabilityTable = Object.freeze({
  [PROFILE_CAPABILITY]: 'read',
  ...Object.fromEntries(
    ACTION_NAMES.flatMap((action) => [
      [FEDERATED_ACTIONS[action].consoleCapability, 'write'],
      [FEDERATED_ACTIONS[action].capability, 'write'],
    ]),
  ),
  [EVIDENCE_CAPABILITIES.consoleCapability]: 'write',
  [EVIDENCE_CAPABILITIES.capability]: 'write',
});

/** Whether `granted` allows the console capability `required` (the shared matcher). */
const allows = (granted: readonly string[] | undefined, required: string): boolean =>
  consoleCapabilityAllows(granted, required, PAYMENTS_CONSOLE_CAPABILITIES);

/**
 * Whether a console TOKEN (token mode) allows `verb`. Only the console capabilities count
 * (`payments:console:read`, `payments:console:write`, `payments:console:refund`, …, and the
 * `payments:console:*` / `payments:*` / `*` wildcards): a payments tenant's token
 * (`payments:refund`, `payments:read`) does not make its holder a console.
 */
export function consoleTokenAllows(
  granted: readonly string[] | undefined,
  verb: ConsoleVerb,
): boolean {
  return allows(
    granted,
    verb === 'profile' ? CONSOLE_READ_CAPABILITY : FEDERATED_ACTIONS[verb].consoleCapability,
  );
}

/**
 * Whether the capabilities a console granted its VIEWER (its `authorize`) allow `verb`: the console
 * capabilities, or the viewer names the console has always used (`payments:refund`,
 * `payments:subscriptions:cancel`, …, `payments:read`).
 */
export function consoleViewerAllows(
  granted: readonly string[] | undefined,
  verb: ConsoleVerb,
): boolean {
  if (consoleTokenAllows(granted, verb)) return true;
  return verb === 'profile'
    ? allows(granted, PROFILE_CAPABILITY)
    : allows(granted, FEDERATED_ACTIONS[verb].capability);
}

/** Every console verb, for narrowing a viewer's capabilities to what reaches this console. */
const CONSOLE_VERBS: readonly ConsoleVerb[] = ['profile', ...ACTION_NAMES];

/**
 * The capabilities a console sends for its viewer: the ones `authorize` returned that reach this
 * lib's console set (anything else, another lib's or an unrelated one, is dropped), or the whole
 * console set when `authorize` returned none. `access: 'read'` keeps reads only.
 */
export function viewerConsoleCapabilities(
  granted: readonly string[] | undefined,
  access?: 'read' | 'write',
): string[] {
  const all = granted === undefined ? [...CONSOLE_CAPABILITIES] : [...granted];
  const reaches = (capability: string, verbs: readonly ConsoleVerb[]) =>
    verbs.some((verb) => consoleViewerAllows([capability], verb));
  if (access === 'read') {
    return all.some((c) => reaches(c, ['profile'])) ? [CONSOLE_READ_CAPABILITY] : [];
  }
  return all.filter((capability) => reaches(capability, CONSOLE_VERBS));
}

/**
 * The console's write routes on its OWN app, each with the capability a viewer needs: the
 * federated actions (same names), plus dispute evidence, which only runs locally.
 */
export const LOCAL_ACTIONS: Readonly<
  Record<string, { capability: string; consoleCapability: string }>
> = {
  ...Object.fromEntries(
    ACTION_NAMES.map((action) => [
      FEDERATED_ACTIONS[action].route,
      {
        capability: FEDERATED_ACTIONS[action].capability,
        consoleCapability: FEDERATED_ACTIONS[action].consoleCapability,
      },
    ]),
  ),
  evidence: EVIDENCE_CAPABILITIES,
};

/**
 * Whether the viewer may run the console route `route` on this console's own app, by the same
 * rule as a federated command: reads always (once `authorize` allowed), a write when `authorize`
 * returned no capabilities (full access) or one that covers it (`payments:console:write`, the
 * action's `payments:console:<…>`, or its viewer name such as `payments:refund`), never with
 * `access: 'read'`. Answers the refusal message, or `undefined` when allowed.
 */
export function viewerLocalRefusal(
  route: string,
  capabilities: readonly string[] | undefined,
  access?: 'read' | 'write',
): string | undefined {
  const needed = LOCAL_ACTIONS[route];
  if (needed === undefined) return undefined;
  const names = `"${needed.capability}" (or "${needed.consoleCapability}", "${CONSOLE_WRITE_CAPABILITY}")`;
  if (access === 'read')
    return `the viewer lacks ${names}: this console's authorize gives read access only`;
  if (capabilities === undefined) return undefined;
  const allowed =
    allows(capabilities, needed.consoleCapability) || allows(capabilities, needed.capability);
  return allowed ? undefined : `the viewer lacks ${names}`;
}

/** The write routes a viewer may run, for the console page (`undefined`: every one). */
export function viewerLocalActions(
  capabilities: readonly string[] | undefined,
  access?: 'read' | 'write',
): string[] | undefined {
  if (capabilities === undefined && access !== 'read') return undefined;
  return Object.keys(LOCAL_ACTIONS).filter(
    (route) => viewerLocalRefusal(route, capabilities, access) === undefined,
  );
}

/** What to ask for when `verb` is refused. */
function neededFor(verb: ConsoleVerb): string {
  return verb === 'profile'
    ? `"${CONSOLE_READ_CAPABILITY}"`
    : `"${FEDERATED_ACTIONS[verb].consoleCapability}" (or "${CONSOLE_WRITE_CAPABILITY}")`;
}

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
    readonly code?: string,
  ) {
    super(message);
  }
}

/** A command that carried no `capabilities` (the same code in every Agora lib). */
export const CAPABILITIES_REQUIRED = 'capabilities-required';

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
      /**
       * Token mode: checks the token each command carries, e.g.
       * `authkitTenantVerifier({ issuer, resource: 'urn:agora:payments' })` or your own function
       * (`({ token }) => ({ partition, capabilities, clientId? }) | null`). The token's `partition`
       * must be this app's {@link partition}, and its capabilities cap what the console may do
       * (`payments:console:read` for the profile, `payments:console:write` or each action's
       * `payments:console:<…>` for it). Without `crypto`, commands arrive sealed to a key derived
       * from `APP_KEY`; give the console its public half (`node ace payments:console-key`) as
       * `controlPlane.publicKey`.
       *
       * Unset, a token is still verified when authkit's calls between apps are configured in this
       * app (`authkit.client`), and on a payments control plane by its own `verifyTenant`. `false`
       * turns that off.
       */
      verifyTenant?: TenantVerifierInput | false | undefined;
      /**
       * The partition this app is in the console's tokens (its authkit partition). Default: the
       * `prefix`. Only used in token mode.
       */
      partition?: string | undefined;
      /**
       * Sealed with a key: commands arrive encrypted with a key (`console-payments` by default)
       * this app may `decrypt` and the console may `encrypt`. Unset, and with no `secret` or
       * `verifyTenant` either, this is automatic when `@adonis-agora/crypto` is booted in this app
       * (its own partition's `console-payments` key). Set it for another cipher: any
       * `{ encrypt, decrypt }` (a KMS, Vault transit, an HSM) with `owns` recognising its
       * ciphertext. `false` turns the automatic mode off. With an explicit `verifyTenant` too,
       * each command must also carry a valid token.
       */
      crypto?: ConsoleCryptoOption | false | undefined;
      /**
       * Shared-secret mode (no authkit): the secret this app and the console share (the console's
       * `apps.<key>.controlPlane.secret`), at least 16 characters. Every command and answer
       * carries an HMAC under it.
       */
      secret?: ChannelSecret | undefined;
    };

/** `consoleCommands` with its defaults, or `undefined` when off. */
export interface ResolvedConsoleCommands {
  prefix: string;
  connection: string | undefined;
  actions: ReadonlySet<FederatedPaymentsAction>;
  idempotency: ConsoleIdempotencyStore | undefined;
  /** The partition a console's token must be for (token mode). */
  partition: string;
  verifyTenant: TenantVerifierInput | false | undefined;
  crypto: ConsoleCryptoOption | false | undefined;
  secret: ChannelSecret | undefined;
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
    fail(
      'must be true or { prefix, connection, actions, idempotency, verifyTenant, crypto, secret }',
    );
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
  if (
    value.partition !== undefined &&
    (typeof value.partition !== 'string' || !value.partition.trim())
  ) {
    fail('`partition` must be a non-empty string');
  }
  if (value.secret !== undefined) {
    const raw =
      typeof value.secret === 'string'
        ? value.secret
        : typeof (value.secret as { release?: unknown })?.release === 'function'
          ? (value.secret as { release(): unknown }).release()
          : undefined;
    if (typeof raw !== 'string' || raw.length < 16) {
      fail("`secret` must be at least 16 characters (the same value as the console's)");
    }
  }
  if (value.crypto !== undefined && value.crypto !== false) validateCrypto(value.crypto, fail);
  if (
    value.verifyTenant !== undefined &&
    value.verifyTenant !== false &&
    typeof value.verifyTenant !== 'function' &&
    typeof (value.verifyTenant as { verify?: unknown } | null)?.verify !== 'function'
  ) {
    fail('`verifyTenant` must be a function, an object with verify(), or false');
  }
  const store = value.idempotency as Partial<ConsoleIdempotencyStore> | undefined;
  if (
    store !== undefined &&
    (typeof store?.begin !== 'function' || typeof store.finish !== 'function')
  ) {
    fail('`idempotency` must be a store with begin() and finish()');
  }
}

function validateCrypto(value: unknown, fail: (message: string) => never): void {
  const crypto = value as { cipher?: unknown; key?: unknown; owns?: unknown } | null;
  if (!crypto || typeof crypto !== 'object' || crypto.cipher === undefined) {
    fail(
      '`crypto` must be { cipher, key?, owns? } (cipher: { encrypt, decrypt }, or a function returning one), or false',
    );
  }
  if (crypto?.key !== undefined && (typeof crypto.key !== 'string' || crypto.key === '')) {
    fail('`crypto.key` must be a crypto key name');
  }
  if (crypto?.owns !== undefined && typeof crypto.owns !== 'function') {
    fail('`crypto.owns` must be a function (ciphertext) => boolean');
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
    partition: value.partition ?? prefix,
    verifyTenant: value.verifyTenant,
    crypto: value.crypto,
    secret: value.secret,
  };
}

/**
 * Whether `consoleCommands` itself names a way to authenticate the console. Without one, the
 * provider looks for @adonis-agora/crypto and authkit in the app, and fails the boot without them.
 */
export function consoleCommandsAuthenticated(option: ResolvedConsoleCommands): boolean {
  return option.secret !== undefined || !!option.crypto || !!option.verifyTenant;
}

/** A config value that may be an AdonisJS config provider (`{ resolver(app) }`), resolved. */
async function resolvedConfig(value: unknown, app: unknown): Promise<unknown> {
  if (value === null || typeof value !== 'object') return value;
  const resolver = (value as { resolver?: unknown }).resolver;
  if (typeof resolver !== 'function') return value;
  try {
    return await (resolver as (app: unknown) => unknown).call(value, app);
  } catch {
    return undefined;
  }
}

/** The first usable key of an encryption config entry, whatever its shape (`keys[…]`, `key`). */
function keyOfEntry(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== 'object') return undefined;
  const { keys, key } = entry as { keys?: unknown; key?: unknown };
  if (Array.isArray(keys)) {
    for (const candidate of keys) {
      const usable = safeRelease(candidate);
      if (usable !== undefined) return usable;
    }
    return undefined;
  }
  return safeRelease(key);
}

/** `releasedAppKey`, where a source that throws counts as "no key here". */
function safeRelease(value: unknown): string | undefined {
  try {
    return releasedAppKey(value);
  } catch {
    return undefined;
  }
}

/**
 * The key of `config/encryption.ts` (AdonisJS 7): the first key of its default entry
 * (`list[default]`, else the first entry), resolving the lazy config providers `defineConfig` and
 * `drivers.*` return. A flat `{ keys }` / `{ key }` config is read as is.
 */
async function encryptionKeyOf(app: AppKeySource): Promise<string | undefined> {
  let raw: unknown;
  try {
    raw = app.config.get<unknown>('encryption', undefined);
  } catch {
    return undefined;
  }
  const config = await resolvedConfig(raw, app);
  if (config === null || typeof config !== 'object') return undefined;
  const { list, default: name } = config as { list?: unknown; default?: unknown };
  if (list !== null && typeof list === 'object') {
    const entries = list as Record<string, unknown>;
    const chosen =
      typeof name === 'string' && Object.hasOwn(entries, name) ? name : Object.keys(entries)[0];
    return chosen === undefined
      ? undefined
      : keyOfEntry(await resolvedConfig(entries[chosen], app));
  }
  return keyOfEntry(config);
}

/** What {@link appKeyOf} reads: the application (its config, and itself for config providers). */
export interface AppKeySource {
  config: { get<T>(key: string, fallback?: T): T };
}

/**
 * The app's APP_KEY (SECURITY-UNIFORM-SPEC §13c, identical in every Agora lib): `config/app.ts`'s
 * `appKey`, else the default entry of `config/encryption.ts` (AdonisJS 7, lazy providers
 * resolved), else `process.env.APP_KEY`. Strings and `Secret`s (`.release()`); never logged.
 */
export async function appKeyOf(app: AppKeySource): Promise<string | undefined> {
  let fromApp: unknown;
  try {
    fromApp = app.config.get<unknown>('app.appKey', undefined);
  } catch {
    fromApp = undefined;
  }
  const appKey = safeRelease(fromApp);
  if (appKey !== undefined) return appKey;
  const fromEncryption = await encryptionKeyOf(app);
  if (fromEncryption !== undefined) return fromEncryption;
  return safeRelease(process.env.APP_KEY);
}

/** `app.appKey` (a string or an AdonisJS `Secret`) as a string, or `undefined` without one. */
export function releasedAppKey(value: unknown): string | undefined {
  const raw =
    typeof value === 'string'
      ? value
      : typeof (value as { release?: unknown } | undefined)?.release === 'function'
        ? (value as { release(): unknown }).release()
        : undefined;
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/**
 * The X25519 key pair console commands are sealed to in token mode, derived from the app's
 * `APP_KEY` and its `prefix`: every instance derives the same one, and a new `APP_KEY` makes a new
 * one. The console takes the public half as `controlPlane.publicKey`
 * (`node ace payments:console-key` prints it).
 */
export function consoleCommandKeys(
  appKey: string,
  prefix: string,
): { publicKey: OkpJwk; privateKey: OkpJwk } {
  return deriveX25519KeyPair(appKey, `payments:console-commands:${prefix}`);
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

/**
 * The acting person a command carries, as the owning app's audit trail records them. The console
 * names the person (it is authenticated, so it is trusted to); in token mode the token's client is
 * recorded too.
 */
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
  const client = command.verified?.clientId;
  const app = command.verified?.app;
  if (app && client && client !== app) {
    return `${who} (via ${via}, app ${clean(app)}, client ${clean(client)})`;
  }
  if (app) return `${who} (via ${via}, app ${clean(app)})`;
  return client ? `${who} (via ${via}, client ${clean(client)})` : `${who} (via ${via})`;
}

/**
 * Answers the commands another app's federated payments console sends this app: `profile` (what
 * its gateways can do, which actions it runs) and each allow-listed action, run through this app's
 * own console handlers, drivers and audit trail. An action needs:
 *
 * 1. to be listed in `consoleCommands.actions`;
 * 2. the viewer's capability, as the console's `authorize` granted it and the command carries it;
 *    in token mode the console's verified token must carry it as well (the viewer's capabilities
 *    only narrow the token's), and the token must be for this app's `partition`;
 * 3. an idempotency key (except a `dryRun`): the first run's answer is replayed for the same key,
 *    a key reused for something else is refused (`422`), and one still running is `409`.
 *
 * Answers are masked ({@link federatedSafe}) before they are published.
 */
export function paymentsConsoleCommandHandler(options: {
  runtime: OwningAppRuntime;
  actions: ReadonlySet<FederatedPaymentsAction>;
  idempotency: ConsoleIdempotencyStore;
  /** The partition a console's verified token must be for (token mode). */
  partition?: string | undefined;
  log?: ((line: string) => void) | undefined;
}): (command: ConsoleCommand) => Promise<unknown> {
  return async (command) => {
    const { verb } = command;
    const runtime = options.runtime;
    // The order of the checks is the same in every Agora lib: the verb is known → the command
    // carries capabilities → the console's token allows it → the viewer does → the token is for
    // this app → this app runs that action.
    if (verb !== 'profile' && !(verb in FEDERATED_ACTIONS)) {
      throw Object.assign(
        new Error(`this app does not answer the payments console command ${verb}`),
        { code: UNSUPPORTED },
      );
    }
    // Every command says what the console granted (the viewer's capabilities, or the whole console
    // set): a command without them is refused, never taken for "everything".
    if (!Array.isArray(command.capabilities)) {
      throw new StatusError(
        'the console sent no capabilities with this command; update @adonis-agora/payments on the console app',
        403,
        CAPABILITIES_REQUIRED,
      );
    }
    const viewer = command.capabilities;
    // Token mode: the console's token (verified by the channel) caps what it may do; the viewer's
    // capabilities only narrow that. Without a token, the viewer's alone decide.
    const verified = command.verified;
    const current = verb as ConsoleVerb;
    if (verified && !consoleTokenAllows(verified.capabilities, current)) {
      throw new StatusError(`the console's token lacks ${neededFor(current)}`, 403);
    }
    if (!consoleViewerAllows(viewer, current)) {
      throw new StatusError(`the viewer lacks ${neededFor(current)}`, 403);
    }
    if (verified && verified.partition !== options.partition) {
      throw new StatusError(
        `the console's token is for "${verified.partition}", not "${options.partition ?? '(no partition)'}"`,
        403,
      );
    }
    if (verb === 'profile') {
      const profile: PaymentsConsoleProfile = {
        capabilities: (await runtime.capabilities()) ?? null,
        actions: [...options.actions],
      };
      return federatedSafe(profile);
    }
    const action = verb as FederatedPaymentsAction;
    if (!options.actions.has(action)) {
      throw new StatusError(
        `this app does not run "${action}" for another console (consoleCommands.actions)`,
        403,
      );
    }
    const { route } = FEDERATED_ACTIONS[action];
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
 * Throws (`federated-channel-unsigned`) without `secret`, `crypto` or `verifyTenant` + `keys`: an
 * app never answers unauthenticated commands.
 */
export async function answerPaymentsConsoleCommands(options: {
  client: RedisLike;
  prefix: string;
  actions: ReadonlySet<FederatedPaymentsAction>;
  idempotency: ConsoleIdempotencyStore;
  runtime: OwningAppRuntime;
  /** The partition a console's token must be for (token mode). Default: `prefix`. */
  partition?: string | undefined;
  /** Shared-secret mode: the secret shared with the console. */
  secret?: ChannelSecret | undefined;
  /** `@adonis-agora/crypto` mode: the cipher this app decrypts with, and the key. */
  crypto?: ConsoleCryptoOption | undefined;
  /** Token mode: verifies the console's token. */
  verifyTenant?: TenantVerifierInput | undefined;
  /** A crypto-sealed command may omit the token (a verifier found automatically). */
  cryptoTokenOptional?: boolean | undefined;
  /** Token mode without `crypto`: this app's command key pair ({@link consoleCommandKeys}). */
  keys?: { publicKey: OkpJwk; privateKey: OkpJwk } | undefined;
  log?: ((line: string) => void) | undefined;
  onError?: ((error: unknown) => void) | undefined;
}): Promise<RedisConsoleChannel> {
  const partition = options.partition ?? options.prefix;
  const channel = new RedisConsoleChannel({
    client: options.client,
    prefix: options.prefix,
    partition,
    ...(options.secret !== undefined ? { secret: options.secret } : {}),
    ...(options.crypto !== undefined ? { crypto: options.crypto } : {}),
    ...(options.verifyTenant !== undefined ? { verifyTenant: options.verifyTenant } : {}),
    ...(options.cryptoTokenOptional ? { cryptoTokenOptional: true } : {}),
    ...(options.keys !== undefined ? { keys: options.keys } : {}),
  });
  await channel.answer(
    paymentsConsoleCommandHandler({
      runtime: options.runtime,
      actions: options.actions,
      idempotency: options.idempotency,
      partition,
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
   * That app's name in `@adonis-agora/crypto` and authkit (its crypto partition, its authkit app).
   * Default: the key. Automatic crypto seals with the `console-payments` key of this partition, and
   * an automatic authkit token is asked for this app.
   */
  partition?: string | undefined;
  /**
   * Where that app answers commands (`consoleCommands` in its config/payments.ts): the
   * `@adonisjs/redis` connection to publish on, that app's `prefix`, and how this console proves
   * itself to the app. Nothing to set with `@adonis-agora/crypto` in this app; otherwise one of
   * `crypto`, `token` + `publicKey`, `secret` (without one, no command is sent, and an entry with
   * actions fails the boot).
   */
  controlPlane: FederatedControlPlane | RedisConsoleChannel;
  /** Whether this console may send actions to that app. Default `true`; `false` browses only. */
  actions?: boolean | undefined;
  /** How long an action waits for the app to answer, in ms. Default 15 000. */
  timeoutMs?: number | undefined;
}

/** `apps.<key>.controlPlane`: where the app answers, and how this console authenticates. */
export interface FederatedControlPlane {
  connection?: string | undefined;
  prefix: string;
  /**
   * Shared-secret mode: the secret shared with that app (its `consoleCommands.secret`). Use it when
   * there is no authkit and no `@adonis-agora/crypto`.
   */
  secret?: ChannelSecret | undefined;
  /**
   * Token mode: this console's token for that app, e.g. `authkitTenantToken({ issuer, clientId,
   * clientSecret, resource: 'urn:agora:payments' })` of a service-tenant client whose `partition`
   * is that app and whose capabilities say what this console may do there
   * (`payments:console:read`, `payments:console:write`, …), or your own `() => Promise<string>`.
   * The app checks it with its `consoleCommands.verifyTenant`. Without `crypto`, needs
   * {@link publicKey}. Unset, authkit's calls between apps provide one when this app has them
   * (`authkit.client`); `false` turns that off.
   */
  token?: HubTokenSource | false | undefined;
  /**
   * Token mode without `crypto`: the app's console-command public key, as `node ace
   * payments:console-key` prints it in that app (a JWK object, or its JSON). Commands and the
   * token are sealed to it. Configure it here, never take it from Redis.
   */
  publicKey?: OkpJwk | string | undefined;
  /**
   * Sealed with a key: the cipher this console encrypts with, for a key of that app
   * (`console-payments` by default) it may `encrypt` with and the app may `decrypt`. Unset (and no
   * `secret` or `token`), this is automatic when `@adonis-agora/crypto` is booted in this app:
   * embedded (the Hub) it seals with the key of the app's {@link FederatedPaymentsAppConfig.partition};
   * as a crypto tenant it asks its crypto server to (`crypto:seal:console-*`). Set it for another
   * cipher (a KMS, Vault transit, an HSM: `{ cipher: { encrypt, decrypt }, owns }`); `false` turns
   * the automatic mode off. Combine with `token` when the app also checks one.
   */
  crypto?: ConsoleCryptoOption | false | undefined;
}

/** `controlPlane.publicKey` as a JWK (it may be given as JSON), or `undefined` when it is not one. */
export function parseConsolePublicKey(value: unknown): OkpJwk | undefined {
  let jwk = value;
  if (typeof value === 'string') {
    try {
      jwk = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return isX25519PublicJwk(jwk) ? jwk : undefined;
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
    if (plane.publicKey !== undefined && !parseConsolePublicKey(plane.publicKey)) {
      fail(
        "`controlPlane.publicKey` must be the app's X25519 public JWK (as `node ace payments:console-key` prints it), without its private part",
      );
    }
    // A token without crypto needs the app's key: `publicKey`, or authkit's key directory — known
    // only at boot, where the console checks it (and fails with what to set).
    if (plane.crypto !== undefined && plane.crypto !== false) {
      validateCrypto(plane.crypto, (message) => fail(`controlPlane: ${message}`));
    }
  }
  if (
    entry.partition !== undefined &&
    (typeof entry.partition !== 'string' || entry.partition.trim() === '')
  ) {
    fail("`partition` must be that app's crypto partition / authkit app name (not empty)");
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
  /** `@adonis-agora/crypto` in this app (`'agora.crypto'`), for the automatic crypto mode. */
  crypto?(): Promise<CryptoRuntimeLike | undefined>;
  /** `@adonis-agora/authkit-client` in this app (`'authkit.client'`), for automatic tokens. */
  authkit?(): Promise<AuthkitClientLike | undefined>;
  /** Where the console logs what happens after boot (a token sent without, §13b). */
  log?(note: { level: 'info' | 'warn'; line: string }): void;
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
  /** `'read'` when `authorize` said the viewer may only read. */
  access?: 'read' | 'write' | undefined;
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
  /** The app's crypto partition / authkit app name. */
  readonly partition: string;
  readonly #entry: FederatedPaymentsAppConfig;
  readonly #context: FederationContext;
  #auth: Promise<SendingAuth | undefined> | undefined;
  #store: Promise<BillingStore> | undefined;
  /** One channel per way of sending (`default`, or §13a's `crypto` / `token`). */
  readonly #channels = new Map<string, Promise<RedisConsoleChannel>>();
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
    this.partition = entry.partition ?? key;
  }

  /**
   * How this console authenticates to the app: its `controlPlane` options, else crypto and authkit
   * found in this app. `undefined` for a channel handed over in the config (it is used as given).
   */
  auth(): Promise<SendingAuth | undefined> {
    this.#auth ??= (async () => {
      const plane = this.#entry.controlPlane;
      if (plane instanceof RedisConsoleChannel) return undefined;
      const publicKey =
        plane.publicKey !== undefined ? parseConsolePublicKey(plane.publicKey) : undefined;
      return resolveSendingAuth({
        plane: {
          ...(plane.secret !== undefined ? { secret: plane.secret } : {}),
          ...(plane.crypto !== undefined ? { crypto: plane.crypto } : {}),
          ...(plane.token !== undefined ? { token: plane.token } : {}),
          ...(publicKey ? { publicKey } : {}),
        },
        partition: this.partition,
        app: this.key,
        crypto: await this.#context.crypto?.(),
        authkit: await this.#context.authkit?.(),
        ...(this.#context.log ? { log: this.#context.log } : {}),
      });
    })();
    this.#auth.catch(() => {
      this.#auth = undefined;
    });
    return this.#auth;
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

  channel(variant: 'default' | 'crypto' | 'token' = 'default'): Promise<RedisConsoleChannel> {
    let channel = this.#channels.get(variant);
    if (!channel) {
      channel = (async () => {
        const plane = this.#entry.controlPlane;
        if (plane instanceof RedisConsoleChannel) return plane;
        const auth = (await this.auth())!;
        const with_ = variant === 'default' ? auth : auth.variants![variant];
        return new RedisConsoleChannel({
          client: await this.#context.redis(plane.connection),
          prefix: plane.prefix,
          ...(auth.secret !== undefined && variant === 'default' ? { secret: auth.secret } : {}),
          ...(with_.crypto !== undefined ? { crypto: with_.crypto } : {}),
          ...(with_.token !== undefined ? { token: with_.token } : {}),
          // The app's APP_KEY-derived key: only needed without crypto.
          ...(with_.token !== undefined && with_.crypto === undefined && with_.recipient
            ? { recipient: with_.recipient }
            : {}),
        });
      })();
      this.#channels.set(variant, channel);
      // A connection that could not be made (a typo, Redis not installed) is retried next time.
      const made = channel;
      made.catch(() => {
        if (this.#channels.get(variant) === made) this.#channels.delete(variant);
      });
    }
    return channel;
  }

  /** Send a command and wait for the app's answer (throws when nobody answers or it refused). */
  async send(verb: string, args: unknown[], meta: FederatedCallMeta = {}): Promise<unknown> {
    // §13a: with crypto and authkit's directory both available, the app's own published key says
    // which way it is reached; the choice is cached, and dropped when the app does not answer.
    const auth =
      this.#entry.controlPlane instanceof RedisConsoleChannel ? undefined : await this.auth();
    const variant = auth?.decide ? await auth.decide() : 'default';
    const command: ConsoleCommand = {
      id: randomUUID(),
      verb,
      args,
      ...(meta.actor !== undefined ? { actor: meta.actor } : {}),
      ...(meta.capabilities !== undefined ? { capabilities: [...meta.capabilities] } : {}),
      ...(meta.via !== undefined ? { via: meta.via } : {}),
    };
    const options = { timeoutMs: this.#entry.timeoutMs ?? COMMAND_TIMEOUT_MS };
    let reply: ConsoleReply;
    try {
      reply = await (await this.channel(variant)).send(command, options);
    } catch (error) {
      // §13a: token chosen automatically (the app published a key) but no app-call token could be
      // minted (no grant; a stale key from an older app version): crypto reaches the app too, so
      // this command, and the next ones for 5 minutes, go by crypto, with §13b's warning once.
      if (
        variant === 'token' &&
        auth?.variants?.crypto &&
        auth.tokenUnavailable &&
        error instanceof Error &&
        error.message.includes(APP_CALL_TOKEN_FAILURE)
      ) {
        const reason = (error as { reason?: unknown }).reason;
        auth.tokenUnavailable(
          typeof reason === 'string' ? reason : error.message,
          (error as { missingGrant?: unknown }).missingGrant === true,
        );
        reply = await (await this.channel('crypto')).send(command, options);
      } else {
        // The app did not take the mode it was sent in (or did not answer): decide again next time.
        auth?.invalidate?.();
        throw error;
      }
    }
    if (!reply.ok && /mode not accepted here/.test(reply.error.message)) auth?.invalidate?.();
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
      // Shared by every viewer for 30 s, so it carries the console's read capability, not a viewer's.
      this.#asking ??= (
        this.send('profile', [], {
          capabilities: [CONSOLE_READ_CAPABILITY],
        }) as Promise<PaymentsConsoleProfile>
      ).finally(() => {
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
    // A channel handed over in the config belongs to whoever made it.
    if (this.#entry.controlPlane instanceof RedisConsoleChannel) return;
    for (const made of this.#channels.values()) {
      const channel = await made.catch(() => undefined);
      await channel?.close();
    }
    this.#channels.clear();
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
  if (error instanceof ConsoleChannelError && error.code === UNSIGNED_CHANNEL) {
    return {
      status: 503,
      body: {
        error: `${label} cannot be reached securely: ${error.message}`,
        code: UNSIGNED_CHANNEL,
      },
    };
  }
  if (error instanceof ConsoleChannelError) {
    return {
      status: 503,
      body: { error: `${label} did not answer: ${error.message}`, code: APP_UNREACHABLE },
    };
  }
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  const message = error instanceof Error ? error.message : String(error);
  if (code === APP_UNREACHABLE) return { status: 503, body: { error: `${label}: ${message}` } };
  // The app refused this console's token: a console misconfiguration, not the viewer's login.
  if (code === UNAUTHORIZED_CONSOLE) {
    return { status: 502, body: { error: `${label}: ${message}`, code: UNAUTHORIZED_CONSOLE } };
  }
  if (code === UNSUPPORTED) {
    return { status: 501, body: { error: `${label} does not answer this yet: ${message}` } };
  }
  if (typeof status === 'number' && status >= 400 && status < 600) {
    return { status, body: { error: message, ...(typeof code === 'string' ? { code } : {}) } };
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

  /**
   * Resolve how this console authenticates to each app, at boot: throws (naming every app and what
   * to set) when an app this console may act on has no way to authenticate, makes sure the
   * automatic crypto keys exist, and answers one log line per app.
   */
  async prepare(): Promise<Array<{ level: 'info' | 'warn'; line: string }>> {
    const lines: Array<{ level: 'info' | 'warn'; line: string }> = [];
    const info = (line: string) => lines.push({ level: 'info', line });
    const errors: Error[] = [];
    for (const app of this.#apps.values()) {
      const auth = await app.auth();
      if (auth === undefined) {
        info(
          `[@adonis-agora/payments] console commands to "${app.key}": the channel given in config`,
        );
        continue;
      }
      if (auth.mode === undefined) {
        if (app.actions) errors.push(sendingAuthError(app.key, auth.notes));
        else {
          info(
            `[@adonis-agora/payments] console commands to "${app.key}": none (browse-only, actions: false)`,
          );
        }
        continue;
      }
      info(`[@adonis-agora/payments] console commands to "${app.key}": ${auth.mode}`);
      if (auth.ensureKey) {
        try {
          const done = await auth.ensureKey();
          if (done) info(`[@adonis-agora/payments] console commands: ${done}`);
        } catch (error) {
          // Never fails the boot: one actionable line, and the first command tries again.
          lines.push({
            level: 'warn',
            line: `[@adonis-agora/payments] console commands to "${app.key}": ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new ConsoleAuthConfigError(errors.map((error) => error.message).join('\n'));
    }
    return lines;
  }

  /** How this console authenticates to `key` (for the doctor). */
  async authOf(key: string): Promise<SendingAuth | undefined | null> {
    const app = this.#apps.get(key);
    return app ? app.auth() : null;
  }

  /** The keys of the apps (for the doctor). */
  keys(): string[] {
    return [...this.#apps.keys()];
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
      // An `authorize` that does not narrow the viewer's capabilities grants the console set.
      // What `authorize` granted, narrowed to this console's set (the whole set when it said none).
      const granted = viewerConsoleCapabilities(meta.capabilities, meta.access);
      if (!consoleViewerAllows(granted, action)) {
        const { capability } = FEDERATED_ACTIONS[action];
        return {
          status: 403,
          body: {
            error: `the viewer lacks "${capability}" (or ${neededFor(action)}) to act on ${app.label}: add it to the capabilities this console's authorize returns`,
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
        { ...meta, capabilities: [...granted] },
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
