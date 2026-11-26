import type { HubTokenSource } from '../topology/tenant.js';
import {
  resolveTenantVerifier,
  type TenantAuthRequest,
  type TenantVerifierInput,
  type VerifiedTenant,
} from '../topology/verify.js';
import { isX25519PublicJwk, type OkpJwk } from './console_key.js';
import { watchTenantConsoleKey } from './console_key_check.js';
import {
  type ChannelSecret,
  CONSOLE_CRYPTO_KEY,
  type ConsoleCipher,
  type ConsoleCryptoOption,
} from './redis_channel.js';

/**
 * How the federated console's channel authenticates itself when the app says nothing: it reuses
 * what the sibling Agora libs in the same app already configured, read from the container by
 * binding name (never imported).
 *
 * - `@adonis-agora/crypto` (`'agora.crypto'`): commands are sealed with the `console-payments` key
 *   of the owning app's partition. Embedded in this app (the Hub), the key is created on demand;
 *   in a separate crypto app, the channel `config/crypto.ts` already has is used.
 * - `@adonis-agora/authkit-client` (`'authkit.client'`, its calls between apps): the console sends
 *   an app-call token for the owning app; the owning app checks it with authkit's verifier.
 *
 * Explicit options always win: an explicit `crypto`, `secret`, `token`/`verifyTenant` is used as
 * given (no automatic crypto on top), and `crypto: false` / `token: false` / `verifyTenant: false`
 * turn the matching detection off.
 */

const PACKAGE = '@adonis-agora/payments';

/** What `'agora.crypto'` is, as far as this package needs it (read structurally). */
export interface CryptoRuntimeLike {
  topology: 'standalone' | 'control-plane' | 'tenant';
  /** The app this process is in crypto: its own partition. */
  partition: string;
  /** Crypto embedded in this app (standalone or control plane). */
  service?: {
    encrypt(
      principal: CryptoPrincipalLike,
      input: { key: string; plaintext: string; aad?: string; context?: string },
    ): Promise<{ ciphertext: string }>;
    decrypt(
      principal: CryptoPrincipalLike,
      input: { key: string; ciphertext: string; aad?: string; context?: string },
    ): Promise<{ plaintext: string }>;
    createKey(
      principal: CryptoPrincipalLike,
      input: { name: string; type: 'aes256-gcm'; description?: string },
    ): Promise<unknown>;
    store: { getKey(partition: string, name: string): Promise<unknown | null> };
  };
  /** This app's own operations: in process, or over its channel to the crypto server. */
  operations: {
    encrypt(input: {
      key: string;
      plaintext: string;
      aad?: string;
      context?: string;
      /** Seal for another app's key (crypto server: `crypto:seal:<key>`; encrypt only). */
      partition?: string;
    }): Promise<{ ciphertext: string }>;
    decrypt(input: {
      key: string;
      ciphertext: string;
      aad?: string;
      context?: string;
    }): Promise<{ plaintext: string }>;
    getKey?(name: string): Promise<unknown>;
    /** §13f: whether this app's key exists (not audited as a failed decrypt). */
    hasKey?(input: { key: string }): Promise<boolean>;
    createKey?(input: { name: string; type: 'aes256-gcm'; description?: string }): Promise<unknown>;
  };
}

interface CryptoPrincipalLike {
  partition: string;
  capabilities: string[];
  actor: string;
}

/** What `'authkit.client'` is, as far as this package needs it (read structurally). */
export interface AuthkitClientLike {
  appCallTokens?():
    | { token(app: string): Promise<string>; reset?(app?: string): void }
    | undefined
    | null;
  appCallerVerifier?():
    | {
        verifyToken(token: string): Promise<{
          app: string;
          capabilities: string[];
          clientId?: string;
          expiresAt?: number;
        } | null>;
      }
    | null
    | undefined;
  /** §2e.B: publish this app's public key under `purpose` (background, retried; never rejects). */
  publishAppKey?(input: { purpose: string; jwk: OkpJwk }): Promise<void>;
  /** §2e.B: another app's public key for `purpose` (cached 5 min), or `null`. */
  appKey?(input: { app: string; purpose: string }): Promise<OkpJwk | null>;
}

