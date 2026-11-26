import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DashboardProvider from '../../providers/dashboard_provider.js';
import PaymentsProvider from '../../providers/payments_provider.js';
import type { PaymentsDashboardConfig } from '../../src/dashboard/define_config.js';
import type { PaymentsConfig } from '../../src/define_config.js';
import {
  checkConsoleCommands,
  checkConsoleCommandsKey,
} from '../../src/doctor/console_commands.js';
import {
  type AuthkitClientLike,
  type CryptoRuntimeLike,
  publishesAppKey,
  resolveAnsweringAuth,
  resolveSendingAuth,
} from '../../src/federation/auto_auth.js';
import { consoleCommandKeys, FederatedPaymentsConsole } from '../../src/federation/console.js';
import {
  checkTenantConsoleKey,
  classifyConsoleKeyError,
} from '../../src/federation/console_key_check.js';
import { resetPayments, setWebhookDispatcher } from '../../src/services/main.js';
import { FakePaymentsDriver } from '../../src/testing/fake_payments_driver.js';
import { InMemoryBillingStore } from '../../src/testing/in_memory_billing_store.js';
import { RedisBus } from './redis_bus.js';

/**
 * Zero configuration when the libs are together: with @adonis-agora/crypto booted in the apps, the
 * console and the owning app agree on the `console-payments` key by themselves, authkit's calls
 * between apps add a token, and a setup with neither fails the boot with what to add.
 */

const KEY = 'console-payments';

type Principal = { partition: string; capabilities: string[]; actor: string };

/** One crypto server: keys per partition, every call checked against the caller's capabilities. */
class FakeCrypto {
  readonly keys = new Map<string, Buffer>();
  readonly created: string[] = [];

