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
        apps: ['et', 1],
        capabilities: ['payments:refund', ''],
      }),
    ).toEqual({ allowed: true, apps: ['et'], capabilities: ['payments:refund'] });
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
    expect(await handler(['refund'])({ id: '1', verb: 'profile', args: [] })).toEqual({
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