/** The purpose payments' console-command key is published under in authkit's key directory. */
export const CONSOLE_KEY_PURPOSE = 'console:payments';

interface ContainerLike {
  hasBinding?(binding: string): boolean;
  make(binding: string): Promise<unknown>;
}

function isCryptoRuntime(value: unknown): value is CryptoRuntimeLike {
  const runtime = value as Partial<CryptoRuntimeLike> | undefined;
  return (
    !!runtime &&
    typeof runtime.partition === 'string' &&
    typeof runtime.operations?.encrypt === 'function' &&
    typeof runtime.operations?.decrypt === 'function'
  );
}

/** `'agora.crypto'` when `@adonis-agora/crypto` is in this app, else `undefined`. */
export async function detectCryptoRuntime(
  container: ContainerLike,
): Promise<CryptoRuntimeLike | undefined> {
  if (typeof container.hasBinding !== 'function' || !container.hasBinding('agora.crypto')) {
    return undefined;
  }
  const runtime = await container.make('agora.crypto');
  return isCryptoRuntime(runtime) ? runtime : undefined;
}

/** `'authkit.client'` when `@adonis-agora/authkit-client` is in this app, else `undefined`. */
export async function detectAuthkitClient(
  container: ContainerLike,
): Promise<AuthkitClientLike | undefined> {
  if (typeof container.hasBinding !== 'function' || !container.hasBinding('authkit.client')) {
    return undefined;
  }
  const client = (await container.make('authkit.client')) as AuthkitClientLike | undefined;
  return client && typeof client === 'object' ? client : undefined;
}

const keyCapability = (key: string) => `crypto:keys:manage:${key}`;

/** Whether an error from the crypto server says the key is already there. */
function isConflict(error: unknown): boolean {
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  return (
    code === 'conflict' ||
    status === 409 ||
    (error instanceof Error && /already exists/i.test(error.message))
  );
}

/**
 * Makes sure the console key exists in `partition` of an embedded crypto service (idempotent).
 * Answers what happened, for the boot log.
 */
async function ensureEmbeddedKey(
  service: NonNullable<CryptoRuntimeLike['service']>,
  partition: string,
  key: string,
): Promise<'exists' | 'created'> {
  if (await service.store.getKey(partition, key)) return 'exists';
  try {
    await service.createKey(
      { partition, capabilities: [keyCapability(key)], actor: 'payments:console' },
      {
        name: key,
        type: 'aes256-gcm',
        description: 'Seals federated payments console commands (@adonis-agora/payments).',
      },
    );
    return 'created';
  } catch (error) {
    // Another instance created it first.
    if (isConflict(error)) return 'exists';
    throw new Error(
      `could not create the crypto key ${key} in "${partition}" (${error instanceof Error ? error.message : String(error)}); run \`${createKeyHint(key, partition)}\``,
    );
  }
}

const PROBE_AAD = 'agora:console-commands:payments:probe';

/**
 * Makes sure a key exists at most once successfully: boot runs it (and logs a failure, never
 * failing the boot); until it has succeeded, the first command tries again.
 */
function keyEnsurer(ensure: () => Promise<string | undefined>): {
  run: () => Promise<string | undefined>;
  done: () => boolean;
} {
  let ok = false;
  // Concurrent callers share one attempt; a failure is retried by the next call (config's once()).
  let pending: Promise<string | undefined> | undefined;
  return {
    run: () => {
      pending ??= ensure().then(
        (line) => {
          ok = true;
          return line;
        },
        (error: unknown) => {
          pending = undefined;
          throw error;
        },
      );
      return pending;
    },
    done: () => ok,
  };
}

/** A cipher that, until the key is confirmed, tries to ensure it before its first use. */
function retryingKey(
  cipher: ConsoleCipher,
  ensure: { run: () => Promise<string | undefined>; done: () => boolean },
): ConsoleCipher {
  const before = async () => {
    if (!ensure.done()) await ensure.run().catch(() => undefined);
  };
  return {
    encrypt: async (input) => {
      await before();
      return cipher.encrypt(input);
    },
    decrypt: async (input) => {
      await before();
      return cipher.decrypt(input);
    },
  };
}

