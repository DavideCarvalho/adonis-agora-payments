import { describe, expect, it } from 'vitest';
import { normalizeConsoleAuthorizeResult } from '../../src/dashboard/console_authorize.js';
import { resolveConfig } from '../../src/dashboard/define_config.js';
import {
  consoleRouteName,
  FEDERATED_ACTIONS,
  federatedActionOf,
  idempotencyKeyOf,
  paymentsConsoleCommandHandler,
  resolveConsoleCommands,
  validateConsoleCommands,
} from '../../src/federation/console.js';
import {
  actionFingerprint,
  memoryIdempotencyStore,
  redisIdempotencyStore,
} from '../../src/federation/idempotency.js';
import {
  capabilityAllows,
  federatedSafe,
  maskDocument,
  ReadOnlyStoreError,
  readOnlyBillingStore,
} from '../../src/federation/safety.js';
import { InMemoryBillingStore } from '../../src/testing/in_memory_billing_store.js';
import { RedisBus } from './redis_bus.js';

describe('masking', () => {
  it('masks a CPF, a CNPJ and anything else partially', () => {
    expect(maskDocument('123.456.789-09')).toBe('***.456.789-**');
    expect(maskDocument('12345678909')).toBe('***.456.789-**');
    expect(maskDocument('12.345.678/0001-90')).toBe('12.345.678/****-**');
    expect(maskDocument('AB123456')).toBe('******56');
    expect(maskDocument(null)).toBeNull();
    // Masking twice changes nothing.
    expect(maskDocument('***.456.789-**')).toBe('***.456.789-**');
  });

  it('drops credentials, payloads and PIX codes, and reduces cards to brand + last 4', () => {
    const safe = federatedSafe({
      taxId: '12345678909',
      apiKey: 'sk_live_x',
      webhookSecret: 'whsec_x',
      accessToken: 't',
      payload: { anything: true },
      card: { brand: 'visa', number: '4242424242424242', cvc: '123' },
      paymentMethod: { card: { brand: 'mastercard', last4: '4444', exp_month: 1 } },
      message: 'declined 4242 4242 4242 4242 and 00020126580014br.gov.bcb.pix0136a629534e',
      gatewayId: '4242424242424242',
      nested: [{ cpfCnpj: '12.345.678/0001-90', when: new Date('2026-01-01T00:00:00Z') }],
    });
    expect(safe).toEqual({
      taxId: '***.456.789-**',
      card: { brand: 'visa', last4: '4242' },
      paymentMethod: { brand: 'mastercard', last4: '4444' },
      message: 'declined •••• 4242 and [pix code redacted]',
      // An identifier is never rewritten, even when it looks like a card number.
      gatewayId: '4242424242424242',
      nested: [{ cpfCnpj: '12.345.678/****-**', when: '2026-01-01T00:00:00.000Z' }],
    });
  });

  it("refuses every write on another app's store, and masks its customers", async () => {
    const store = new InMemoryBillingStore();
    await store.saveCustomer({ gatewayId: 'c', provider: 'stripe', taxId: '12345678909' });
    const readOnly = readOnlyBillingStore(store);
    expect((await readOnly.findCustomerByGatewayId('c'))?.taxId).toBe('***.456.789-**');
    expect((await readOnly.listCustomers({}))[0]?.taxId).toBe('***.456.789-**');
    expect(() =>
      readOnly.savePayment({
        gatewayId: 'p',
        provider: 'stripe',
        status: 'paid',
        amount: 1,
        currency: 'BRL',
      }),
    ).toThrow(ReadOnlyStoreError);
    expect(() => readOnly.recordAuditEvent({ action: 'x' })).toThrow(ReadOnlyStoreError);
    expect(() => readOnly.markWebhookFailed('x', 'y')).toThrow(ReadOnlyStoreError);
    // The owning app's own row is untouched by the console's masking.
    expect((await store.findCustomerByGatewayId('c'))?.taxId).toBe('12345678909');
  });
});