  /** Crypto's rule: exact, `*`, or a prefix wildcard (`crypto:decrypt:console-*`). */
  #need(principal: Principal, capability: string): void {
    const allowed = principal.capabilities.some(
      (c) => c === capability || (c.endsWith('*') && capability.startsWith(c.slice(0, -1))),
    );
    if (!allowed) {
      throw Object.assign(new Error(`missing capability ${capability}`), { code: 'forbidden' });
    }
  }

  readonly service: NonNullable<CryptoRuntimeLike['service']> = {
    encrypt: async (principal, { key, plaintext, aad }) => {
      this.#need(principal, `crypto:encrypt:${key}`);
      return { ciphertext: this.seal(principal.partition, key, plaintext, aad) };
    },
    decrypt: async (principal, { key, ciphertext, aad }) => {
      this.#need(principal, `crypto:decrypt:${key}`);
      return { plaintext: this.open(principal.partition, key, ciphertext, aad) };
    },
    createKey: async (principal, { name }) => {
      this.#need(principal, `crypto:keys:manage:${name}`);
      const id = `${principal.partition}/${name}`;
      if (this.keys.has(id)) {
        throw Object.assign(new Error(`key "${name}" already exists`), { code: 'conflict' });
      }
      this.keys.set(id, randomBytes(32));
      this.created.push(id);
      return { name };
    },
    store: {
      getKey: async (partition, name) => (this.keys.has(`${partition}/${name}`) ? {} : null),
    },
  };

  seal(partition: string, key: string, plaintext: string, aad?: string): string {
    const secret = this.keys.get(`${partition}/${key}`);
    if (!secret) throw new Error(`no key named ${key} in ${partition}`);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', secret, iv);
    cipher.setAAD(Buffer.from(aad ?? ''));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `agora:ct1:${key}:1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
  }

  open(partition: string, key: string, ciphertext: string, aad?: string): string {
    const secret = this.keys.get(`${partition}/${key}`);
    if (!secret) throw new Error(`no key named ${key} in ${partition}`);
    const raw = Buffer.from(ciphertext.split(':').pop()!, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', secret, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad ?? ''));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }

  /** Crypto embedded in an app (the Hub): `runtime.service` and its own operations. */
  embedded(partition: string): CryptoRuntimeLike {
    const self: Principal = { partition, capabilities: ['crypto:*'], actor: 'app' };
    return {
      topology: 'control-plane',
      partition,
      service: this.service,
      operations: {
        encrypt: (input) => this.service.encrypt(self, input),
        decrypt: (input) => this.service.decrypt(self, input),
      },
    };
  }

  /** An app that is a crypto tenant: its token's capabilities, over its crypto channel. */
  tenant(partition: string, capabilities: string[]): CryptoRuntimeLike {
    const principal: Principal = { partition, capabilities, actor: 'tenant' };
    return {
      topology: 'tenant',
      partition,
      operations: {
        encrypt: async ({ partition: other, ...input }) => {
          if (other !== undefined && other !== partition) {
            // Sealing for another app: the seal-only capability, encrypt only.
            this.#need(principal, `crypto:seal:${input.key}`);
            return { ciphertext: this.seal(other, input.key, input.plaintext, input.aad) };
          }
          return this.service.encrypt(principal, input);
        },
        // §2e.A: an app always decrypts its own `console-*` keys, without a grant.
        decrypt: (input) =>
          this.service.decrypt(
            input.key.startsWith('console-')
              ? {
                  ...principal,
                  capabilities: [...principal.capabilities, `crypto:decrypt:${input.key}`],
                }
              : principal,
            input,
          ),
        getKey: async (name) => {
          if (!this.keys.has(`${partition}/${name}`)) throw new Error('not found');
          return {};
        },
        createKey: (input) => this.service.createKey(principal, input),
      },
    };
  }
}

/** authkit's calls between apps: tokens per target, checked by the target. */
function fakeAuthkit(options: {
  caller?: string;
  grants?: Record<string, string[]>;
  tokens?: boolean;
  verifier?: boolean;
}): AuthkitClientLike & { issued: string[]; resets: number } {
  const issued: string[] = [];
  const client = {
    issued,
    resets: 0,
    appCallTokens: () =>
      options.tokens === false
        ? undefined
        : {
            token: async (app: string) => {
              issued.push(app);
              return `app-call:${options.caller ?? 'hub'}->${app}`;
            },
            reset: () => {
              client.resets += 1;
            },
          },
    appCallerVerifier: () =>
      options.verifier === false
        ? null
        : {
            verifyToken: async (token: string) => {
              const match = /^app-call:(.+)->(.+)$/.exec(token);
              if (!match) return null;
              return {
                app: match[1]!,
                capabilities: options.grants?.[match[1]!] ?? [],
                clientId: `${match[1]}-client`,
                expiresAt: Date.now() + 60_000,
              };
            },
          },
  };
  return client;
}

interface Logged {
  info: string[];
  warn: string[];
}

/** An `ApplicationService` stand-in with named bindings and a config per key. */
function fakeApp(input: {
  config: Record<string, unknown>;
  bindings?: Record<string, unknown>;
  environment?: string;
  logged: Logged;
  router?: unknown;
}): ApplicationService {
  const bindings = new Map<unknown, () => Promise<unknown> | unknown>();
  for (const [name, value] of Object.entries(input.bindings ?? {})) bindings.set(name, () => value);
  bindings.set('logger', () => ({
    info: (line: string) => input.logged.info.push(line),
    warn: (line: string) => input.logged.warn.push(line),
  }));
  bindings.set('router', () => input.router ?? { post: () => ({ as: () => {} }) });
  return {
    config: { get: (key: string, fallback?: unknown) => input.config[key] ?? fallback },
    booted: async (callback: () => Promise<void>) => callback(),
    getEnvironment: () => input.environment ?? 'web',
    inTest: true,
    inProduction: false,
    makePath: (...parts: string[]) => `/nonexistent/${parts.join('/')}`,
    container: {
      hasBinding: (name: unknown) => bindings.has(name),
      singleton: (token: unknown, factory: () => unknown) => {
        let built: { value: unknown } | undefined;
        bindings.set(token, async () => {
          if (!built) built = { value: await factory() };
          return built.value;
        });
      },
      bindValue: (token: unknown, value: unknown) => bindings.set(token, () => value),
      alias: (alias: unknown, target: unknown) =>
        bindings.set(alias, () => bindings.get(target)!()),
      make: async (token: unknown) => {
        const factory = bindings.get(token);
        if (!factory) throw new Error(`nothing bound for ${String(token)}`);
        return factory();
      },
    },
  } as unknown as ApplicationService;
}

const providers: PaymentsProvider[] = [];
const dashboards: DashboardProvider[] = [];
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.shutdown();
  for (const dashboard of dashboards.splice(0)) await dashboard.shutdown();
  resetPayments();
  setWebhookDispatcher(undefined);
});

/** The owning app ("et"), booted through its real provider in the web environment. */
async function bootOwningApp(input: {
  bus: RedisBus;
  consoleCommands: PaymentsConfig['consoleCommands'];
  crypto?: CryptoRuntimeLike;
  authkit?: AuthkitClientLike;
  appKey?: string;
  extra?: Partial<PaymentsConfig>;
  environment?: string;
}) {
  const logged: Logged = { info: [], warn: [] };
  const store = new InMemoryBillingStore();
  await store.savePayment({
    gatewayId: 'pay_1',
    provider: 'fake',
    status: 'paid',
    amount: 1000,
    currency: 'BRL',
  });
  const driver = new FakePaymentsDriver({ provider: 'fake' });
  const config: PaymentsConfig = {
    providers: { fake: async () => driver },
    billing: { store: () => store },
    consoleCommands: input.consoleCommands,
    ...input.extra,
  };
  const app = fakeApp({
    config: { payments: config, ...(input.appKey ? { 'app.appKey': input.appKey } : {}) },
    bindings: {
      redis: { connection: () => input.bus.connection() },
      ...(input.crypto ? { 'agora.crypto': input.crypto } : {}),
      ...(input.authkit ? { 'authkit.client': input.authkit } : {}),
    },
    ...(input.environment ? { environment: input.environment } : {}),
    logged,
  });
  const provider = new PaymentsProvider(app);
  providers.push(provider);
  provider.register();
  await provider.boot();
  await provider.ready();
  return { logged, store, driver };
}

/** The Hub's console, booted through its real provider in the web environment. */
async function bootHub(input: {
  apps: PaymentsDashboardConfig['apps'];
  bus: RedisBus;
  crypto?: CryptoRuntimeLike;
  authkit?: AuthkitClientLike;
  environment?: string;
}) {
  const logged: Logged = { info: [], warn: [] };
  const routes: Array<{ method: string; pattern: string; handler: (ctx: unknown) => unknown }> = [];
  const register = (method: string) => (pattern: string, handler: (ctx: unknown) => unknown) => {
    routes.push({ method, pattern, handler });
    return { as: () => undefined };
  };
  const config: PaymentsDashboardConfig = {
    appLabel: 'Hub',
    authorize: () => ({ allowed: true, apps: '*' }),
    apps: input.apps,
  };
  const app = fakeApp({
    config: { payments_dashboard: config },
    bindings: {
      redis: { connection: () => input.bus.connection() },
      ...(input.crypto ? { 'agora.crypto': input.crypto } : {}),
      ...(input.authkit ? { 'authkit.client': input.authkit } : {}),
    },
    ...(input.environment ? { environment: input.environment } : {}),
    router: { get: register('get'), post: register('post'), route: register('route') },
    logged,
  });
  const dashboard = new DashboardProvider(app);
  dashboards.push(dashboard);
  await dashboard.boot();
  const refund = async (idempotencyKey: string) => {
    const route = routes.find((r) => r.pattern.endsWith('/payments/:gatewayId/refund'))!;
    const recorded: { status?: number; body?: unknown } = {};
    await route.handler(refundCtx(recorded, idempotencyKey));
    return recorded;
  };
  return { logged, refund };
}

function refundCtx(recorded: { status?: number; body?: unknown }, idempotencyKey: string) {
  return {
    auth: { user: { email: 'ops@hub.example' } },
    params: { gatewayId: 'pay_1' },
    response: {
      getHeader: () => undefined,
      status(code: number) {
        recorded.status = code;
        return this;
      },
      json(body: unknown) {
        recorded.body = body;
        return this;
      },
      header() {
        return this;
      },
      send(body: unknown) {
        recorded.body = body;
      },
    },
    request: {
      qs: () => ({ app: 'et' }),
      body: () => ({}),
      url: () => '/payments/api',
      method: () => 'POST',
      header: (name: string) => (name === 'idempotency-key' ? idempotencyKey : undefined),
      headers: () => ({ 'idempotency-key': idempotencyKey }),
    },
  };
}

const commandsOn = (bus: RedisBus) =>
  bus.published
    .filter((p) => p.channel === 'et-payments-console')
    .map((p) => p.message)
    .join('\n');

describe('automatic crypto: nothing to configure', () => {
  it('the Hub (crypto embedded) and an app (its crypto tenant) agree on console-payments by themselves', async () => {
    const bus = new RedisBus();
    const crypto = new FakeCrypto();
    // The app: a crypto tenant of the Hub with no grant at all (§2e.A).
    const owning = await bootOwningApp({
      bus,
      consoleCommands: { prefix: 'et', actions: ['refund'] },
      crypto: crypto.tenant('et', []),
    });
    expect(owning.logged.info.join('\n')).toMatch(
      /console commands: crypto \(auto, key console-payments\); actions on$/m,
    );
    // The key is not there yet: ONE info line (the crypto server creates it on the first seal).
    expect(owning.logged.warn).toEqual([]);
    expect(owning.logged.info.join('\n')).toMatch(
      /"console-payments" does not exist in partition et yet; the crypto server creates it on the console's first command/,
    );

    // The Hub, crypto embedded: creates the key in "et" at boot, seals with it.
    const hub = await bootHub({
      bus,
      crypto: crypto.embedded('hub'),
      apps: { et: { store: owning.store, controlPlane: { prefix: 'et' } } },
    });
    expect(crypto.created).toEqual([`et/${KEY}`]);
    expect(hub.logged.info.join('\n')).toMatch(
      /console commands to "et": crypto \(auto, key console-payments, partition et\)$/m,
    );

    const answer = await hub.refund('auto-crypto-0001');
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(owning.driver.refundCalls).toEqual([{ paymentGatewayId: 'pay_1' }]);
    // Nothing readable on Redis.
    expect(commandsOn(bus)).toContain('agora:ct1:console-payments:');
    expect(commandsOn(bus)).not.toContain('pay_1');
  });

  it('an app with crypto embedded creates its own key', async () => {
    const bus = new RedisBus();
    const crypto = new FakeCrypto();
    const owning = await bootOwningApp({
      bus,
      consoleCommands: { prefix: 'et' },
      crypto: crypto.embedded('et'),
    });
    expect(crypto.created).toEqual([`et/${KEY}`]);
    expect(owning.logged.info).toContain(
      '[@adonis-agora/payments] console commands: created the crypto key "console-payments" in partition et',
    );
  });

  it('a crypto-tenant app with crypto:keys:manage:console-* creates the key through its channel', async () => {
    const bus = new RedisBus();
    const crypto = new FakeCrypto();
    const owning = await bootOwningApp({
      bus,
      consoleCommands: { prefix: 'et' },
      crypto: crypto.tenant('et', ['crypto:decrypt:console-*', 'crypto:keys:manage:console-*']),
    });
    expect(crypto.created).toEqual([`et/${KEY}`]);
    expect(owning.logged.warn).toEqual([]);
  });

  it('a console that is a crypto tenant seals through its crypto server (crypto:seal:console-*)', async () => {
    const bus = new RedisBus();
    const crypto = new FakeCrypto();
    const owning = await bootOwningApp({
      bus,
      consoleCommands: { prefix: 'et', actions: ['refund'] },
      crypto: crypto.embedded('et'),
    });
    const hub = await bootHub({
      bus,
      crypto: crypto.tenant('hub', ['crypto:seal:console-*']),
      apps: { et: { store: owning.store, controlPlane: { prefix: 'et' } } },
    });
    expect((await hub.refund('seal-0001')).status).toBe(200);

    // Without the grant (or a crypto server too old for it), the answer says what to do.
    const bus2 = new RedisBus();
    await bootOwningApp({
      bus: bus2,
      consoleCommands: { prefix: 'et', actions: ['refund'] },
      crypto: crypto.embedded('et'),
    });
    const denied = await bootHub({
      bus: bus2,
      crypto: crypto.tenant('hub', []),
      apps: { et: { store: owning.store, controlPlane: { prefix: 'et' } } },
    });
    const answer = await denied.refund('seal-0002');
    expect(answer.status).toBe(503);
    expect(JSON.stringify(answer.body)).toMatch(/crypto:seal:console-\*/);
    expect(JSON.stringify(answer.body)).toMatch(/upgrade of @adonis-agora\/crypto/);
  });

  it('uses the federated app partition, not its key, when they differ', async () => {
    const crypto = new FakeCrypto();
    const auth = resolveSendingAuth({
      plane: {},
      partition: 'entre-textos',
      crypto: crypto.embedded('hub'),
    });
    expect(auth.mode).toBe('crypto (auto, key console-payments, partition entre-textos)');
    await auth.ensureKey!();
    expect(crypto.created).toEqual(['entre-textos/console-payments']);
  });
});

describe('explicit options win', () => {
  const crypto = new FakeCrypto();
  const runtime = crypto.embedded('et');
  const option = { prefix: 'et', partition: 'et' };

  it('crypto: false turns the automatic mode off', () => {
    const auth = resolveAnsweringAuth({
      option: { ...option, crypto: false, verifyTenant: undefined, secret: undefined },
      crypto: runtime,
    });
    expect(auth.modes).toEqual([]);
    expect(auth.notes.join()).toMatch(/crypto: false/);
    const sending = resolveSendingAuth({
      plane: { crypto: false },
      partition: 'et',
      crypto: runtime,
    });
    expect(sending.mode).toBeUndefined();
  });

  it('an explicit secret is used as given, with no automatic crypto on top', () => {
    const auth = resolveAnsweringAuth({
      option: { ...option, crypto: undefined, verifyTenant: undefined, secret: 's'.repeat(16) },
      crypto: runtime,
    });
    expect(auth.modes).toEqual(['secret']);
    const sending = resolveSendingAuth({
      plane: { secret: 's'.repeat(16) },
      partition: 'et',
      crypto: runtime,
    });
    expect(sending.mode).toBe('secret');
    expect(sending.crypto).toBeUndefined();
  });

  it('an explicit cipher (a KMS) with its own ciphertext format', () => {
    const kms = {
      encrypt: async ({ plaintext }: { plaintext: string }) => ({ ciphertext: `kms:${plaintext}` }),
      decrypt: async ({ ciphertext }: { ciphertext: string }) => ({
        plaintext: ciphertext.slice(4),
      }),
    };
    const auth = resolveAnsweringAuth({
      option: {
        ...option,
        crypto: { cipher: kms, key: 'alias/console', owns: (c) => c.startsWith('kms:') },
        verifyTenant: undefined,
        secret: undefined,
      },
      crypto: runtime,
    });
    expect(auth.modes).toEqual(['crypto (key alias/console)']);
    expect(auth.cryptoSource).toBe('explicit');
  });
});

describe('automatic token from authkit (calls between apps)', () => {
  it('combines with automatic crypto: sealed and carrying the app-call token, capped by its grant', async () => {
    const bus = new RedisBus();
    const crypto = new FakeCrypto();
    const owning = await bootOwningApp({
      bus,
      consoleCommands: { prefix: 'et', actions: ['refund'] },
      crypto: crypto.embedded('et'),
      authkit: fakeAuthkit({ grants: { hub: ['payments:console:*'] } }),
    });
    expect(owning.logged.info.join('\n')).toMatch(
      /crypto \(auto, key console-payments\) \+ token checked when sent \(authkit app-call, auto\)/,
    );
    const authkit = fakeAuthkit({ caller: 'hub' });
    const hub = await bootHub({
      bus,
      crypto: crypto.embedded('hub'),
      authkit,
      apps: { et: { store: owning.store, controlPlane: { prefix: 'et' } } },
    });
    expect(hub.logged.info.join('\n')).toMatch(/\+ token \(authkit app-call, auto\)/);
    expect((await hub.refund('token-0001')).status).toBe(200);
    expect(authkit.issued).toContain('et');
    // The token never travels readable.
    expect(bus.wire).not.toContain('app-call:');
    // The audit names the calling app.
    const [audit] = await owning.store.listAuditEvents({ action: 'payment.refunded' });
    expect(audit?.actor).toMatch(/app hub/);
  });

  it("the token's grant caps the command: read-only in authkit cannot refund", async () => {
    const bus = new RedisBus();
    const crypto = new FakeCrypto();
    const owning = await bootOwningApp({
      bus,
      consoleCommands: { prefix: 'et', actions: ['refund'] },
      crypto: crypto.embedded('et'),
      authkit: fakeAuthkit({ grants: { hub: ['payments:console:read'] } }),
    });
    const hub = await bootHub({
      bus,
      crypto: crypto.embedded('hub'),
      authkit: fakeAuthkit({ caller: 'hub' }),
      apps: { et: { store: owning.store, controlPlane: { prefix: 'et' } } },
    });
    const answer = await hub.refund('token-0002');
    expect(answer.status).toBe(403);
    expect((answer.body as { error: string }).error).toMatch(
      /token lacks "payments:console:refund"/,
    );
    expect(owning.driver.refundCalls).toHaveLength(0);
  });

  it('without crypto, an app-call token is sealed to the APP_KEY key (publicKey on the console)', async () => {
    const bus = new RedisBus();
    const appKey = 'app-key-of-entre-textos-0123456789';
    const owning = await bootOwningApp({
      bus,
      appKey,
      consoleCommands: { prefix: 'et', actions: ['refund'] },
      authkit: fakeAuthkit({ grants: { hub: ['payments:console:*'] } }),
    });
    // Never the public key's material: its 8-character id, in the label.
    const { d: _priv, ...pub } = consoleCommandKeys(appKey, 'et').publicKey;
    expect(owning.logged.info.join('\n')).toContain(
      `token (authkit app-call, auto; sealed to key ${pub.kid.slice(0, 8)})`,
    );
    expect(owning.logged.info.join('\n')).toContain(`sealed to key ${pub.kid.slice(0, 8)}`);
    expect(owning.logged.info.join('\n')).not.toContain(pub.x);
    const { d: _d, ...publicKey } = consoleCommandKeys(appKey, 'et').publicKey;
    const hub = await bootHub({
      bus,
      authkit: fakeAuthkit({ caller: 'hub' }),
      apps: { et: { store: owning.store, controlPlane: { prefix: 'et', publicKey } } },
    });
    expect((await hub.refund('token-0003')).status).toBe(200);
  });

  it('token: false and verifyTenant: false turn the detection off', () => {
    const authkit = fakeAuthkit({});
    const sending = resolveSendingAuth({
      plane: { token: false, secret: 's'.repeat(16) },
      partition: 'et',
      authkit,
    });
    expect(sending.token).toBeUndefined();
    const answering = resolveAnsweringAuth({
      option: {
        prefix: 'et',
        partition: 'et',
        crypto: undefined,
        verifyTenant: false,
        secret: undefined,
      },
      authkit,
      keys: () => consoleCommandKeys('app-key-of-entre-textos-0123456789', 'et'),
    });
    expect(answering.modes).toEqual([]);
  });
});

describe('fallback verifyTenant on a control plane', () => {
  it("uses the control plane's own verifier, which a tenant's token does not pass as a console", () => {
    const auth = resolveAnsweringAuth({
      option: {
        prefix: 'et',
        partition: 'et',
        crypto: undefined,
        verifyTenant: undefined,
        secret: undefined,
      },
      controlPlaneVerifyTenant: () => ({ partition: 'et', capabilities: ['payments:refund'] }),
      keys: () => consoleCommandKeys('app-key-of-entre-textos-0123456789', 'et'),
    });
    expect(auth.modes).toEqual([
      `token (the control plane's verifyTenant; sealed to key ${consoleCommandKeys('app-key-of-entre-textos-0123456789', 'et').publicKey.kid.slice(0, 8)})`,
    ]);
    expect(auth.verifyTenant).toBeDefined();
  });
});