/** The line to run on the crypto server when this app cannot create its console key itself. */
export function createKeyHint(key: string, partition: string): string {
  return `node ace crypto:keys:create ${key} --type aes256-gcm --application ${partition}`;
}

// ── The owning app's side ───────────────────────────────────────────────────

/** How the owning app answers, once explicit options and the detected siblings are combined. */
export interface AnsweringAuth {
  secret?: ChannelSecret;
  crypto?: ConsoleCryptoOption;
  verifyTenant?: TenantVerifierInput;
  cryptoTokenOptional: boolean;
  /** Token mode sealed to the app's APP_KEY-derived key. */
  keys?: { publicKey: OkpJwk; privateKey: OkpJwk };
  /** One phrase per accepted mode, for the boot log (`crypto (auto, key console-payments)`). */
  modes: string[];
  /** Why a mode the app seemed to have did not resolve (added to the boot error). */
  notes: string[];
  /** Automatic crypto embedded here: makes sure the key exists; answers a log line. */
  ensureKey?: () => Promise<string | undefined>;
  /** Who checks a token (for the labels): `verifyTenant`, `authkit app-call, auto`, … */
  tokenSources?: string;
  /** Automatic crypto on a crypto tenant: checks the key once (logs through `logKey`). */
  checkKey?: () => Promise<void>;
  /** How the crypto mode was resolved, for the doctor. */
  cryptoSource?: 'explicit' | 'auto';
}

/** `consoleCommands` fields that pick the authentication (after `resolveConsoleCommands`). */
export interface AnsweringOptions {
  prefix: string;
  partition: string;
  crypto: ConsoleCryptoOption | false | undefined;
  verifyTenant: TenantVerifierInput | false | undefined;
  secret: ChannelSecret | undefined;
}

/**
 * The owning app's authentication: what `consoleCommands` names, else what the sibling libs offer
 * (crypto booted in this app; authkit's verifier of calls between apps; on a payments control
 * plane, its own `verifyTenant`). `appKey` seals token-mode commands without crypto.
 */
