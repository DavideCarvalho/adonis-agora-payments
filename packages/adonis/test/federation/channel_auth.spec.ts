import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolvePaymentsTenancy } from '../../src/agora/tenancy.js';
import { consoleCapabilities, createConsoleActions } from '../../src/dashboard/api_core.js';
import type { PaymentsDriver } from '../../src/driver.js';
import {
  answerPaymentsConsoleCommands,
  consoleCommandKeys,
  type FederatedPaymentsAction,
  FederatedPaymentsConsole,
  parseConsolePublicKey,
  resolveConsoleCommands,
  validateFederatedPaymentsApp,
} from '../../src/federation/console.js';
import { memoryIdempotencyStore } from '../../src/federation/idempotency.js';
import {
  type ConsoleCipher,
  type ConsoleCommand,
  RedisConsoleChannel,
  UNAUTHORIZED_CONSOLE,
  UNSIGNED_CHANNEL,
} from '../../src/federation/redis_channel.js';
import { InMemoryBillingStore } from '../../src/testing/in_memory_billing_store.js';
import type { TenantVerifier } from '../../src/topology/verify.js';
import { RedisBus } from './redis_bus.js';

/**
 * The federated console's Redis channel is authenticated: whoever can publish on Redis must not be
 * able to refund through the owning app's gateway, claim to be any viewer, or forge an answer.
 */

const PREFIX = 'et';
const SECRET = 'et-console-secret-0123456789';
const APP_KEY = 'app-key-of-entre-textos-0123456789';
const COMMAND_CHANNEL = `${PREFIX}-payments-console`;
const REPLY_CHANNEL = `${PREFIX}-payments-console-reply`;

/** What crossed the command channel (replies are authenticated, not encrypted). */
const commandsOn = (bus: RedisBus) =>
  bus.published
    .filter((p) => p.channel === COMMAND_CHANNEL)
    .map((p) => p.message)
    .join('\n');

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stand-in for authkitTenantVerifier: one token per console client. */
const verifyTenant: TenantVerifier = ({ token }) => {
  if (token === 'hub-operator') {
    return {
      partition: 'et',
      capabilities: ['payments:console:read', 'payments:console:refund'],
      clientId: 'hub',
    };
  }
  if (token === 'hub-reader') {
    return { partition: 'et', capabilities: ['payments:console:read'], clientId: 'hub-ro' };
  }
  if (token === 'tenant-of-the-control-plane') {
    // What a payments tenant's token carries: it must not make its holder a console.
    return {
      partition: 'et',
      capabilities: ['payments:read', 'payments:refund', 'payments:charge'],
      clientId: 'tenant',
    };
  }
  if (token === 'hub-other-app') {
    return { partition: 'billing-app', capabilities: ['payments:*'], clientId: 'hub-billing' };
  }
  return null;
};

/**
 * A stand-in for an @adonis-agora/crypto server (in the Hub or its own app): keys live here, and
 * each caller gets a cipher limited to what its token may do on them.
 */
class FakeCryptoServer {
  readonly keys = new Map<string, Buffer>([['console-payments', randomBytes(32)]]);
  readonly audit: Array<{ op: string; key: string; context?: string | undefined }> = [];

  cipherFor(allowed: { encrypt?: string[]; decrypt?: string[] }): ConsoleCipher {
    return {
      encrypt: async ({ key, plaintext, aad, context }) => {
        if (!allowed.encrypt?.includes(key)) throw new Error(`no crypto:encrypt:${key}`);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.keys.get(key)!, iv);
        cipher.setAAD(Buffer.from(aad ?? ''));
        const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        this.audit.push({ op: 'encrypt', key, context });
        return {
          ciphertext: `agora:ct1:${key}:1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`,
        };
      },
      decrypt: async ({ key, ciphertext, aad, context }) => {
        if (!allowed.decrypt?.includes(key)) throw new Error(`no crypto:decrypt:${key}`);
        const raw = Buffer.from(ciphertext.split(':').pop()!, 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', this.keys.get(key)!, raw.subarray(0, 12));
        decipher.setAAD(Buffer.from(aad ?? ''));
        decipher.setAuthTag(raw.subarray(12, 28));
        const plaintext = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
        this.audit.push({ op: 'decrypt', key, context });
        return { plaintext: plaintext.toString('utf8') };
      },
    };
  }
}