describe('misconfiguration fails at boot', () => {
  it('the owning app: consoleCommands with no way to authenticate', async () => {
    await expect(
      bootOwningApp({
        bus: new RedisBus(),
        consoleCommands: { prefix: 'et', actions: ['refund'] },
      }),
    ).rejects.toThrow(
      /^\[@adonis-agora\/payments\] consoleCommands needs authentication: install and boot @adonis-agora\/crypto in this app \(automatic, key console-payments\), or configure authkit-client's `service` \(automatic: the console uses an authkit app-call token; grant it payments:console:\* on this app\), or set consoleCommands\.secret \(shared with the console\), or consoleCommands\.verifyTenant \(your own verifier; needs an APP_KEY\)\. Run `node ace agora:doctor` to see every Agora lib's console auth at once\. Docs: https:\/\/\S+$/,
    );
  });

  it('the owning app: crypto: false says so in the error', async () => {
    await expect(
      bootOwningApp({
        bus: new RedisBus(),
        consoleCommands: { prefix: 'et', crypto: false },
        crypto: new FakeCrypto().embedded('et'),
      }),
    ).rejects.toThrow(/crypto: false/);
  });

  it('never in an ace command (no channel starts there)', async () => {
    await expect(
      bootOwningApp({
        bus: new RedisBus(),
        consoleCommands: { prefix: 'et' },
        environment: 'console',
      }),
    ).resolves.toBeDefined();
  });

  it('the console: an app it may act on, with no way to authenticate', async () => {
    await expect(
      bootHub({
        bus: new RedisBus(),
        apps: { et: { store: new InMemoryBillingStore(), controlPlane: { prefix: 'et' } } },
      }),
    ).rejects.toThrow(
      /^\[@adonis-agora\/payments\] payments_dashboard\.apps\["et"\]: commands to this app need authentication: boot @adonis-agora\/crypto in this app \(automatic\), or set payments_dashboard\.apps\["et"\]\.controlPlane\.secret, or payments_dashboard\.apps\["et"\]\.controlPlane\.token — or actions: false to only browse it\. Run `node ace agora:doctor` to see every Agora lib's console auth at once\.$/,
    );
  });

  it('the console: a browse-only app boots, and so does an ace command', async () => {
    const browse = await bootHub({
      bus: new RedisBus(),
      apps: {
        et: { store: new InMemoryBillingStore(), controlPlane: { prefix: 'et' }, actions: false },
      },
    });
    expect(browse.logged.info.join('\n')).toMatch(/browse-only/);
    await expect(
      bootHub({
        bus: new RedisBus(),
        environment: 'console',
        apps: { et: { store: new InMemoryBillingStore(), controlPlane: { prefix: 'et' } } },
      }),
    ).resolves.toBeDefined();
  });

  it('the console: an authkit token with no crypto and no publicKey cannot be sealed', () => {
    const auth = resolveSendingAuth({ plane: {}, partition: 'et', authkit: fakeAuthkit({}) });
    expect(auth.mode).toBeUndefined();
    expect(auth.notes.join()).toMatch(/controlPlane\.publicKey/);
  });
});