export function resolveAnsweringAuth(input: {
  option: AnsweringOptions;
  crypto?: CryptoRuntimeLike | undefined;
  authkit?: AuthkitClientLike | undefined;
  /** The payments control plane's own `verifyTenant` (§ fallback). */
  controlPlaneVerifyTenant?: TenantVerifierInput | undefined;
  /** `consoleCommandKeys(appKey, prefix)`, when an APP_KEY of 16+ characters is there. */
  keys?: (() => { publicKey: OkpJwk; privateKey: OkpJwk } | undefined) | undefined;
  /** Logs the console key's state on a crypto tenant (see `watchTenantConsoleKey`). */
  logKey?: ((note: { level: 'info' | 'warn'; line: string }) => void) | undefined;
}): AnsweringAuth {
  const { option } = input;
  const explicitCrypto = option.crypto ? option.crypto : undefined;
  const explicitVerify = option.verifyTenant ? option.verifyTenant : undefined;
  const explicit =
    explicitCrypto !== undefined || explicitVerify !== undefined || option.secret !== undefined;
  const modes: string[] = [];
  const notes: string[] = [];
  const auth: AnsweringAuth = { cryptoTokenOptional: false, modes, notes };

  if (option.secret !== undefined) {
    auth.secret = option.secret;
  }

  if (explicitCrypto) {
    auth.crypto = explicitCrypto;
    auth.cryptoSource = 'explicit';
  } else if (option.crypto === false) {
    notes.push('`crypto: false` turned the automatic crypto mode off');
  } else if (!explicit && input.crypto) {
    const runtime = input.crypto;
    const key = CONSOLE_CRYPTO_KEY;
    if (runtime.service) {
      const ensure = keyEnsurer(() => ensureAnsweringKey(runtime, key));
      auth.crypto = { cipher: retryingKey(runtime.operations as ConsoleCipher, ensure), key };
      auth.ensureKey = ensure.run;
    } else {
      // A crypto tenant: the key is checked once at boot (a dummy decrypt), and while that warned,
      // each command's own decrypt is the retry (no extra crypto call per command).
      const watch = watchTenantConsoleKey(
        runtime,
        (note) => (input.logKey ?? (() => undefined))(note),
        key,
      );
      auth.crypto = {
        cipher: { encrypt: (i) => runtime.operations.encrypt(i), decrypt: watch.decrypt },
        key,
      };
      auth.checkKey = watch.atBoot;
    }
    auth.cryptoSource = 'auto';
  }

  // Token mode: who verifies the console's token.
  let verify: TenantVerifierInput | undefined;
  let verifier = '';
  if (explicitVerify) {
    verify = explicitVerify;
    verifier = 'verifyTenant';
  } else if (option.verifyTenant !== false) {
    const found: Array<(request: TenantAuthRequest) => Promise<VerifiedTenant | null>> = [];
    const names: string[] = [];
    const appCalls = input.authkit?.appCallerVerifier?.();
    if (appCalls && typeof appCalls.verifyToken === 'function') {
      found.push(appCallVerifier(appCalls, option.partition));
      names.push('authkit app-call, auto');
    }
    if (input.controlPlaneVerifyTenant !== undefined) {
      found.push(resolveTenantVerifier(input.controlPlaneVerifyTenant));
      names.push("the control plane's verifyTenant");
    }
    if (found.length > 0) {
      verify = firstVerified(found);
      verifier = names.join(', ');
      auth.cryptoTokenOptional = true;
    }
  }
  if (verify !== undefined) {
    auth.verifyTenant = verify;
    auth.tokenSources = verifier;
    const keys = input.keys?.();
    if (keys) {
      auth.keys = keys;
    } else if (!auth.crypto) {
      notes.push(
        `a token verifier is available (${verifier}), but token mode needs an APP_KEY (commands are sealed to a key derived from it)`,
      );
    }
  }
  // The labels every Agora lib prints (§11), in this order, joined with " + ".
  if (auth.crypto) {
    const label = `crypto (${auth.cryptoSource === 'auto' ? 'auto, ' : ''}key ${auth.crypto.key ?? CONSOLE_CRYPTO_KEY})`;
    modes.push(
      auth.verifyTenant === undefined
        ? label
        : auth.cryptoTokenOptional
          ? `${label} + token checked when sent (${verifier})`
          : `${label} + token required (${verifier})`,
    );
  }
  if (auth.keys) modes.push(`token (${verifier}; sealed to ${shortKeyId(auth.keys.publicKey)})`);
  if (auth.secret !== undefined) modes.push('secret');
  return auth;
}

/**
 * §13a/§13e: whether this app publishes its command key in authkit's key directory. A published
 * key tells a console "reach me by token", so only when that is how this app is reached: no
 * crypto, or crypto whose commands must carry a token too (explicit crypto + verifyTenant).
 */
export function publishesAppKey(auth: AnsweringAuth): boolean {
  return (
    auth.keys !== undefined &&
    (!auth.crypto || (auth.verifyTenant !== undefined && !auth.cryptoTokenOptional))
  );
}

/** The first verifier that accepts the token wins. */
function firstVerified(
  verifiers: Array<(request: TenantAuthRequest) => Promise<VerifiedTenant | null>>,
): (request: TenantAuthRequest) => Promise<VerifiedTenant | null> {
  if (verifiers.length === 1) return verifiers[0]!;
  return async (request) => {
    for (const verify of verifiers) {
      try {
        const verified = await verify(request);
        if (verified) return verified;
      } catch {
        // Not this verifier's token: try the next one.
      }
    }
    return null;
  };
}

/**
 * An authkit app-call token as a verified console: its audience already binds it to this app, so
 * it answers for this app's `partition`; the caller app is recorded, and its capabilities (granted
 * in authkit to the console app on this app) cap the command.
 */