/** The owning app (Entre Textos): one paid payment, a gateway that counts refunds. */
async function owningApp(
  bus: RedisBus,
  auth: Omit<
    Parameters<typeof answerPaymentsConsoleCommands>[0],
    'client' | 'prefix' | 'actions' | 'idempotency' | 'runtime'
  >,
  actions: FederatedPaymentsAction[] = ['refund'],
) {
  const store = new InMemoryBillingStore();
  await store.savePayment({
    gatewayId: 'pay_1',
    provider: 'stripe',
    status: 'paid',
    amount: 1000,
    currency: 'BRL',
  });
  const refunds: string[] = [];
  const drivers = new Map<string, PaymentsDriver>([
    [
      'stripe',
      {
        provider: 'stripe',
        capabilities: { refunds: true },
        async refund(gatewayId: string) {
          refunds.push(gatewayId);
          return {
            gatewayId: `re_${refunds.length}`,
            provider: 'stripe',
            amount: { amount: 1000, currency: 'BRL' },
            status: 'pending',
            createdAt: new Date().toISOString(),
          };
        },
      } as unknown as PaymentsDriver,
    ],
  ]);
  const errors: unknown[] = [];
  const channel = await answerPaymentsConsoleCommands({
    client: bus.connection(),
    prefix: PREFIX,
    actions: new Set(actions),
    idempotency: memoryIdempotencyStore(),
    runtime: {
      currency: 'BRL',
      store: () => store,
      capabilities: async () => consoleCapabilities(drivers),
      actions: async (s) =>
        createConsoleActions({
          manager: { driver: (name) => drivers.get(name) as never },
          store: s,
          tenancy: () => resolvePaymentsTenancy(undefined),
        }),
    },
    ...auth,
    onError: (error) => errors.push(error),
  });
  return { store, refunds, errors, channel };
}

const refund = (overrides: Partial<ConsoleCommand> = {}): ConsoleCommand => ({
  id: randomUUID(),
  verb: 'refund',
  args: [
    {
      params: { gatewayId: 'pay_1' },
      query: {},
      body: {},
      idempotencyKey: `refund-${randomUUID()}`,
    },
  ],
  actor: 'ops@hub.example',
  capabilities: ['payments:refund'],
  via: 'Hub',
  ...overrides,
});

/** The forged command from the advisory: a refund claiming every capability. */
const forged = (id = randomUUID()) => ({
  id,
  verb: 'refund',
  args: [{ params: { gatewayId: 'pay_1' }, query: {}, body: {}, idempotencyKey: `forged-${id}` }],
  actor: 'ceo@example.com',
  capabilities: ['*'],
  verified: { partition: 'et', capabilities: ['*'] },
});

describe('an app with no authentication', () => {
  it('neither sends nor answers commands', async () => {
    const bus = new RedisBus();
    const channel = new RedisConsoleChannel({ client: bus.connection(), prefix: PREFIX });
    await expect(channel.answer(async () => null)).rejects.toMatchObject({
      code: UNSIGNED_CHANNEL,
    });
    await expect(channel.send(refund(), { timeoutMs: 100 })).rejects.toMatchObject({
      code: UNSIGNED_CHANNEL,
    });
    await expect(owningApp(bus, {})).rejects.toMatchObject({ code: UNSIGNED_CHANNEL });
    // Nothing was published by either side.
    expect(bus.published).toHaveLength(0);
  });

  it('a console without authentication answers 503, without sending anything', async () => {
    const bus = new RedisBus();
    const hub = new FederatedPaymentsConsole(
      { et: { store: new InMemoryBillingStore(), controlPlane: { prefix: PREFIX } } },
      { redis: async () => bus.connection() },
    );
    const answer = await hub.dispatch(
      'et',
      'refund',
      { params: { gatewayId: 'pay_1' }, query: {}, body: {} },
      {
        currency: 'BRL',
        meta: { capabilities: ['payments:*'], idempotencyKey: 'refund-unsigned-0001' },
      },
    );
    expect(answer).toMatchObject({ status: 503, body: { code: UNSIGNED_CHANNEL } });
    expect(bus.published).toHaveLength(0);
    await hub.close();
  });

  it('consoleCommands without verifyTenant, crypto or secret is not authenticated', () => {
    expect(resolveConsoleCommands({ actions: ['refund'] }, 'et')).toMatchObject({
      secret: undefined,
      crypto: undefined,
      verifyTenant: undefined,
      partition: 'et',
    });
  });
});