describe('the federated console without the provider', () => {
  it('resolves automatic crypto lazily on the first command too', async () => {
    const crypto = new FakeCrypto();
    const hub = new FederatedPaymentsConsole(
      { et: { store: new InMemoryBillingStore(), controlPlane: { prefix: 'et' }, partition: 'p' } },
      {
        redis: async () => new RedisBus().connection(),
        crypto: async () => crypto.embedded('hub'),
      },
    );
    expect((await hub.authOf('et'))?.mode).toBe('crypto (auto, key console-payments, partition p)');
    await hub.close();
  });
});

describe('doctor: console commands', () => {
  const doctorApp = (config: Record<string, unknown>, bindings: Record<string, unknown> = {}) =>
    fakeApp({ config, bindings, logged: { info: [], warn: [] } });

  it('reports the mode of each side, and an error when one has none', async () => {
    const crypto = new FakeCrypto();
    const ok = await checkConsoleCommands(
      doctorApp(
        {
          payments: { consoleCommands: { prefix: 'et' } },
          payments_dashboard: {
            apps: { other: { store: new InMemoryBillingStore(), controlPlane: { prefix: 'o' } } },
          },
        },
        { 'agora.crypto': crypto.embedded('hub') },
      ),
    );
    expect(ok.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(ok[0]?.message).toMatch(/crypto \(auto, key console-payments/);

    const bad = await checkConsoleCommands(
      doctorApp({
        payments: { consoleCommands: { prefix: 'et' } },
        payments_dashboard: {
          apps: { other: { store: new InMemoryBillingStore(), controlPlane: { prefix: 'o' } } },
        },
      }),
    );
    expect(bad.map((r) => r.status)).toEqual(['error', 'error']);
    expect(bad[0]?.fix).toMatch(/consoleCommands\.secret/);
    expect(bad[1]?.fix).toMatch(/actions: false/);
  });

  it('deep: probes the key on both sides', async () => {
    const crypto = new FakeCrypto();
    const missing = await checkConsoleCommandsKey(
      doctorApp(
        { payments: { consoleCommands: { prefix: 'et' } } },
        { 'agora.crypto': crypto.tenant('et', []) },
      ),
    );
    // Missing on a tenant: ok, with a note (the crypto server provisions it on the first seal).
    expect(missing[0]?.status).toBe('ok');
    expect(missing[0]?.message).toContain('does not exist yet');

    const hub = await checkConsoleCommandsKey(
      doctorApp(
        {
          payments_dashboard: {
            apps: { et: { store: new InMemoryBillingStore(), controlPlane: { prefix: 'et' } } },
          },
        },
        { 'agora.crypto': crypto.embedded('hub') },
      ),
    );
    expect(hub).toEqual([{ status: 'ok', message: 'apps["et"]: seals with console-payments.' }]);
    // The key the Hub created is the one the app now finds.
    const app = await checkConsoleCommandsKey(
      doctorApp(
        { payments: { consoleCommands: { prefix: 'et' } } },
        { 'agora.crypto': crypto.tenant('et', ['crypto:decrypt:console-*']) },
      ),
    );
    expect(app[0]).toMatchObject({ status: 'ok', message: expect.stringMatching(/exists/) });
  });
});

describe('uniform details (§10)', () => {
  it('a key that could not be created at boot is tried again on first use', async () => {
    const crypto = new FakeCrypto();
    const runtime = crypto.embedded('et');
    const service = runtime.service!;
    const create = service.createKey;
    let failures = 1;
    service.createKey = async (principal, input) => {
      if (failures-- > 0) throw new Error('crypto store unavailable');
      return create(principal, input);
    };
    const auth = resolveAnsweringAuth({
      option: {
        prefix: 'et',
        partition: 'et',
        crypto: undefined,
        verifyTenant: undefined,
        secret: undefined,
      },
      crypto: runtime,
    });
    await expect(auth.ensureKey!()).rejects.toThrow(/unavailable/);
    const cipher = auth.crypto!
      .cipher as import('../../src/federation/redis_channel.js').ConsoleCipher;
    await expect(
      cipher.encrypt({ key: 'console-payments', plaintext: 'x', aad: 'a' }),
    ).resolves.toMatchObject({ ciphertext: expect.stringMatching(/^agora:ct1:console-payments:/) });
    expect(crypto.created).toEqual(['et/console-payments']);
  });

  it('the boot log joins the modes with " + "', async () => {
    const bus = new RedisBus();
    const owning = await bootOwningApp({
      bus,
      appKey: 'app-key-of-entre-textos-0123456789',
      consoleCommands: { prefix: 'et', secret: 's'.repeat(16) },
      authkit: fakeAuthkit({}),
    });
    expect(owning.logged.info).toContain(
      `[@adonis-agora/payments] console commands: token (authkit app-call, auto; sealed to key ${consoleCommandKeys('app-key-of-entre-textos-0123456789', 'et').publicKey.kid.slice(0, 8)}) + secret; actions off (set consoleCommands.actions to let the console act)`,
    );
  });
});

describe('review round 2 (§10.14–18)', () => {
  it('§10.15: the missing-authentication error is thrown by boot(), before ready()', async () => {
    const logged: Logged = { info: [], warn: [] };
    const app = fakeApp({
      config: {
        payments: {
          providers: { fake: async () => new FakePaymentsDriver({ provider: 'fake' }) },
          billing: { store: () => new InMemoryBillingStore() },
          consoleCommands: { prefix: 'et' },
        },
      },
      bindings: { redis: { connection: () => new RedisBus().connection() } },
      logged,
    });
    const provider = new PaymentsProvider(app);
    providers.push(provider);
    provider.register();
    await expect(provider.boot()).rejects.toThrow(/consoleCommands needs authentication/);
  });

  it('§10.17: no automatic authkit token next to a secret; still one next to explicit crypto', () => {
    const authkit = fakeAuthkit({});
    const withSecret = resolveSendingAuth({
      plane: { secret: 's'.repeat(16) },
      partition: 'et',
      authkit,
    });
    expect(withSecret.token).toBeUndefined();
    expect(withSecret.mode).toBe('secret');
    const cipher = {
      encrypt: async () => ({ ciphertext: 'x' }),
      decrypt: async () => ({ plaintext: 'x' }),
    };
    const withCrypto = resolveSendingAuth({
      plane: { crypto: { cipher } },
      partition: 'et',
      authkit,
    });
    expect(withCrypto.token).toBeDefined();
    expect(withCrypto.mode).toMatch(/\+ token \(authkit app-call, auto\)/);
  });

  it("§10.14: a tenant checks its key with a dummy decrypt, never getKey (config's block)", async () => {
    const crypto = new FakeCrypto();
    const tenant = crypto.tenant('et', ['crypto:decrypt:console-*']);
    const getKey = vi.fn(tenant.operations.getKey);
    tenant.operations.getKey = getKey;
    // Missing on a tenant: one info line (provisioned on the console's first seal), with the
    // command for a server whose provisioning is off.
    expect(await checkTenantConsoleKey(tenant)).toMatchObject({
      level: 'info',
      line: expect.stringContaining(
        'node ace crypto:keys:create console-payments --type aes256-gcm --application et',
      ),
    });
    crypto.keys.set('et/console-payments', randomBytes(32));
    // The dummy ciphertext does not open: the key is there and usable.
    expect(await checkTenantConsoleKey(tenant)).toBeUndefined();
    expect(getKey).not.toHaveBeenCalled();
    // §2e.A: no grant needed to decrypt its own console key.
    expect(await checkTenantConsoleKey(crypto.tenant('et', []))).toBeUndefined();
    // A server that still refuses (an old one) is a warning.
    const refusing = crypto.tenant('et', []);
    refusing.operations.decrypt = async () => {
      throw Object.assign(new Error('missing capability crypto:decrypt:console-payments'), {
        code: 'forbidden',
      });
    };
    expect(await checkTenantConsoleKey(refusing)).toMatchObject({
      level: 'warn',
      line: expect.stringMatching(/refused/),
    });
    // An unreachable server is a warning too.
    const down = crypto.tenant('et', ['crypto:decrypt:console-*']);
    down.operations.decrypt = async () => {
      throw new Error('fetch failed');
    };
    expect(await checkTenantConsoleKey(down)).toMatchObject({
      level: 'warn',
      line: expect.stringMatching(/could not check/),
    });
    expect(classifyConsoleKeyError(Object.assign(new Error('x'), { code: 'not_found' }))).toBe(
      'missing',
    );
  });

  it("§10.14: after a boot warning, the next command's own decrypt is the retry", async () => {
    const crypto = new FakeCrypto();
    const notes: string[] = [];
    const tenant = crypto.tenant('et', []);
    const decrypt = tenant.operations.decrypt;
    let down = true;
    tenant.operations.decrypt = async (input) => {
      if (down) throw new Error('fetch failed');
      return decrypt(input);
    };
    const auth = resolveAnsweringAuth({
      option: {
        prefix: 'et',
        partition: 'et',
        crypto: undefined,
        verifyTenant: undefined,
        secret: undefined,
      },
      crypto: tenant,
      logKey: (note) => notes.push(`${note.level}: ${note.line}`),
    });
    await auth.checkKey!();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^warn: .*could not check/);
    // The crypto server is back; the next command decrypts and the warning clears.
    down = false;
    crypto.keys.set('et/console-payments', randomBytes(32));
    const sealed = crypto.seal('et', 'console-payments', 'hello', 'a');
    const cipher = auth.crypto!
      .cipher as import('../../src/federation/redis_channel.js').ConsoleCipher;
    await expect(
      cipher.decrypt({ key: 'console-payments', ciphertext: sealed, aad: 'a' }),
    ).resolves.toEqual({ plaintext: 'hello' });
    expect(notes).toHaveLength(1);
  });

  it('§10.14: an embedded key that cannot be created says the exact command, as a warn on the console', async () => {
    const crypto = new FakeCrypto();
    const hubRuntime = crypto.embedded('hub');
    hubRuntime.service!.createKey = async () => {
      throw new Error('crypto store unavailable');
    };
    const hub = await bootHub({
      bus: new RedisBus(),
      crypto: hubRuntime,
      apps: { et: { store: new InMemoryBillingStore(), controlPlane: { prefix: 'et' } } },
    });
    expect(hub.logged.warn.join('\n')).toContain(
      'node ace crypto:keys:create console-payments --type aes256-gcm --application et',
    );
    expect(hub.logged.info.join('\n')).not.toContain('crypto:keys:create');
  });
});

describe('never crash on a bad message (§11)', () => {
  it('drops garbage on the command channel, logs each reason once, and keeps serving', async () => {
    const bus = new RedisBus();
    const secret = 's'.repeat(24);
    const owning = await bootOwningApp({
      bus,
      consoleCommands: { prefix: 'et', secret, actions: ['refund'] },
    });
    const raw = bus.connection();
    const garbage = [
      'not json at all',
      '[]',
      'null',
      '42',
      '{"id":1}',
      '{"id":"x"}',
      '{"id":"x","sealed":123}',
      '{"id":"x","sealed":"agora:ct1:console-payments:1:@@@"}',
      '{"id":"x","verb":"refund","mac":"zz","ts":0}',
      '{"id":"x","verb":{"toString":1},"mac":"zz","ts":1,"args":"nope"}',
      `{"id":"${'x'.repeat(100_000)}"}`,
    ];
    for (let round = 0; round < 2; round++) {
      for (const message of garbage) await raw.publish('et-payments-console', message);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Each kind of refusal is logged once, however many times it arrives.
    const refusals = owning.logged.warn.filter((line) => line.includes('refused'));
    expect(refusals.length).toBeGreaterThan(0);
    expect(new Set(refusals).size).toBe(refusals.length);

    // Still serving: a genuine signed command is answered.
    const { RedisConsoleChannel } = await import('../../src/federation/redis_channel.js');
    const console = new RedisConsoleChannel({ client: bus.connection(), prefix: 'et', secret });
    const reply = await console.send(
      {
        id: 'after-garbage-1',
        verb: 'profile',
        args: [],
        capabilities: ['payments:console:read'],
      },
      { timeoutMs: 2_000 },
    );
    await console.close();
    expect(reply.ok).toBe(true);
  });
});

describe('console-side timeout (§11)', () => {
  it('says the app may have refused the command, and where to look', async () => {
    const bus = new RedisBus();
    // Someone listens, nobody answers (an app that refused the command).
    await bus.connection().subscribe('et-payments-console', () => undefined);
    const { RedisConsoleChannel } = await import('../../src/federation/redis_channel.js');
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: 'et',
      secret: 's'.repeat(24),
    });
    await expect(
      console.send(
        { id: 'timeout-1', verb: 'profile', args: [], capabilities: [] },
        { timeoutMs: 1_000 },
      ),
    ).rejects.toThrow(
      'no instance of "et" answered within 1s — the app may have refused the command (check its logs, or run `node ace agora:doctor` there)',
    );
    await console.close();
  });
});