function appCallVerifier(
  verifier: NonNullable<ReturnType<NonNullable<AuthkitClientLike['appCallerVerifier']>>>,
  partition: string,
): (request: TenantAuthRequest) => Promise<VerifiedTenant | null> {
  return async ({ token }) => {
    if (typeof token !== 'string' || token === '') return null;
    const caller = await verifier.verifyToken(token);
    if (!caller || typeof caller.app !== 'string' || !Array.isArray(caller.capabilities)) {
      return null;
    }
    return {
      partition,
      capabilities: caller.capabilities.filter((c): c is string => typeof c === 'string'),
      clientId: caller.clientId ?? caller.app,
      app: caller.app,
      ...(typeof caller.expiresAt === 'number' ? { expiresAt: caller.expiresAt } : {}),
    };
  };
}

/** The owning app's console key where crypto is embedded here: created when missing. */
async function ensureAnsweringKey(
  runtime: CryptoRuntimeLike,
  key: string,
): Promise<string | undefined> {
  if (runtime.service) {
    const done = await ensureEmbeddedKey(runtime.service, runtime.partition, key);
    return done === 'created'
      ? `created the crypto key "${key}" in partition ${runtime.partition}`
      : undefined;
  }
  return undefined;
}

/** Thrown at boot when one side cannot authenticate console commands. */
export class ConsoleAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsoleAuthConfigError';
  }
}

/** Where every boot error points. */
export const CONSOLE_AUTH_DOCS =
  'https://davidecarvalho.github.io/agora/docs/payments/federated-console#authenticating-the-console';

/** What else was found, after the uniform message (why the automatic modes did not apply). */
const notesOf = (notes: readonly string[]) => (notes.length ? ` Note: ${notes.join('; ')}.` : '');

const DOCTOR_HINT = "Run `node ace agora:doctor` to see every Agora lib's console auth at once.";

/** A public key as the logs name it: a short id, never its material. */
export function shortKeyId(key: OkpJwk): string {
  return `key ${key.kid.slice(0, 8)}`;
}

/** The boot error of an app whose `consoleCommands` resolved no authentication. */
export function answeringAuthError(notes: readonly string[]): ConsoleAuthConfigError {
  return new ConsoleAuthConfigError(
    `[${PACKAGE}] consoleCommands needs authentication: install and boot @adonis-agora/crypto in this app (automatic, key ${CONSOLE_CRYPTO_KEY}), or configure authkit-client's \`service\` (automatic: the console uses an authkit app-call token; grant it payments:console:* on this app), or set consoleCommands.secret (shared with the console), or consoleCommands.verifyTenant (your own verifier; needs an APP_KEY). ${DOCTOR_HINT} Docs: ${CONSOLE_AUTH_DOCS}${notesOf(notes)}`,
  );
}

// ── The console's side ──────────────────────────────────────────────────────

/** `apps.<key>.controlPlane` fields that pick the authentication. */
export interface SendingOptions {
  secret?: ChannelSecret | undefined;
  crypto?: ConsoleCryptoOption | false | undefined;
  token?: HubTokenSource | false | undefined;
  publicKey?: OkpJwk | undefined;
}

/** How this console sends to one federated app. */
export interface SendingAuth {
  secret?: ChannelSecret;
  crypto?: ConsoleCryptoOption;
  token?: HubTokenSource;
  recipient?: () => Promise<OkpJwk>;
  /** The mode commands are sent in, for the boot log; `undefined` when none resolved. */
  mode: string | undefined;
  notes: string[];
  ensureKey?: () => Promise<string | undefined>;
  cryptoSource?: 'explicit' | 'auto';
  /**
   * §13a, no explicit field: crypto and authkit's key directory are both available, so the mode is
   * chosen per app at the first command (the app publishes a key only when it runs token mode),
   * then cached for 5 minutes. `decide()` answers which of the two to use now.
   */
  variants?: { crypto: SendingVariant; token: SendingVariant };
  decide?: () => Promise<'crypto' | 'token'>;
  /** Forget the decision (the app did not answer): the next command decides again. */
  invalidate?: () => void;
  /**
   * §13a/§13b: the auto-chosen token could not be minted. Logs §13b's warning (once per reason)
   * and keeps crypto as the decision for 5 minutes, so no command in that window mints again.
   */
  tokenUnavailable?: (reason: string, missingGrant: boolean) => void;
}

/** One way to send (the fields a channel takes). */
export interface SendingVariant {
  crypto?: ConsoleCryptoOption;
  token?: HubTokenSource;
  recipient?: () => Promise<OkpJwk>;
}