describe('shared-secret mode', () => {
  it('refuses the forged refund, unsigned or with a made-up MAC', async () => {
    const bus = new RedisBus();
    const { refunds, errors } = await owningApp(bus, { secret: SECRET });
    const raw = bus.connection();
    await raw.publish(COMMAND_CHANNEL, JSON.stringify(forged()));
    await raw.publish(
      COMMAND_CHANNEL,
      JSON.stringify({ ...forged(), ts: Date.now(), mac: 'AAAA' }),
    );
    await tick();
    expect(refunds).toHaveLength(0);
    expect(errors).toHaveLength(2);
    for (const error of errors) expect(error).toMatchObject({ code: UNSIGNED_CHANNEL });
    // Nothing answered: an attacker learns nothing from the reply channel either.
    expect(bus.published.filter((p) => p.channel === REPLY_CHANNEL)).toHaveLength(0);
  });

  it('runs a signed refund once; a replay, a tampered copy and a stale one do not run', async () => {
    const bus = new RedisBus();
    const { refunds, store } = await owningApp(bus, { secret: SECRET });
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: SECRET,
    });
    const command = refund();
    const reply = await console.send(command);
    expect(reply.ok && (reply.data as { status: number }).status).toBe(200);
    expect(refunds).toEqual(['pay_1']);
    const [audit] = await store.listAuditEvents({ action: 'payment.refunded' });
    expect(audit?.actor).toBe('ops@hub.example (via Hub)');

    const raw = bus.connection();
    const signed = bus.published.find(
      (p) => p.channel === COMMAND_CHANNEL && p.message.includes(command.id),
    )!;
    // A replay (same id): the claim refuses it.
    await raw.publish(COMMAND_CHANNEL, signed.message);
    // A tampered copy (another id and actor, every capability): the MAC fails.
    await raw.publish(
      COMMAND_CHANNEL,
      JSON.stringify({
        ...JSON.parse(signed.message),
        id: randomUUID(),
        actor: 'mallory',
        capabilities: ['*'],
      }),
    );
    // A stale command, signed over a minute ago: refused even with a new id.
    const old = Date.now() - 120_000;
    const realNow = Date.now;
    Date.now = () => old;
    let staleWire: string;
    try {
      const stale = new RedisConsoleChannel({
        client: {
          publish: async (_channel: string, message: string) => {
            staleWire = message;
            return 1;
          },
          subscribe: async () => undefined,
        },
        prefix: PREFIX,
        secret: SECRET,
      });
      void stale.send(refund(), { timeoutMs: 50 }).catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      Date.now = realNow;
    }
    await raw.publish(COMMAND_CHANNEL, staleWire!);
    await tick();
    expect(refunds).toEqual(['pay_1']);
  });

  it('ignores a forged answer and waits for the real one', async () => {
    const bus = new RedisBus();
    const raw = bus.connection();
    // A rogue subscriber answers every command first ("refunded").
    await raw.subscribe(COMMAND_CHANNEL, (message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish(
        REPLY_CHANNEL,
        JSON.stringify({ id, ok: true, data: { status: 200, body: { forged: true } } }),
      );
    });
    await owningApp(bus, { secret: SECRET });
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: SECRET,
    });
    const reply = await console.send(refund());
    expect(reply.ok && (reply.data as { body: { forged?: boolean } }).body.forged).toBeUndefined();
  });

  it('does not trust a `verified` field on the wire', async () => {
    const bus = new RedisBus();
    const seen: ConsoleCommand[] = [];
    const app = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: SECRET,
    });
    await app.answer(async (command) => {
      seen.push(command);
      return null;
    });
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: SECRET,
    });
    await console.send({
      ...refund(),
      verified: { partition: 'et', capabilities: ['*'] },
    } as ConsoleCommand);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.verified).toBeUndefined();
    expect(seen[0]).not.toHaveProperty('mac');
  });
});