describe('boot error notes (§11)', () => {
  it('appends " Note: …" after the template when automatic modes were switched off or blocked', async () => {
    const { answeringAuthError, sendingAuthError } = await import(
      '../../src/federation/auto_auth.js'
    );
    const appAuth = resolveAnsweringAuth({
      option: {
        prefix: 'et',
        partition: 'et',
        crypto: false,
        verifyTenant: undefined,
        secret: undefined,
      },
      crypto: new FakeCrypto().embedded('et'),
      authkit: fakeAuthkit({}),
    });
    expect(answeringAuthError(appAuth.notes).message).toMatch(
      /Docs: https:\/\/\S+ Note: `crypto: false` turned the automatic crypto mode off; a token verifier is available \(authkit app-call, auto\), but token mode needs an APP_KEY \(commands are sealed to a key derived from it\)\.$/,
    );
    const consoleAuth = resolveSendingAuth({
      plane: { crypto: false, token: false },
      partition: 'et',
      crypto: new FakeCrypto().embedded('hub'),
      authkit: fakeAuthkit({}),
    });
    expect(sendingAuthError('et', consoleAuth.notes).message).toMatch(
      /console auth at once\. Note: `crypto: false` turned the automatic crypto mode off; `token: false` turned the automatic authkit token off\.$/,
    );
    // Nothing switched off: the template alone.
    expect(answeringAuthError([]).message).not.toContain('Note:');
  });
});