/** How long a per-app choice (§13a) or a failed app-call token (§13b) is kept before trying again. */
export const AUTO_RETRY_MS = 5 * 60_000;

/** How a required app-call token that could not be minted starts its error (§13a falls back on it). */
export const APP_CALL_TOKEN_FAILURE = 'could not get an authkit app-call token';

/**
 * Whether an app-call token failed because the console's client is not granted on the app (an
 * expected setup when crypto reaches the app): code `invalid_target`, or a message containing
 * `invalid_target`, "not granted" or "no grant". Anything else (`unauthorized_client`, `invalid_client`, network) is not.
 */
export function isMissingGrant(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code === 'invalid_target' || /invalid_target|not granted|no grant/i.test(message);
}

/** The grant that lets this console's app-call token act on `app`, for the errors (§13b). */
const grantHint = (app: string) =>
  `To attach it: grant the console's service client payments:console:* on "${app}" in authkit.`;

/**
 * §13b: in crypto mode the app-call token is optional. A token that cannot be minted (no grant,
 * `invalid_target`, authkit down) is left out, logged once, and tried again after 5 minutes.
 */
function optionalAppCallToken(
  tokens: { token(app: string): Promise<string>; reset?(app?: string): void },
  partition: string,
  onSkipped: (reason: string, missingGrant: boolean) => void,
): HubTokenSource {
  let retryAt = 0;
  return {
    get: async () => {
      if (Date.now() < retryAt) return '';
      try {
        return await tokens.token(partition);
      } catch (error) {
        retryAt = Date.now() + AUTO_RETRY_MS;
        onSkipped(error instanceof Error ? error.message : String(error), isMissingGrant(error));
        return '';
      }
    },
    reset: () => tokens.reset?.(partition),
  };
}

/** §13a token mode: the app-call token is required; a failure says which grant is missing. */
function requiredAppCallToken(
  tokens: { token(app: string): Promise<string>; reset?(app?: string): void },
  partition: string,
  app: string,
): HubTokenSource {
  return {
    get: async () => {
      try {
        return await tokens.token(partition);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // `reason` travels along, so §13a's fallback to crypto warns with the same words as §13b.
        throw Object.assign(
          new Error(`${APP_CALL_TOKEN_FAILURE} for "${app}": ${reason}. ${grantHint(app)}`),
          { reason, missingGrant: isMissingGrant(error) },
        );
      }
    },
    reset: () => tokens.reset?.(partition),
  };
}

/**
 * The console's authentication for the federated app whose partition is `partition`: what its
 * `controlPlane` names, else crypto (embedded in this app, or this app's crypto channel) and an
 * authkit app-call token.
 */