describe('capabilities', () => {
  it('matches exactly or by wildcard, and nothing when none were granted', () => {
    expect(capabilityAllows(['payments:refund'], 'payments:refund')).toBe(true);
    expect(capabilityAllows(['payments:*'], 'payments:subscriptions:cancel')).toBe(true);
    expect(capabilityAllows(['payments:subscriptions:*'], 'payments:refund')).toBe(false);
    expect(capabilityAllows(['*'], 'payments:refund')).toBe(true);
    expect(capabilityAllows(undefined, 'payments:refund')).toBe(false);
    expect(capabilityAllows([], 'payments:refund')).toBe(false);
  });

  it('authorize may grant apps and capabilities', () => {
    expect(
      normalizeConsoleAuthorizeResult({
        allowed: true,
        apps: ['et', 1, null],
        capabilities: ['payments:refund', ''],
      }),
    ).toEqual({ allowed: true, apps: ['et', '1'], capabilities: ['payments:refund'] });
    expect(normalizeConsoleAuthorizeResult({ allowed: true, apps: '*' })).toEqual({
      allowed: true,
      apps: '*',
    });
  });

  it('every action is a console route with a capability', () => {
    for (const [action, { route, capability }] of Object.entries(FEDERATED_ACTIONS)) {
      expect(federatedActionOf(route)).toBe(action);
      expect(capability).toMatch(/^payments:/);
    }
    expect(consoleRouteName(() => undefined)).toBeUndefined();
  });
});

describe('idempotency', () => {
  for (const [name, make] of [
    ['memory', () => memoryIdempotencyStore()],
    ['redis', () => redisIdempotencyStore(new RedisBus().connection(), 'app')],
  ] as const) {
    it(`${name}: a key runs once, replays its answer, refuses other arguments`, async () => {
      const store = make();
      const fp = actionFingerprint('refund', { params: { gatewayId: 'p' }, body: {} });
      expect(await store.begin('key-00000001', fp)).toEqual({ state: 'new' });
      expect(await store.begin('key-00000001', fp)).toEqual({ state: 'running' });
      await store.finish('key-00000001', fp, { status: 200, body: { ok: 1 } });
      expect(await store.begin('key-00000001', fp)).toEqual({
        state: 'done',
        reply: { status: 200, body: { ok: 1 } },
      });
      const other = actionFingerprint('refund', { params: { gatewayId: 'q' }, body: {} });
      expect(await store.begin('key-00000001', other)).toEqual({ state: 'mismatch' });
    });
  }

  it('the fingerprint ignores key order', () => {
    expect(actionFingerprint('a', { x: 1, y: { b: 2, a: 1 } })).toBe(
      actionFingerprint('a', { y: { a: 1, b: 2 }, x: 1 }),
    );
  });

  it('reads the key from the header, else the body', () => {
    expect(idempotencyKeyOf('h-key', { idempotencyKey: 'b-key' })).toBe('h-key');
    expect(idempotencyKeyOf(undefined, { idempotencyKey: 'b-key' })).toBe('b-key');
    expect(idempotencyKeyOf(undefined, {})).toBeUndefined();
  });
});

describe('configuration', () => {
  it('consoleCommands: actions are allow-listed by name, off by default', () => {
    expect(resolveConsoleCommands(true, 'shop')).toMatchObject({ prefix: 'shop' });
    expect([...(resolveConsoleCommands(true, 'shop')?.actions ?? [])]).toEqual([]);
    expect(resolveConsoleCommands(undefined, 'shop')).toBeUndefined();
    expect(() => validateConsoleCommands({ actions: ['refund', 'payout'] }, 'standalone')).toThrow(
      /unknown action "payout"/,
    );
    expect(() => validateConsoleCommands(true, 'tenant')).toThrow(/tenant/);
    expect(() => validateConsoleCommands({ actions: ['refund'] }, undefined)).not.toThrow();
  });

  it('payments_dashboard.apps is checked at boot', () => {
    expect(() =>
      resolveConfig({
        apps: { 'bad key!': { store: {}, controlPlane: { prefix: 'x' } } },
      }),
    ).toThrow(/the key must be/);
    expect(() =>
      resolveConfig({ apps: { et: { store: {}, controlPlane: { prefix: '' } } } }),
    ).toThrow(/controlPlane.prefix/);
    expect(
      resolveConfig({ apps: { et: { store: {}, controlPlane: { prefix: 'et' } } } }).apps,
    ).toHaveProperty('et');
  });
});

