import { describe, expect, it, vi } from 'vitest';
import type { PaymentsDriver } from '../src/driver.js';
import { ensureCustomer } from '../src/ensure_customer.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

describe('ensureCustomer', () => {
  it('returns the existing gateway customer id without calling the gateway', async () => {
    const createCustomer = vi.fn();
    const driver = { createCustomer } as unknown as PaymentsDriver;
    const result = await ensureCustomer(driver, 'cus_existing', {
      name: 'X',
      email: 'x@y.com',
    });
    expect(result).toEqual({ id: 'cus_existing' });
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it('creates the customer at the gateway when no id exists', async () => {
    const created = { id: 'cus_new', email: 'x@y.com', name: 'X' };
    const driver = {
      createCustomer: vi.fn().mockResolvedValue(created),
    } as unknown as PaymentsDriver;
    const result = await ensureCustomer(driver, undefined, {
      name: 'X',
      email: 'x@y.com',
    });
    expect(result).toEqual(created);
    expect(driver.createCustomer).toHaveBeenCalledWith({ name: 'X', email: 'x@y.com' });
  });

  describe('recording the mapping', () => {
    const driverWith = (id: string, provider = 'asaas') =>
      ({
        provider,
        createCustomer: vi.fn().mockResolvedValue({ id }),
      }) as unknown as PaymentsDriver;

    it('records nothing when no store is passed', async () => {
      const store = new InMemoryBillingStore();
      await ensureCustomer(driverWith('cus_new'), undefined, { name: 'X' });
      expect(await store.listCustomers({})).toEqual([]);
    });

    it('records the created customer against its owner and provider', async () => {
      const store = new InMemoryBillingStore();
      await ensureCustomer(
        driverWith('cus_new', 'woovi'),
        undefined,
        { name: 'Ana', email: 'ana@x.com', taxId: '123' },
        { store, owner: { type: 'User', id: 42 } },
      );

      const [recorded] = await store.listCustomers({});
      expect(recorded).toMatchObject({
        gatewayId: 'cus_new',
        provider: 'woovi',
        ownerType: 'User',
        // Stringified: ids are not uniformly numeric across apps.
        ownerId: '42',
        email: 'ana@x.com',
        name: 'Ana',
        taxId: '123',
      });
    });

    it('backfills on the REUSE branch too', async () => {
      const store = new InMemoryBillingStore();
      const driver = driverWith('unused');

      await ensureCustomer(
        driver,
        'cus_held_since_before',
        { name: 'Ana' },
        { store, owner: { type: 'User', id: 7 } },
      );

      // The whole point: an app that has held the id for months, from before it recorded
      // anything, gets the mapping written the next time this runs — without a gateway call.
      expect(driver.createCustomer).not.toHaveBeenCalled();
      expect(await store.findCustomerByGatewayId('cus_held_since_before')).toMatchObject({
        ownerId: '7',
      });
    });

    it('does not blank an existing mapping when a later call knows less', async () => {
      const store = new InMemoryBillingStore();
      await ensureCustomer(
        driverWith('cus_1'),
        undefined,
        { name: 'Ana', email: 'ana@x.com' },
        { store, owner: { type: 'User', id: 1 } },
      );

      // A reconcile knows the gateway id and nothing else.
      await ensureCustomer(driverWith('cus_1'), 'cus_1', {}, { store });

      expect(await store.findCustomerByGatewayId('cus_1')).toMatchObject({
        ownerType: 'User',
        ownerId: '1',
        email: 'ana@x.com',
        name: 'Ana',
      });
    });

    it('records the gateway id even with no owner, so --all can reconcile over it', async () => {
      const store = new InMemoryBillingStore();
      await ensureCustomer(driverWith('cus_anon'), undefined, {}, { store });

      const [recorded] = await store.listCustomers({});
      expect(recorded).toMatchObject({ gatewayId: 'cus_anon', ownerType: null, ownerId: null });
    });
  });
});