describe("authkit's key directory (§2e.B)", () => {
  it('a console that boots before the app publishes neither fetches nor warns at boot', async () => {
    const published = new Map<string, unknown>();
    const hubAuthkit = directoryAuthkit(published, { caller: 'hub' });
    const hub = await bootHub({
      bus: new RedisBus(),
      authkit: hubAuthkit,
      apps: { et: { store: new InMemoryBillingStore(), controlPlane: { prefix: 'et' } } },
    });
    expect(hubAuthkit.lookups).toEqual([]);
    expect(hub.logged.warn).toEqual([]);
    expect(hub.logged.info.join('\n')).not.toContain('not published');
  });

  /** authkit-client's manager with the directory: one shared map of published keys. */
  function directoryAuthkit(
    published: Map<string, unknown>,
    options: Parameters<typeof fakeAuthkit>[0] & { app?: string } = {},
  ) {
    const base = fakeAuthkit(options);
    const publishCalls: unknown[] = [];
    const lookups: Array<{ app: string; purpose: string }> = [];
    return Object.assign(base, {
      publishCalls,
      lookups,
      publishAppKey: async (input: { purpose: string; jwk: unknown }) => {
        publishCalls.push(input);
        published.set(`${options.app ?? 'et'}/${input.purpose}`, input.jwk);
      },
      appKey: async (input: { app: string; purpose: string }) => {
        lookups.push(input);
        return (published.get(`${input.app}/${input.purpose}`) ?? null) as never;
      },
    });
  }

  it('the app publishes its public key (never `d`), and the console seals to it: zero config', async () => {
    const bus = new RedisBus();
    const published = new Map<string, unknown>();
    const appKey = 'app-key-of-entre-textos-0123456789';
    const appAuthkit = directoryAuthkit(published, { grants: { hub: ['payments:console:*'] } });
    const owning = await bootOwningApp({
      bus,
      appKey,
      consoleCommands: { prefix: 'et', actions: ['refund'] },
      authkit: appAuthkit,
    });
    expect(appAuthkit.publishCalls).toHaveLength(1);
    const call = appAuthkit.publishCalls[0] as { purpose: string; jwk: Record<string, unknown> };
    expect(call.purpose).toBe('console:payments');
    expect(call.jwk).not.toHaveProperty('d');
    expect(call.jwk.kid).toBe(consoleCommandKeys(appKey, 'et').publicKey.kid);

    const hubAuthkit = directoryAuthkit(published, { caller: 'hub' });
    const hub = await bootHub({
      bus,
      authkit: hubAuthkit,
      apps: { et: { store: owning.store, controlPlane: { prefix: 'et' } } },
    });
    expect(hub.logged.info.join('\n')).toContain(
      'token (authkit app-call, auto, authkit key directory; sealed to the key the app publishes)',
    );
    // Boot never asks the directory (the app may boot after the console)…
    expect(hubAuthkit.lookups).toEqual([]);
    expect((await hub.refund('directory-0001')).status).toBe(200);
    // …the first command does (authkit-client caches the answer).
    expect(hubAuthkit.lookups).toContainEqual({ app: 'et', purpose: 'console:payments' });
  });

  it('an explicit publicKey wins over the directory', async () => {
    const published = new Map<string, unknown>();
    const authkit = directoryAuthkit(published);
    const { d: _d, ...publicKey } = consoleCommandKeys(
      'app-key-of-entre-textos-0123456789',
      'et',
    ).publicKey;
    const auth = resolveSendingAuth({ plane: { publicKey }, partition: 'et', authkit });
    await auth.recipient!();
    expect(authkit.lookups).toEqual([]);
    expect(auth.mode).toMatch(/sealed to key /);
  });

  it('a key the directory does not have is the actionable error', async () => {
    const auth = resolveSendingAuth({
      plane: {},
      partition: 'et',
      authkit: directoryAuthkit(new Map()),
    });
    await expect(auth.recipient!()).rejects.toThrow(
      /no "console:payments" key for "et".*controlPlane\.publicKey.*publishes in authkit's key directory by itself when it has authkit's `service` configured/,
    );
  });

  it('without the directory and without publicKey, an explicit token fails the boot', () => {
    const auth = resolveSendingAuth({
      plane: { token: 'tok', secret: 's'.repeat(16) },
      partition: 'et',
    });
    expect(auth.mode).toBeUndefined();
    expect(auth.notes.join()).toMatch(/controlPlane\.token.*controlPlane\.publicKey/);
  });
});

describe('refused-command lines (§11b)', () => {
  it('logs each refusal as "refused a command (<reason>)", once per reason', async () => {
    const bus = new RedisBus();
    const secret = 's'.repeat(24);
    const owning = await bootOwningApp({
      bus,
      consoleCommands: { prefix: 'et', secret, actions: ['refund'] },
    });
    const raw = bus.connection();
    const { RedisConsoleChannel } = await import('../../src/federation/redis_channel.js');
    const console = new RedisConsoleChannel({ client: bus.connection(), prefix: 'et', secret });
    await raw.publish('et-payments-console', 'garbage');
    await raw.publish('et-payments-console', '{"verb":"x"}');
    await raw.publish('et-payments-console', '{"id":"a","verb":"profile"}');
    await raw.publish(
      'et-payments-console',
      JSON.stringify({ id: 'b', verb: 'profile', mac: 'x', ts: Date.now() }),
    );
    await raw.publish(
      'et-payments-console',
      JSON.stringify({ id: 'c', verb: 'profile', mac: 'x', ts: 1 }),
    );
    // No capabilities: answered 403 and logged.
    const bare = await console.send({ id: 'd', verb: 'profile', args: [] }, { timeoutMs: 2_000 });
    expect(bare).toMatchObject({ ok: false, error: { code: 'capabilities-required' } });
    // A genuine command, then the same bytes again.
    await console.send(
      { id: 'e', verb: 'profile', args: [], capabilities: ['payments:console:read'] },
      { timeoutMs: 2_000 },
    );
    const sent = bus.published.find(
      (p) => p.channel === 'et-payments-console' && p.message.includes('"id":"e"'),
    )!;
    await raw.publish('et-payments-console', sent.message);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await console.close();
    const prefix = '[@adonis-agora/payments] console commands: refused a command';
    expect(owning.logged.warn).toEqual(
      expect.arrayContaining([
        `${prefix} (not JSON)`,
        `${prefix} (no command id)`,
        `${prefix} (mode not accepted here (this app accepts: secret; the command came as unsigned))`,
        `${prefix} (bad signature)`,
        `${prefix} (stale)`,
        `${prefix} (capabilities-required)`,
        `${prefix} (replayed)`,
      ]),
    );
    expect(owning.logged.warn.join('\n')).not.toContain('unsigned?');
  });
});

