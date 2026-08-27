import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LucidBillingStore } from '../../src/billing/lucid_billing_store.js';
import type { PaymentsDriver } from '../../src/driver.js';
import { ensureCustomer } from '../../src/ensure_customer.js';
import { createIntegrationDatabase, type IntegrationDatabase } from './harness.js';

/**
 * The `billing_customers` mapping against real SQL.
 *
 * Worth its own integration coverage because the table has columns nothing else in the
 * package writes — `owner_type`/`owner_id`, the unique `gateway_id` — and because the whole
 * point of the mapping is that `payments:sync --all` can enumerate it. A registry that only
 * works in memory would leave that command exactly as inert as it was before.
 */
describe('customer registry (integration)', () => {
  let database: IntegrationDatabase;
  let store: LucidBillingStore;

  const driver = (id: string, provider: string) =>
    ({
      provider,
      createCustomer: async () => ({ id }),
    }) as unknown as PaymentsDriver;

  beforeAll(async () => {
    database = await createIntegrationDatabase('customer_registry_spec');
    store = new LucidBillingStore();
  });

  afterAll(async () => {
    await database?.teardown();
  });

  it('records a created customer and finds it by gateway id', async () => {
    await ensureCustomer(
      driver('cus_stripe_1', 'stripe'),
      undefined,
      { name: 'Ana', email: 'ana@x.com', taxId: '123', metadata: { phone: '+55' } },
      { store, owner: { type: 'User', id: 1 } },
    );

    const found = await store.findCustomerByGatewayId('cus_stripe_1');
    expect(found?.provider).toBe('stripe');
    expect(found?.ownerType).toBe('User');
    expect(found?.ownerId).toBe('1');
    expect(found?.email).toBe('ana@x.com');
    expect(found?.metadata).toEqual({ phone: '+55' });
    expect(await store.findCustomerByGatewayId('cus_nope')).toBeNull();
  });

  it('upserts on the gateway id rather than inserting a second row', async () => {
    await ensureCustomer(
      driver('cus_stripe_1', 'stripe'),
      'cus_stripe_1',
      { email: 'ana+new@x.com' },
      { store, owner: { type: 'User', id: 1 } },
    );

    expect(await store.listCustomers({ provider: 'stripe' })).toHaveLength(1);
    expect((await store.findCustomerByGatewayId('cus_stripe_1'))?.email).toBe('ana+new@x.com');
  });

  it('keeps one owner s customers at different gateways apart', async () => {
    await ensureCustomer(driver('cus_asaas_1', 'asaas'), undefined, { name: 'Ana' }, {
      store,
      owner: { type: 'User', id: 1 },
    });

    // The same owner, two providers — which is exactly what a single column on the user row
    // cannot represent, and why `provider` is part of the lookup rather than a filter.
    expect((await store.findCustomerByOwner('User', '1', 'stripe'))?.gatewayId).toBe(
      'cus_stripe_1',
    );
    expect((await store.findCustomerByOwner('User', '1', 'asaas'))?.gatewayId).toBe('cus_asaas_1');
    expect(await store.findCustomerByOwner('User', '1', 'woovi')).toBeNull();
    expect(await store.findCustomerByOwner('Tenant', '1', 'stripe')).toBeNull();
  });

  it('does not blank a recorded owner when a later call knows less', async () => {
    await ensureCustomer(driver('cus_stripe_1', 'stripe'), 'cus_stripe_1', {}, { store });

    const found = await store.findCustomerByGatewayId('cus_stripe_1');
    expect(found?.ownerType).toBe('User');
    expect(found?.ownerId).toBe('1');
    expect(found?.email).toBe('ana+new@x.com');
  });

  it('pages the listing the way payments:sync --all iterates it', async () => {
    for (let i = 0; i < 5; i++) {
      await store.saveCustomer({ gatewayId: `cus_bulk_${i}`, provider: 'woovi' });
    }

    const first = await store.listCustomers({ provider: 'woovi', limit: 2 });
    const second = await store.listCustomers({ provider: 'woovi', limit: 2, offset: 2 });
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(new Set([...first, ...second].map((row) => row.gatewayId)).size).toBe(4);

    // The provider filter is not decorative: it is what `--provider` narrows the reconcile to.
    expect(await store.listCustomers({ provider: 'woovi' })).toHaveLength(5);
    expect(await store.listCustomers({})).toHaveLength(7);
  });
});