export function resolveSendingAuth(input: {
  plane: SendingOptions;
  partition: string;
  crypto?: CryptoRuntimeLike | undefined;
  authkit?: AuthkitClientLike | undefined;
  /** The entry's key, for messages (default: the partition). */
  app?: string | undefined;
  /** Where the console logs (§13b's warning). */
  log?: ((note: { level: 'info' | 'warn'; line: string }) => void) | undefined;
}): SendingAuth {
  const { plane, partition } = input;
  const app = input.app ?? partition;
  const explicitCrypto = plane.crypto ? plane.crypto : undefined;
  const explicitToken = plane.token ? plane.token : undefined;
  const explicit =
    explicitCrypto !== undefined || explicitToken !== undefined || plane.secret !== undefined;
  const notes: string[] = [];
  const auth: SendingAuth = { mode: undefined, notes };
  // §13b's warning, once per reason, whichever path found the token missing.
  const warned = new Set<string>();
  const warnNoToken = (reason: string, missingGrant: boolean) => {
    if (warned.has(reason)) return;
    if (warned.size < 100) warned.add(reason);
    try {
      input.log?.({
        // A missing grant is an expected setup (crypto is enough): info. Anything else: warn.
        level: missingGrant ? 'info' : 'warn',
        line: `[${PACKAGE}] console commands to "${app}": sending without an authkit app-call token (crypto only): ${reason}. ${grantHint(app)}`,
      });
    } catch {
      // a logger that throws must not block the command
    }
  };
  if (plane.secret !== undefined) auth.secret = plane.secret;

  if (explicitCrypto) {
    auth.crypto = explicitCrypto;
    auth.cryptoSource = 'explicit';
  } else if (plane.crypto === false) {
    notes.push('`crypto: false` turned the automatic crypto mode off');
  } else if (!explicit && input.crypto) {
    const runtime = input.crypto;
    const key = CONSOLE_CRYPTO_KEY;
    const service = runtime.service;
    const sealer = service ? embeddedSealer(service, partition) : tenantSealer(runtime, partition);
    const ensure = keyEnsurer(
      service
        ? async () =>
            (await ensureEmbeddedKey(service, partition, key)) === 'created'
              ? `created the crypto key "${key}" in partition ${partition}`
              : undefined
        : // A crypto tenant cannot look the key up in another app: a sealed probe checks the key
          // and the `crypto:seal` grant at once.
          async () => {
            try {
              await sealer.encrypt({ key, plaintext: 'probe', aad: PROBE_AAD, context: PROBE_AAD });
              return undefined;
            } catch (error) {
              throw new Error(
                `${error instanceof Error ? error.message : String(error)}. If the key is missing, run \`${createKeyHint(key, partition)}\` on the crypto server`,
              );
            }
          },
    );
    auth.crypto = { key, cipher: service ? retryingKey(sealer, ensure) : sealer };
    auth.cryptoSource = 'auto';
    auth.ensureKey = ensure.run;
  }

  if (plane.token === false) notes.push('`token: false` turned the automatic authkit token off');
  if (explicitToken) {
    auth.token = explicitToken;
  } else if (plane.token !== false && plane.secret === undefined) {
    // Automatic only without a `secret` (a pair that chose a shared secret keeps to it), and also
    // when `crypto` is explicit.
    const tokens = input.authkit?.appCallTokens?.();
    if (tokens && typeof tokens.token === 'function') {
      // With crypto the token is optional (§13b); without, it is the only proof (required).
      auth.token = auth.crypto
        ? optionalAppCallToken(tokens, partition, warnNoToken)
        : requiredAppCallToken(tokens, partition, app);
    }
  }
  const publicKey = plane.publicKey;
  // The app's command key: the explicit `publicKey`, else the one the app published in authkit's
  // key directory (§2e.B; fetched over authkit's authenticated API, never from Redis).
  const directory =
    !publicKey && typeof input.authkit?.appKey === 'function' ? input.authkit : undefined;
  if (publicKey) auth.recipient = async () => publicKey;
  else if (directory) {
    auth.recipient = async () => {
      const jwk = await directory.appKey!({ app: partition, purpose: CONSOLE_KEY_PURPOSE });
      if (!jwk || !isX25519PublicJwk(jwk)) {
        throw new Error(
          `authkit's key directory has no "${CONSOLE_KEY_PURPOSE}" key for "${partition}": ${noKeyHint}`,
        );
      }
      return jwk;
    };
  }

  const tokenFrom = explicitToken ? 'controlPlane.token' : 'authkit app-call, auto';
  // §13a: no explicit field, automatic crypto AND authkit's directory: decided per app, lazily.
  const tokens = input.authkit?.appCallTokens?.();
  if (
    auth.cryptoSource === 'auto' &&
    !explicitToken &&
    plane.token !== false &&
    directory &&
    auth.recipient &&
    tokens &&
    typeof tokens.token === 'function'
  ) {
    const key = auth.crypto!.key ?? CONSOLE_CRYPTO_KEY;
    auth.variants = {
      crypto: { crypto: auth.crypto!, ...(auth.token ? { token: auth.token } : {}) },
      token: { token: requiredAppCallToken(tokens, partition, app), recipient: auth.recipient },
    };
    let decided: { mode: 'crypto' | 'token'; at: number } | undefined;
    auth.decide = async () => {
      if (decided && Date.now() - decided.at < AUTO_RETRY_MS) return decided.mode;
      let published = false;
      try {
        const jwk = await directory.appKey!({ app: partition, purpose: CONSOLE_KEY_PURPOSE });
        published = !!jwk && isX25519PublicJwk(jwk);
      } catch {
        published = false;
      }
      decided = { mode: published ? 'token' : 'crypto', at: Date.now() };
      return decided.mode;
    };
    auth.invalidate = () => {
      decided = undefined;
    };
    auth.tokenUnavailable = (reason, missingGrant) => {
      warnNoToken(reason, missingGrant);
      decided = { mode: 'crypto', at: Date.now() };
    };
    auth.mode = `auto (authkit key directory if the app publishes one, else crypto (auto, key ${key}, partition ${partition}))`;
    return auth;
  }
  if (auth.crypto) {
    const key = auth.crypto.key ?? CONSOLE_CRYPTO_KEY;
    // The console names the partition it seals for (automatic mode); the app side never does.
    const label =
      auth.cryptoSource === 'auto'
        ? `crypto (auto, key ${key}, partition ${partition})`
        : `crypto (key ${key})`;
    auth.mode = `${label}${auth.token ? ` + token (${tokenFrom})` : ''}`;
  } else if (auth.token && auth.recipient) {
    // The directory key is fetched by the first command (cached), never at boot: the app may boot
    // after the console, and boot must not depend on authkit.
    auth.mode = publicKey
      ? `token (${tokenFrom}; sealed to ${shortKeyId(publicKey)})`
      : `token (${tokenFrom}, authkit key directory; sealed to the key the app publishes)`;
  } else if (explicitToken) {
    // An explicit token that cannot be sealed is a configuration error, even next to a secret.
    notes.push(`\`controlPlane.token\` is set, but without crypto it needs ${noKeyHint}`);
    delete auth.token;
  } else if (auth.secret !== undefined) {
    auth.mode = 'secret';
  } else {
    // A token that cannot be sealed is not sent: say so.
    if (auth.token) {
      notes.push(`a token (${tokenFrom}) is there, but without crypto it needs ${noKeyHint}`);
    }
    delete auth.token;
  }
  // A token alone (no seal) is never sent; with only a secret, the secret signs.
  if (!auth.crypto && !auth.recipient) delete auth.token;
  return auth;
}