describe('§13 mixed Hubs', () => {
  /** authkit-client with app-call tokens and the key directory, sharing `published`. */
  function hubAuthkit(
    published: Map<string, unknown>,
    options: { app?: string; failToken?: string; grants?: Record<string, string[]> } = {},
  ) {
    const base = fakeAuthkit({
      caller: 'hub',
      ...(options.grants ? { grants: options.grants } : {}),
    });
    const lookups: string[] = [];
    let tokenCalls = 0;
    const tokens = base.appCallTokens!()!;
    return Object.assign(base, {
      lookups,
      tokenCalls: () => tokenCalls,
      appCallTokens: () => ({
        token: async (app: string) => {
          tokenCalls += 1;
          if (options.failToken) {
            // authkit-client's errors carry the OAuth error as `code`.
            throw Object.assign(new Error(options.failToken), { code: options.failToken });
          }
          return tokens.token(app);
        },
      }),
      publishAppKey: async (input: { purpose: string; jwk: unknown }) => {
        published.set(`${options.app ?? 'et'}/${input.purpose}`, input.jwk);
      },
      appKey: async (input: { app: string; purpose: string }) => {
        lookups.push(`${input.app}/${input.purpose}`);
        return (published.get(`${input.app}/${input.purpose}`) ?? null) as never;
      },
    });
  }

  it('13a: the Hub picks crypto for a crypto app and a token for an authkit-only app, lazily', async () => {
    // A crypto app (ET): publishes nothing (§13e), so the console seals with crypto.
    const crypto = new FakeCrypto();
    const published = new Map<string, unknown>();
    const bus = new RedisBus();
    const et = await bootOwningApp({
      bus,
      appKey: 'app-key-of-entre-textos-0123456789',
      consoleCommands: { prefix: 'et', actions: ['refund'] },
      crypto: crypto.embedded('et'),
      authkit: hubAuthkit(published, { grants: { hub: ['payments:console:*'] } }),
    });
    expect(published.size).toBe(0);
    const authkit = hubAuthkit(published);
    const hub = await bootHub({
      bus,
      crypto: crypto.embedded('hub'),
      authkit,
      apps: { et: { store: et.store, controlPlane: { prefix: 'et' } } },
    });
    expect(hub.logged.info).toContain(
      '[@adonis-agora/payments] console commands to "et": auto (authkit key directory if the app publishes one, else crypto (auto, key console-payments, partition et))',
    );
    expect(authkit.lookups).toEqual([]); // nothing at boot
    expect((await hub.refund('mixed-crypto-1')).status).toBe(200);
    expect((await hub.refund('mixed-crypto-2')).status).toBe(200);
    expect(authkit.lookups).toEqual(['et/console:payments']); // decided once, cached
    expect(bus.wire).toContain('agora:ct1:console-payments:');

    // An authkit-only app (EduLiberta): publishes its key, so the same Hub sends a token.
    const bus2 = new RedisBus();
    const published2 = new Map<string, unknown>();
    const el = await bootOwningApp({
      bus: bus2,
      appKey: 'app-key-of-eduliberta-0123456789ab',
      consoleCommands: { prefix: 'et', actions: ['refund'] },
      authkit: hubAuthkit(published2, { grants: { hub: ['payments:console:*'] } }),
    });
    expect(published2.size).toBe(1);
    const hub2 = await bootHub({
      bus: bus2,
      crypto: new FakeCrypto().embedded('hub'),
      authkit: hubAuthkit(published2),
      apps: { et: { store: el.store, controlPlane: { prefix: 'et' } } },
    });
    expect((await hub2.refund('mixed-token-1')).status).toBe(200);
    expect(bus2.wire).toContain('agora:pk1:');
    expect(bus2.wire).not.toContain('agora:ct1:');
  });

  it('13a: the choice is made again after 5 minutes, or when the app does not answer', async () => {
    const published = new Map<string, unknown>();
    const authkit = hubAuthkit(published);
    const auth = resolveSendingAuth({
      plane: {},
      partition: 'et',
      crypto: new FakeCrypto().embedded('hub'),
      authkit,
    });
    expect(await auth.decide!()).toBe('crypto');
    // The app starts publishing: still crypto from the cache, then token once invalidated.
    published.set(
      'et/console:payments',
      consoleCommandKeys('app-key-of-x-0123456789abcdef', 'et').publicKey,
    );
    expect(await auth.decide!()).toBe('crypto');
    auth.invalidate!();
    expect(await auth.decide!()).toBe('token');
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000 + 1);
    published.clear();
    expect(await auth.decide!()).toBe('crypto');
    spy.mockRestore();
  });

  it('13a: explicit crypto: false or token: false still win', () => {
    const authkit = hubAuthkit(new Map());
    const crypto = new FakeCrypto().embedded('hub');
    expect(
      resolveSendingAuth({ plane: { token: false }, partition: 'et', crypto, authkit }).decide,
    ).toBeUndefined();
    const noCrypto = resolveSendingAuth({
      plane: { crypto: false },
      partition: 'et',
      crypto,
      authkit,
    });
    expect(noCrypto.decide).toBeUndefined();
    expect(noCrypto.mode).toBe(
      'token (authkit app-call, auto, authkit key directory; sealed to the key the app publishes)',
    );
  });

  it('13b: in crypto mode a token that cannot be minted is left out, logged once, retried after 5 min', async () => {
    const crypto = new FakeCrypto();
    const bus = new RedisBus();
    const owning = await bootOwningApp({
      bus,
      consoleCommands: { prefix: 'et', actions: ['refund'] },
      crypto: crypto.embedded('et'),
      authkit: fakeAuthkit({ grants: { hub: ['payments:console:*'] } }),
    });
    const authkit = hubAuthkit(new Map(), { failToken: 'invalid_target' });
    const hub = await bootHub({
      bus,
      crypto: crypto.embedded('hub'),
      authkit: Object.assign(authkit, { appKey: undefined }),
      apps: { et: { store: owning.store, controlPlane: { prefix: 'et' } } },
    });
    expect((await hub.refund('no-token-1')).status).toBe(200);
    expect((await hub.refund('no-token-2')).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const warning =
      '[@adonis-agora/payments] console commands to "et": sending without an authkit app-call token (crypto only): invalid_target. To attach it: grant the console\'s service client payments:console:* on "et" in authkit.';
    // A missing grant (invalid_target) is info, not a warning.
    expect(hub.logged.info.filter((line) => line === warning)).toHaveLength(1);
    expect(hub.logged.warn.filter((line) => line === warning)).toHaveLength(0);
    // Not minted again before 5 minutes.
    expect(authkit.tokenCalls()).toBe(1);
  });

  it('13b: in token mode the token is required, and the error names the grant', async () => {
    const published = new Map<string, unknown>([
      ['et/console:payments', consoleCommandKeys('app-key-of-x-0123456789abcdef', 'et').publicKey],
    ]);
    const auth = resolveSendingAuth({
      plane: {},
      partition: 'et',
      authkit: hubAuthkit(published, { failToken: 'no grant' }),
    });
    const token = auth.token as { get(): Promise<string> };
    await expect(token.get()).rejects.toThrow(
      'could not get an authkit app-call token for "et": no grant. To attach it: grant the console\'s service client payments:console:* on "et" in authkit.',
    );
  });

  it('13c: APP_KEY from app.appKey, else config/encryption.ts (real defineConfig), else the env', async () => {
    const { appKeyOf } = await import('../../src/federation/console.js');
    const { defineConfig, drivers } = await import('@adonisjs/core/encryption');
    const { Secret } = await import('@adonisjs/core/helpers');
    const appWith = (values: Record<string, unknown>) => ({
      config: {
        get: <T>(key: string, fallback?: T) =>
          key in values ? (values[key] as T) : (fallback as T),
      },
    });
    const KEY = 'app-key-from-encryption-012345';
    const previous = process.env.APP_KEY;
    try {
      delete process.env.APP_KEY;
      expect(await appKeyOf(appWith({ 'app.appKey': new Secret('from-app-0123456789') }))).toBe(
        'from-app-0123456789',
      );
      // EduLiberta: the key only lives in config/encryption.ts (lazy providers).
      const legacy = defineConfig({
        default: 'legacy',
        list: { legacy: drivers.legacy({ keys: [new Secret(KEY)] }) },
      });
      expect(await appKeyOf(appWith({ encryption: legacy }))).toBe(KEY);
      const several = defineConfig({
        default: 'app',
        list: {
          backup: drivers.aes256gcm({ id: 'backup', keys: ['backup-key-0123456789abcdef'] }),
          app: drivers.aes256gcm({ id: 'app', keys: [KEY, 'old-key-0123456789abcdef'] }),
        },
      });
      expect(await appKeyOf(appWith({ encryption: several }))).toBe(KEY);
      const noDefault = defineConfig({
        list: { only: drivers.aes256gcm({ id: 'only', keys: [KEY] }) },
      });
      expect(await appKeyOf(appWith({ encryption: noDefault }))).toBe(KEY);
      // Already resolved, or flat.
      expect(
        await appKeyOf(appWith({ encryption: { default: 'a', list: { a: { key: KEY } } } })),
      ).toBe(KEY);
      expect(await appKeyOf(appWith({ encryption: { keys: [KEY] } }))).toBe(KEY);
      // A source that throws is "no key here".
      const throwing = {
        config: {
          get: (key: string) => {
            if (key === 'encryption') throw new Error('boom');
            return undefined;
          },
        },
      } as never;
      expect(await appKeyOf(throwing)).toBeUndefined();
      process.env.APP_KEY = 'from-env-0123456789';
      expect(await appKeyOf(appWith({}))).toBe('from-env-0123456789');
    } finally {
      if (previous === undefined) delete process.env.APP_KEY;
      else process.env.APP_KEY = previous;
    }
  });

  it('13e: a crypto app neither publishes nor warns; a token-only app that cannot publish warns', async () => {
    const published = new Map<string, unknown>();
    const cryptoApp = await bootOwningApp({
      bus: new RedisBus(),
      appKey: 'app-key-of-entre-textos-0123456789',
      consoleCommands: { prefix: 'et' },
      crypto: new FakeCrypto().embedded('et'),
      authkit: hubAuthkit(published),
    });
    expect(published.size).toBe(0);
    expect(cryptoApp.logged.warn).toEqual([]);
    const tokenOnly = await bootOwningApp({
      bus: new RedisBus(),
      appKey: 'app-key-of-entre-textos-0123456789',
      consoleCommands: { prefix: 'et' },
      authkit: fakeAuthkit({}),
    });
    expect(tokenOnly.logged.warn.join('\n')).toMatch(/reached by token only.*`service`/);
  });

  it('13f: hasKey answers without a decrypt; an older server falls back; forbidden is no permission', async () => {
    const crypto = new FakeCrypto();
    const tenant = crypto.tenant('et', []);
    const decrypt = vi.fn(tenant.operations.decrypt);
    tenant.operations.decrypt = decrypt;
    const withHasKey = {
      ...tenant,
      operations: { ...tenant.operations, hasKey: async () => true },
    };
    expect(await checkTenantConsoleKey(withHasKey)).toBeUndefined();
    expect(decrypt).not.toHaveBeenCalled();
    expect(
      (
        await checkTenantConsoleKey({
          ...tenant,
          operations: { ...tenant.operations, hasKey: async () => false },
        })
      )?.line,
    ).toMatch(/does not exist/);
    // An older crypto server: no such route, so the decrypt probe.
    const older = {
      ...tenant,
      operations: {
        ...tenant.operations,
        hasKey: async () => {
          throw Object.assign(new Error('Route not found'), { status: 404 });
        },
      },
    };
    await checkTenantConsoleKey(older);
    expect(decrypt).toHaveBeenCalledTimes(1);
    // A refusal is no permission, not a fallback.
    const refused = {
      ...tenant,
      operations: {
        ...tenant.operations,
        hasKey: async () => {
          throw Object.assign(new Error('missing capability'), { code: 'forbidden' });
        },
      },
    };
    expect((await checkTenantConsoleKey(refused))?.line).toMatch(/refused/);
    expect(decrypt).toHaveBeenCalledTimes(1);
  });
});