describe('the owning app’s command handler', () => {
  const handler = (actions: string[]) =>
    paymentsConsoleCommandHandler({
      actions: new Set(actions as never),
      idempotency: memoryIdempotencyStore(),
      runtime: {
        currency: 'BRL',
        store: () => new InMemoryBillingStore(),
        actions: async () => ({}),
        capabilities: async () => ({
          stripe: {
            refunds: true,
            disputes: false,
            cancelSubscription: true,
            updateSubscription: false,
          },
        }),
      },
    });

  it('answers its profile with booleans and the allowed actions', async () => {
    // Reads need their capability too, and a command without capabilities is refused.
    await expect(handler(['refund'])({ id: '0', verb: 'profile', args: [] })).rejects.toMatchObject(
      { status: 403 },
    );
    await expect(
      handler(['refund'])({
        id: '0b',
        verb: 'profile',
        args: [],
        capabilities: ['payments:refund'],
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await handler(['refund'])({
        id: '1',
        verb: 'profile',
        args: [],
        capabilities: ['payments:console:read'],
      }),
    ).toEqual({
      capabilities: {
        stripe: {
          refunds: true,
          disputes: false,
          cancelSubscription: true,
          updateSubscription: false,
        },
      },
      actions: ['refund'],
    });
  });

  it('refuses an action it did not allow-list, a missing capability, a missing key', async () => {
    const args = [{ params: { gatewayId: 'p' }, body: {}, idempotencyKey: 'key-00000001' }];
    await expect(
      handler([])({ id: '1', verb: 'refund', args, capabilities: ['payments:*'] }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(handler(['refund'])({ id: '2', verb: 'refund', args })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      handler(['refund'])({
        id: '3',
        verb: 'refund',
        args: [{ params: { gatewayId: 'p' }, body: {} }],
        capabilities: ['payments:refund'],
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(handler(['refund'])({ id: '4', verb: 'payout', args })).rejects.toMatchObject({
      code: 'unsupported-request',
    });
  });
});

describe('viewer capabilities (§10)', () => {
  it('keeps only what reaches the payments console; the full set when authorize said none', async () => {
    const { viewerConsoleCapabilities, CONSOLE_CAPABILITIES } = await import(
      '../../src/federation/console.js'
    );
    expect(viewerConsoleCapabilities(undefined)).toEqual([...CONSOLE_CAPABILITIES]);
    expect(
      viewerConsoleCapabilities([
        'flags:console:*',
        'payments:refund',
        'payments:console:read',
        'config:write',
        '*',
      ]),
    ).toEqual(['payments:refund', 'payments:console:read', '*']);
    expect(viewerConsoleCapabilities([])).toEqual([]);
    // access: 'read' keeps reads only, whatever was granted.
    expect(viewerConsoleCapabilities(['*'], 'read')).toEqual(['payments:console:read']);
    expect(viewerConsoleCapabilities(undefined, 'read')).toEqual(['payments:console:read']);
    expect(viewerConsoleCapabilities(['flags:*'], 'read')).toEqual([]);
  });

  it('normalizes authorize: malformed capabilities grant nothing, access read is kept', () => {
    expect(normalizeConsoleAuthorizeResult({ allowed: true, capabilities: 'payments:*' })).toEqual({
      allowed: true,
      capabilities: [],
    });
    expect(normalizeConsoleAuthorizeResult({ allowed: true })).toEqual({ allowed: true });
    expect(normalizeConsoleAuthorizeResult({ allowed: true, access: 'read' })).toEqual({
      allowed: true,
      access: 'read',
    });
    // Only 'read' and 'write' are kept (the shared contract).
    expect(normalizeConsoleAuthorizeResult({ allowed: true, access: 'write' })).toEqual({
      allowed: true,
      access: 'write',
    });
    expect(normalizeConsoleAuthorizeResult({ allowed: true, access: 'bogus' })).toEqual({
      allowed: true,
    });
  });

  it('anyAuthorize keeps the deciding authorizer’s apps, tenants, capabilities and access', async () => {
    const { anyAuthorize } = await import('../../src/dashboard/console_authorize.js');
    const decide = anyAuthorize(
      () => false,
      () => ({
        allowed: true,
        apps: ['et'],
        tenants: '*',
        capabilities: ['payments:console:read'],
        access: 'read',
      }),
    );
    expect(await decide({} as never)).toEqual({
      allowed: true,
      apps: ['et'],
      tenants: '*',
      capabilities: ['payments:console:read'],
      access: 'read',
    });
  });

  it('a command without capabilities is refused with code capabilities-required', async () => {
    const { paymentsConsoleCommandHandler, CAPABILITIES_REQUIRED } = await import(
      '../../src/federation/console.js'
    );
    const run = paymentsConsoleCommandHandler({
      actions: new Set(),
      idempotency: memoryIdempotencyStore(),
      runtime: {
        currency: 'BRL',
        store: () => new InMemoryBillingStore(),
        actions: async () => ({}),
        capabilities: async () => ({}),
      },
    });
    await expect(run({ id: '1', verb: 'profile', args: [] })).rejects.toMatchObject({
      status: 403,
      code: CAPABILITIES_REQUIRED,
    });
    expect(CAPABILITIES_REQUIRED).toBe('capabilities-required');
    await expect(
      run({ id: '2', verb: 'profile', args: [], capabilities: ['flags:console:read'] }),
    ).rejects.toThrow(/the viewer lacks "payments:console:read"/);
  });
});

describe('the console on its own app (§10.13)', () => {
  it('runs writes by the same capabilities as on another app', async () => {
    const { viewerLocalRefusal, viewerLocalActions } = await import(
      '../../src/federation/console.js'
    );
    // No capabilities from authorize: full access.
    expect(viewerLocalRefusal('refund', undefined)).toBeUndefined();
    expect(viewerLocalActions(undefined)).toBeUndefined();
    // Reads are never refused.
    expect(viewerLocalRefusal('payments', [])).toBeUndefined();
    expect(viewerLocalRefusal('refund', ['payments:refund'])).toBeUndefined();
    expect(viewerLocalRefusal('refund', ['payments:console:refund'])).toBeUndefined();
    expect(viewerLocalRefusal('evidence', ['payments:console:write'])).toBeUndefined();
    expect(viewerLocalRefusal('refund', ['payments:console:read'])).toMatch(
      /^the viewer lacks "payments:refund"/,
    );
    expect(viewerLocalRefusal('refund', ['*'], 'read')).toMatch(/read access only/);
    expect(viewerLocalActions(['payments:refund', 'payments:disputes:resolve'])).toEqual([
      'refund',
      'resolve',
    ]);
    expect(viewerLocalActions(['*'], 'read')).toEqual([]);
  });
});

describe('order of the checks (§10.18)', () => {
  it('verb → capabilities → token → viewer → partition → actions', async () => {
    const { paymentsConsoleCommandHandler, CAPABILITIES_REQUIRED, UNSUPPORTED } = await import(
      '../../src/federation/console.js'
    );
    const run = paymentsConsoleCommandHandler({
      actions: new Set(),
      partition: 'et',
      idempotency: memoryIdempotencyStore(),
      runtime: {
        currency: 'BRL',
        store: () => new InMemoryBillingStore(),
        actions: async () => ({}),
        capabilities: async () => ({}),
      },
    });
    const wrongApp = { partition: 'other', capabilities: ['payments:console:*'] };
    const reader = { partition: 'other', capabilities: ['payments:console:read'] };
    // Unknown verb first, whatever else is wrong.
    await expect(
      run({ id: '1', verb: 'payout', args: [], verified: wrongApp }),
    ).rejects.toMatchObject({ code: UNSUPPORTED });
    // Then capabilities present, before the token's partition.
    await expect(
      run({ id: '2', verb: 'refund', args: [], verified: wrongApp }),
    ).rejects.toMatchObject({ code: CAPABILITIES_REQUIRED });
    // Then the token's capabilities, then the viewer's, before the partition.
    await expect(
      run({ id: '3', verb: 'refund', args: [], capabilities: ['*'], verified: reader }),
    ).rejects.toThrow(/console's token lacks/);
    await expect(
      run({
        id: '4',
        verb: 'refund',
        args: [],
        capabilities: ['payments:console:read'],
        verified: wrongApp,
      }),
    ).rejects.toThrow(/the viewer lacks/);
    await expect(
      run({ id: '5', verb: 'refund', args: [], capabilities: ['*'], verified: wrongApp }),
    ).rejects.toThrow(/token is for "other"/);
    // Last, the app's own allow-list.
    await expect(
      run({
        id: '6',
        verb: 'refund',
        args: [],
        capabilities: ['*'],
        verified: { partition: 'et', capabilities: ['payments:console:*'] },
      }),
    ).rejects.toThrow(/consoleCommands\.actions/);
  });
});

describe('capability look-alikes (§10.16)', () => {
  it('a `*` anywhere but at the end of a payments name grants nothing extra', async () => {
    const { consoleTokenAllows, consoleViewerAllows, viewerLocalRefusal } = await import(
      '../../src/federation/console.js'
    );
    for (const lookAlike of [
      'payments:*:refund',
      'payments:console:r*',
      '*:console:*',
      'payments:console*',
      '*payments',
      'payments:conso*',
    ]) {
      expect(consoleTokenAllows([lookAlike], 'refund')).toBe(false);
      expect(consoleTokenAllows([lookAlike], 'profile')).toBe(false);
      expect(consoleViewerAllows([lookAlike], 'refund')).toBe(false);
      expect(viewerLocalRefusal('refund', [lookAlike])).toMatch(/the viewer lacks/);
    }
    // The five aliases, literally, and payments' own trailing-`*` hierarchy.
    for (const alias of ['*', 'payments:*', 'payments:console:*', 'payments:console:write']) {
      expect(consoleTokenAllows([alias], 'refund')).toBe(true);
    }
    expect(consoleTokenAllows(['payments:console:read'], 'profile')).toBe(true);
    expect(consoleTokenAllows(['payments:console:read'], 'refund')).toBe(false);
    expect(consoleTokenAllows(['payments:console:subscriptions:*'], 'cancelSubscription')).toBe(
      true,
    );
    expect(consoleTokenAllows(['payments:console:subscriptions:*'], 'refund')).toBe(false);
  });
});

describe('the shared matcher (§10.16b)', () => {
  it('routes payments console checks through consoleCapabilityAllows with payments’ table', async () => {
    const { consoleTokenAllows, consoleViewerAllows, PAYMENTS_CONSOLE_CAPABILITIES } = await import(
      '../../src/federation/console.js'
    );
    const { consoleCapabilityAllows } = await import('../../src/dashboard/console_capabilities.js');
    // Write implies read.
    expect(consoleTokenAllows(['payments:console:write'], 'profile')).toBe(true);
    // A tenant's data-operation names never make a token a console.
    expect(consoleTokenAllows(['payments:refund', 'payments:read'], 'refund')).toBe(false);
    // Viewer names keep their trailing-`*` hierarchy under `payments:`.
    expect(consoleViewerAllows(['payments:subscriptions:*'], 'cancelSubscription')).toBe(true);
    expect(consoleViewerAllows(['payments:subscriptions:*'], 'refund')).toBe(false);
    // Another namespace never reaches payments.
    expect(
      consoleCapabilityAllows(
        ['flags:*'],
        'payments:console:refund',
        PAYMENTS_CONSOLE_CAPABILITIES,
      ),
    ).toBe(false);
  });
});