describe('token mode (authkit)', () => {
  async function setup() {
    const bus = new RedisBus();
    const keys = consoleCommandKeys(APP_KEY, PREFIX);
    const app = await owningApp(bus, { verifyTenant, keys, partition: 'et' });
    // What `node ace payments:console-key` prints, pasted in the console's config.
    const { d: _d, ...printed } = keys.publicKey;
    const publicKey = parseConsolePublicKey(JSON.stringify(printed))!;
    const consoleWith = (token: string, onReset?: () => void) =>
      new RedisConsoleChannel({
        client: bus.connection(),
        prefix: PREFIX,
        token: Object.assign(async () => token, { reset: () => onReset?.() }),
        recipient: async () => publicKey,
      });
    return { bus, ...app, consoleWith, publicKey };
  }

  it('runs a refund whose token the app verifies, with the token never readable on Redis', async () => {
    const { bus, refunds, store, consoleWith } = await setup();
    const reply = await consoleWith('hub-operator').send(refund());
    expect(reply.ok && (reply.data as { status: number }).status).toBe(200);
    expect(refunds).toEqual(['pay_1']);
    // The token's client is recorded next to the person.
    const [audit] = await store.listAuditEvents({ action: 'payment.refunded' });
    expect(audit?.actor).toBe('ops@hub.example (via Hub, client hub)');
    expect(bus.wire).not.toContain('hub-operator');
    expect(commandsOn(bus)).not.toContain('pay_1');
    expect(commandsOn(bus)).not.toContain('ops@hub.example');
  });

  it('refuses an unknown token with 401 (and the console drops its cached token)', async () => {
    const { refunds, consoleWith } = await setup();
    let resets = 0;
    const reply = await consoleWith('stolen-or-made-up', () => {
      resets += 1;
    }).send(refund());
    expect(reply).toMatchObject({ ok: false, error: { code: UNAUTHORIZED_CONSOLE, status: 401 } });
    expect(resets).toBe(1);
    expect(refunds).toHaveLength(0);
  });

  it('lets the token decide the app and the capabilities, whatever the message claims', async () => {
    const { refunds, consoleWith } = await setup();
    // A token for another app cannot act on this one.
    const other = await consoleWith('hub-other-app').send(refund());
    expect(other).toMatchObject({ ok: false, error: { status: 403 } });
    expect(!other.ok && other.error.message).toMatch(/token is for "billing-app"/);
    // A read-only token cannot refund, even when the message claims every capability.
    const reader = await consoleWith('hub-reader').send(refund({ capabilities: ['*'] }));
    expect(reader).toMatchObject({ ok: false, error: { status: 403 } });
    expect(!reader.ok && reader.error.message).toMatch(/token lacks "payments:console:refund"/);
    // A payments tenant's token (payments:refund, payments:read) is not a console's.
    const tenant = await consoleWith('tenant-of-the-control-plane').send(refund());
    expect(tenant).toMatchObject({ ok: false, error: { status: 403 } });
    const tenantProfile = await consoleWith('tenant-of-the-control-plane').send({
      id: randomUUID(),
      verb: 'profile',
      args: [],
      capabilities: ['payments:console:read'],
    });
    expect(tenantProfile).toMatchObject({ ok: false, error: { status: 403 } });
    // ...but may read the profile.
    const profile = await consoleWith('hub-reader').send({
      id: randomUUID(),
      verb: 'profile',
      args: [],
      capabilities: ['payments:console:read'],
    });
    expect(profile.ok).toBe(true);
    // The viewer's capabilities only narrow the token's: a viewer without refund is refused.
    const narrowed = await consoleWith('hub-operator').send(
      refund({ capabilities: ['payments:disputes:resolve'] }),
    );
    expect(narrowed).toMatchObject({ ok: false, error: { status: 403 } });
    // And a message with no capabilities at all is never "everything".
    const { capabilities: _c, ...bare } = refund();
    const missing = await consoleWith('hub-operator').send(bare);
    expect(missing).toMatchObject({ ok: false, error: { status: 403 } });
    expect(!missing.ok && missing.error.message).toMatch(/sent no capabilities/);
    expect(refunds).toEqual([]);
  });

  it('refuses unsealed, tampered and replayed commands', async () => {
    const { bus, refunds, errors, consoleWith } = await setup();
    const raw = bus.connection();
    await raw.publish(COMMAND_CHANNEL, JSON.stringify(forged()));
    await tick();
    expect(refunds).toHaveLength(0);
    expect(errors[0]).toMatchObject({ code: UNSIGNED_CHANNEL });

    // A real refund, then the sealed body under a new id, a bit-flipped copy and a replay.
    await consoleWith('hub-operator').send(refund());
    expect(refunds).toHaveLength(1);
    const sent = bus.published.find(
      (p) => p.channel === COMMAND_CHANNEL && p.message.includes('sealed'),
    )!;
    const wire = JSON.parse(sent.message) as { id: string; sealed: string };
    const flipped = wire.sealed.slice(0, -2) + (wire.sealed.endsWith('A') ? 'BB' : 'AA');
    await raw.publish(COMMAND_CHANNEL, JSON.stringify({ id: randomUUID(), sealed: wire.sealed }));
    await raw.publish(COMMAND_CHANNEL, JSON.stringify({ ...wire, sealed: flipped }));
    await raw.publish(COMMAND_CHANNEL, sent.message);
    await tick();
    expect(refunds).toHaveLength(1);
  });

  it('ignores a forged answer', async () => {
    const { bus, consoleWith } = await setup();
    const raw = bus.connection();
    await raw.subscribe(COMMAND_CHANNEL, (message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish(REPLY_CHANNEL, JSON.stringify({ id, ok: true, data: 'forged' }));
    });
    const reply = await consoleWith('hub-operator').send({
      id: randomUUID(),
      verb: 'profile',
      args: [],
    });
    expect(reply.ok && reply.data).not.toBe('forged');
  });

  it('the console takes the app key from its config (or authkit), never from Redis', () => {
    const store = new InMemoryBillingStore();
    // A token without crypto and without a key is a boot error (it may come from authkit's
    // directory, which only the boot knows about): see auto_auth.spec.ts.
    const { publicKey, privateKey } = consoleCommandKeys(APP_KEY, PREFIX);
    expect(() =>
      validateFederatedPaymentsApp('et', {
        store,
        controlPlane: { prefix: PREFIX, token: 'hub-operator', publicKey: privateKey },
      }),
    ).toThrow(/without its private part/);
    const { d: _d, ...pub } = publicKey;
    expect(() =>
      validateFederatedPaymentsApp('et', {
        store,
        controlPlane: { prefix: PREFIX, token: 'hub-operator', publicKey: JSON.stringify(pub) },
      }),
    ).not.toThrow();
    // The same APP_KEY and prefix always derive the same key; another prefix, another key.
    expect(consoleCommandKeys(APP_KEY, PREFIX).publicKey.kid).toBe(publicKey.kid);
    expect(consoleCommandKeys(APP_KEY, 'other').publicKey.kid).not.toBe(publicKey.kid);
  });

  it('works end to end through the federated console', async () => {
    const { bus, refunds, publicKey } = await setup();
    const hub = new FederatedPaymentsConsole(
      {
        et: {
          store: new InMemoryBillingStore(),
          controlPlane: { prefix: PREFIX, token: 'hub-operator', publicKey },
        },
      },
      { redis: async () => bus.connection() },
    );
    const answer = await hub.dispatch(
      'et',
      'refund',
      { params: { gatewayId: 'pay_1' }, query: {}, body: {} },
      {
        currency: 'BRL',
        meta: {
          actor: 'ops@hub.example',
          capabilities: ['payments:refund'],
          idempotencyKey: 'refund-hub-0001',
        },
      },
    );
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(refunds).toEqual(['pay_1']);
    await hub.close();
  });
});