describe('§13a cache invalidation (mirrors flags)', () => {
  it('drops the decision on any send failure, so the next command decides again', async () => {
    const lookups: string[] = [];
    const authkit = {
      ...fakeAuthkit({ caller: 'hub' }),
      appKey: async (input: { app: string; purpose: string }) => {
        lookups.push(input.app);
        return null;
      },
    };
    const bus = new RedisBus();
    // Somebody listens on the app's channel but never answers.
    await bus.connection().subscribe('et-payments-console', () => undefined);
    const hub = new FederatedPaymentsConsole(
      {
        et: { store: new InMemoryBillingStore(), controlPlane: { prefix: 'et' }, timeoutMs: 50 },
      },
      {
        redis: async () => bus.connection(),
        crypto: async () => new FakeCrypto().embedded('hub'),
        authkit: async () => authkit,
      },
    );
    for (const key of ['fail-a-0001', 'fail-b-0002']) {
      await hub.dispatch(
        'et',
        'refund',
        { params: { gatewayId: 'pay_1' }, query: {}, body: {} },
        { currency: 'BRL', meta: { idempotencyKey: key } },
      );
    }
    // Decided once per command: the failure dropped the cached decision in between.
    expect(lookups).toEqual(['et', 'et']);
    await hub.close();
  });
});

describe('§13a fallback to crypto when the auto-chosen token cannot be minted', () => {
  it('sends by crypto, with the §13b warning, when a stale published key picked token mode', async () => {
    const crypto = new FakeCrypto();
    const bus = new RedisBus();
    const owning = await bootOwningApp({
      bus,
      consoleCommands: { prefix: 'et', actions: ['refund'] },
      crypto: crypto.embedded('et'),
    });
    // A key an older version of the app published, and no grant for the console's token.
    const stale = consoleCommandKeys('app-key-of-an-old-version-01234', 'et').publicKey;
    const { d: _d, ...publicKey } = stale;
    let mints = 0;
    const authkit = {
      ...fakeAuthkit({ caller: 'hub' }),
      appCallTokens: () => ({
        token: async () => {
          mints += 1;
          throw Object.assign(new Error('invalid_target'), { code: 'invalid_target' });
        },
      }),
      appKey: async () => publicKey as never,
    };
    const hub = await bootHub({
      bus,
      crypto: crypto.embedded('hub'),
      authkit,
      apps: { et: { store: owning.store, controlPlane: { prefix: 'et' } } },
    });
    let lookups = 0;
    authkit.appKey = async () => {
      lookups += 1;
      return publicKey as never;
    };
    expect((await hub.refund('stale-key-0001')).status).toBe(200);
    expect(owning.driver.refundCalls).toHaveLength(1);
    const mintsAfterFirst = mints;
    // The decision switched to crypto for 5 minutes: no failing mint, no lookup, on the next one.
    expect((await hub.refund('stale-key-0002')).status).toBe(200);
    expect(owning.driver.refundCalls).toHaveLength(2);
    expect(mints).toBe(mintsAfterFirst);
    expect(lookups).toBe(1);
    expect(bus.wire).toContain('agora:ct1:console-payments:');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      hub.logged.info.filter((line) =>
        line.startsWith(
          '[@adonis-agora/payments] console commands to "et": sending without an authkit app-call token (crypto only): invalid_target.',
        ),
      ),
    ).toHaveLength(1);
    expect(mints).toBeGreaterThan(0);
  });

  it('an explicit token is unaffected: its failure is the error', () => {
    const auth = resolveSendingAuth({
      plane: { token: async () => Promise.reject(new Error('nope')), publicKey: undefined },
      partition: 'et',
      crypto: new FakeCrypto().embedded('hub'),
      authkit: fakeAuthkit({}),
    });
    expect(auth.decide).toBeUndefined();
    expect(auth.variants).toBeUndefined();
  });
});

describe('§13b/§13e details (aligned with config)', () => {
  it('warns once per reason, whichever path found the token missing', async () => {
    const warns: string[] = [];
    let reason = 'invalid_target';
    const auth = resolveSendingAuth({
      plane: {},
      partition: 'et',
      crypto: new FakeCrypto().embedded('hub'),
      authkit: {
        appCallTokens: () => ({
          token: async () => {
            throw new Error(reason);
          },
        }),
      },
      log: (note) => warns.push(note.line),
    });
    const token = auth.token as { get(): Promise<string> };
    expect(await token.get()).toBe('');
    // The §13a fallback with the same reason: no second line.
    auth.tokenUnavailable?.('invalid_target');
    expect(warns).toHaveLength(1);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
      reason = 'authkit unreachable';
      expect(await token.get()).toBe('');
    } finally {
      vi.useRealTimers();
    }
    expect(warns).toHaveLength(2);
    expect(warns[1]).toContain('(crypto only): authkit unreachable.');
  });

  it('publishes the token key only when token mode is how the app is reached', () => {
    const keys = consoleCommandKeys('an-app-key-of-32-characters-0001', 'et');
    const verifyTenant = async () => ({ app: 'et', capabilities: [] });
    const crypto = { key: 'console-payments', cipher: {} as never };
    const base = { modes: [], notes: [], keys };
    expect(publishesAppKey({ ...base, cryptoTokenOptional: false })).toBe(true);
    expect(publishesAppKey({ ...base, crypto, verifyTenant, cryptoTokenOptional: true })).toBe(
      false,
    );
    // Explicit crypto + verifyTenant: crypto commands carry a required token (migration).
    expect(publishesAppKey({ ...base, crypto, verifyTenant, cryptoTokenOptional: false })).toBe(
      true,
    );
    expect(publishesAppKey({ modes: [], notes: [], cryptoTokenOptional: false })).toBe(false);
  });
});

describe('§13b log level', () => {
  it('is info only for a missing grant (invalid_target, "not granted", "no grant"), warn otherwise', async () => {
    const notes: Array<{ level: string; line: string }> = [];
    const sendWith = async (error: Error) => {
      const auth = resolveSendingAuth({
        plane: {},
        partition: 'et',
        crypto: new FakeCrypto().embedded('hub'),
        authkit: {
          appCallTokens: () => ({
            token: async () => {
              throw error;
            },
          }),
        },
        log: (note) => notes.push(note),
      });
      expect(await (auth.token as { get(): Promise<string> }).get()).toBe('');
    };
    const coded = (message: string, code: string) => Object.assign(new Error(message), { code });
    await sendWith(coded('target not allowed', 'invalid_target'));
    await sendWith(new Error('the app "et" is Not Granted to this client'));
    await sendWith(new Error('no grant for payments:console:* on "et"'));
    await sendWith(coded('client not allowed', 'unauthorized_client'));
    await sendWith(coded('bad client credentials', 'invalid_client'));
    await sendWith(new Error('connect ECONNREFUSED 127.0.0.1:3333'));
    // A message carrying invalid_target without a code is a missing grant too.
    await sendWith(new Error('authkit answered 400: invalid_target (urn:agora:app:shop)'));
    expect(notes.map((n) => n.level)).toEqual([
      'info',
      'info',
      'info',
      'warn',
      'warn',
      'warn',
      'info',
    ]);
    for (const note of notes) {
      expect(note.line).toMatch(
        /^\[@adonis-agora\/payments\] console commands to "et": sending without an authkit app-call token \(crypto only\): .+\. To attach it: grant the console's service client payments:console:\* on "et" in authkit\.$/,
      );
    }
  });
});
