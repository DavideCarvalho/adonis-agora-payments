import { afterEach, describe, expect, it } from 'vitest';
import { PaymentsManager } from '../src/payments_manager.js';
import {
  getBillingStore,
  getPayments,
  lazyBillingStore,
  lazyPayments,
  lazyPaymentsDriver,
  resetBillingStore,
  resetPayments,
  setBillingStore,
  setPayments,
} from '../src/services/main.js';
import { FakePaymentsDriver } from '../src/testing/fake_payments_driver.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

afterEach(() => {
  resetPayments();
  resetBillingStore();
});

function manager(): PaymentsManager {
  const driver = new FakePaymentsDriver({ provider: 'fake' });
  return new PaymentsManager({ drivers: new Map([['fake', driver]]), methods: { pix: 'fake' } });
}

/**
 * `getPayments()` throws until the provider's `booted()` hook has run — and providers that
 * registered EARLIER boot first, so `@adonis-agora/durable` constructs workflow services
 * before payments has set anything. Resolving in a constructor therefore throws, and the app
 * that found this had the same four-line comment copy-pasted into four files explaining why
 * it could not.
 */
describe('lazy service accessors', () => {
  it('is safe in a field initializer before the provider has booted', () => {
    class GrantAccess {
      payments = lazyPayments();
      store = lazyBillingStore();
      pix = lazyPaymentsDriver('pix');
    }

    // Constructed BEFORE anything is set — this is the boot-order the comment described.
    const service = new GrantAccess();

    setPayments(manager());
    setBillingStore(new InMemoryBillingStore());

    expect(service.payments.driver('fake').provider).toBe('fake');
    expect(service.pix.provider).toBe('fake');
    expect(typeof service.store.savePayment).toBe('function');
  });

  it('resolves on first PROPERTY access, not at construction', () => {
    const lazy = lazyPayments();
    expect(() => lazy.driver).toThrow(/not ready yet/);
    setPayments(manager());
    expect(lazy.driver('fake').provider).toBe('fake');
  });

  it('keeps the eager accessors throwing for callers that want the assertion', () => {
    expect(() => getPayments()).toThrow(/not ready yet/);
    expect(() => getBillingStore()).toThrow(/not ready yet/);
  });

  it('is the real thing, not a look-alike: methods reach private state and instanceof holds', () => {
    const lazy = lazyPayments();
    setPayments(manager());
    // `#drivers` is a private field; a wrapper that forgot to bind to the instance throws
    // "Cannot read private member" here.
    expect([...lazy.drivers.keys()]).toEqual(['fake']);
    expect(lazy).toBeInstanceOf(PaymentsManager);
  });
});