describe('sealed with @adonis-agora/crypto', () => {
  async function setup(options: { verify?: boolean } = {}) {
    const bus = new RedisBus();
    const server = new FakeCryptoServer();
    // The app: may only decrypt with the key (its crypto token: crypto:decrypt:console-payments).
    const app = await owningApp(bus, {
      crypto: { cipher: server.cipherFor({ decrypt: ['console-payments'] }) },
      ...(options.verify ? { verifyTenant } : {}),
    });
    let resolved = 0;
    const console = (token?: string) =>
      new RedisConsoleChannel({
        client: bus.connection(),
        prefix: PREFIX,
        crypto: {
          // Lazy, like `() => crypto.client!` in config/payments_dashboard.ts.
          cipher: () => {
            resolved += 1;
            return server.cipherFor({ encrypt: ['console-payments'] });
          },
        },
        ...(token !== undefined ? { token } : {}),
      });
    return { bus, server, ...app, console, resolvedCount: () => resolved };
  }

  it('runs a refund the console encrypted and the app decrypted, with nothing readable on Redis', async () => {
    const { bus, server, refunds, console, resolvedCount } = await setup();
    expect(resolvedCount()).toBe(0);
    const reply = await console().send(refund());
    expect(reply.ok && (reply.data as { status: number }).status).toBe(200);
    expect(resolvedCount()).toBe(1);
    expect(refunds).toEqual(['pay_1']);
    expect(commandsOn(bus)).not.toContain('pay_1');
    expect(commandsOn(bus)).not.toContain('ops@hub.example');
    expect(server.audit.map((row) => row.op)).toEqual(['encrypt', 'decrypt']);
    expect(server.audit[0]?.context).toContain('agora:console-command');
  });

  it('refuses commands from someone who cannot encrypt with the key', async () => {
    const { bus, server, refunds, errors } = await setup();
    const raw = bus.connection();
    server.keys.set('mine', randomBytes(32));
    const theirs = server.cipherFor({ encrypt: ['mine'] });
    const { ciphertext } = await theirs.encrypt({ key: 'mine', plaintext: '{}', aad: 'x' });
    await raw.publish(COMMAND_CHANNEL, JSON.stringify({ id: randomUUID(), sealed: ciphertext }));
    await raw.publish(
      COMMAND_CHANNEL,
      JSON.stringify({
        id: randomUUID(),
        sealed: `agora:ct1:console-payments:1:${randomBytes(64).toString('base64url')}`,
      }),
    );
    await raw.publish(COMMAND_CHANNEL, JSON.stringify(forged()));
    await tick(30);
    expect(refunds).toHaveLength(0);
    expect(errors).toHaveLength(3);
    for (const error of errors) expect(error).toMatchObject({ code: UNSIGNED_CHANNEL });
  });

  it('with verifyTenant on the app, the command must also carry a valid token', async () => {
    const { refunds, console } = await setup({ verify: true });
    const without = await console().send(refund());
    expect(without).toMatchObject({ ok: false, error: { code: UNAUTHORIZED_CONSOLE } });
    const reader = await console('hub-reader').send(refund());
    expect(reader).toMatchObject({ ok: false, error: { status: 403 } });
    const operator = await console('hub-operator').send(refund());
    expect(operator.ok && (operator.data as { status: number }).status).toBe(200);
    expect(refunds).toEqual(['pay_1']);
  });

  it('ignores a forged answer', async () => {
    const { bus, console } = await setup();
    const raw = bus.connection();
    await raw.subscribe(COMMAND_CHANNEL, (message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish(REPLY_CHANNEL, JSON.stringify({ id, ok: true, data: 'forged' }));
    });
    const reply = await console().send({ id: randomUUID(), verb: 'profile', args: [] });
    expect(reply.ok && reply.data).not.toBe('forged');
  });

  it('says so when crypto is not ready yet', async () => {
    const bus = new RedisBus();
    const channel = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      crypto: { cipher: () => undefined as never },
    });
    await expect(channel.send(refund(), { timeoutMs: 100 })).rejects.toThrow(
      /crypto\.cipher.*not ready/,
    );
  });
});

describe('migrating between modes', () => {
  it('an app accepts every mode it has configured at once', async () => {
    const bus = new RedisBus();
    const keys = consoleCommandKeys(APP_KEY, PREFIX);
    const { refunds } = await owningApp(bus, { secret: SECRET, verifyTenant, keys });
    const old = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: SECRET,
    });
    const { d: _d, ...publicKey } = keys.publicKey;
    const next = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      token: 'hub-operator',
      recipient: async () => publicKey,
    });
    expect((await old.send(refund())).ok).toBe(true);
    expect((await next.send(refund())).ok).toBe(true);
    expect(refunds).toEqual(['pay_1', 'pay_1']);
  });
});