/** Where the app's command key comes from, for the errors. */
const noKeyHint =
  "the app's `controlPlane.publicKey` (`node ace payments:console-key` in that app), which the app publishes in authkit's key directory by itself when it has authkit's `service` configured";

/** Encrypt-only: the console seals with the app's key in the crypto service embedded here. */
function embeddedSealer(
  service: NonNullable<CryptoRuntimeLike['service']>,
  partition: string,
): ConsoleCipher {
  const principal = {
    partition,
    capabilities: [`crypto:encrypt:${CONSOLE_CRYPTO_KEY}`],
    actor: 'payments:console',
  };
  return {
    encrypt: (input) => service.encrypt(principal, input),
    decrypt: async () => {
      throw new Error('the console only seals commands');
    },
  };
}

/** Encrypt-only: the console asks its crypto server to seal with the app's key (`crypto:seal`). */
function tenantSealer(runtime: CryptoRuntimeLike, partition: string): ConsoleCipher {
  return {
    encrypt: async (input) => {
      try {
        return await runtime.operations.encrypt({ ...input, partition });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `the crypto server did not seal for "${partition}" (${message}). Grant this console's crypto client \`crypto:seal:console-*\`; a crypto server without sealing for another app needs an upgrade of @adonis-agora/crypto, or configure \`crypto\` explicitly on apps.<key>.controlPlane`,
        );
      }
    },
    decrypt: async () => {
      throw new Error('the console only seals commands');
    },
  };
}

/** The boot error of a federated app this console may act on but cannot authenticate to. */
export function sendingAuthError(key: string, notes: readonly string[]): ConsoleAuthConfigError {
  const entry = `payments_dashboard.apps["${key}"]`;
  return new ConsoleAuthConfigError(
    `[${PACKAGE}] ${entry}: commands to this app need authentication: boot @adonis-agora/crypto in this app (automatic), or set ${entry}.controlPlane.secret, or ${entry}.controlPlane.token — or actions: false to only browse it. ${DOCTOR_HINT}${notesOf(notes)}`,
  );
}
