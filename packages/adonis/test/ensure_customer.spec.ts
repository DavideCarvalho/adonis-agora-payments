import { describe, expect, it, vi } from 'vitest';
import type { PaymentsDriver } from '../src/driver.js';
import { ensureCustomer } from '../src/ensure_customer.js';

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
});
