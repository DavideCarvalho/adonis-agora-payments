import { describe, expect, it } from 'vitest';
import PaymentsSync from '../commands/payments_sync.js';
import type { BillingStore } from '../src/billing/billing_store.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';
import type { Invoice, Payment } from '../src/types.js';

/**
 * `payments:sync` — the reconcile, and the three ways it used to make the tables LESS true.
 *
 * It stamped `paidAt: new Date()` on everything it wrote, so historic revenue moved into the
 * month the command ran and two runs in two months counted the same charge in both. It wrote
 * `status: 'paid'` and nothing else, counting every other state as "skipped (non-paid)" — so
 * the one drift a gateway-is-truth reconcile exists to correct (local says paid, gateway says
 * refunded) was the one it could not fix. And it took whatever `listInvoices` handed back as
 * the whole customer.
 */

const JANUARY = '2026-01-15T10:00:00.000Z';

interface Recorded {
  listed: string[];
  found: string[];
}

/** The minimum of a driver `payments:sync` touches: enumerate invoices, then ask the payment. */
function fakeDriver(
  invoices: Invoice[],
  payments: Record<string, Payment | null>,
  recorded: Recorded = { listed: [], found: [] },
) {
  return {
    recorded,
    provider: 'asaas',
    async listInvoices(customerId: string): Promise<Invoice[]> {
      recorded.listed.push(customerId);
      return invoices;
    },
    async findPayment(gatewayId: string): Promise<Payment | null> {
      recorded.found.push(gatewayId);
      return payments[gatewayId] ?? null;
    },
  };
}

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: 'pay_1',
    gatewayId: 'pay_1',
    provider: 'asaas',
    customerId: 'cus_1',
    status: 'paid',
    amount: { amount: 10_000, currency: 'brl' },
    createdAt: JANUARY,
    payload: {},
    ...over,
  };
}

function payment(over: Partial<Payment> = {}): Payment {
  return {
    id: 'pay_1',
    gatewayId: 'pay_1',
    provider: 'asaas',
    amount: { amount: 10_000, currency: 'brl' },
    status: 'paid',
    customerId: 'cus_1',
    payload: {},
    createdAt: JANUARY,
    paidAt: JANUARY,
    ...over,
  };
}

/**
 * Run the real `run()` body against fakes.
 *
 * The command is instantiated off its prototype rather than through ace: everything under
 * test is inside `run()`, and a real kernel would add a boot sequence without adding a single
 * assertion. `app`, `logger` and the flags are the whole surface it touches.
 */
async function runSync(
  store: BillingStore,
  driver: ReturnType<typeof fakeDriver>,
  flags: { customer?: string; all?: boolean } = { customer: 'cus_1' },
) {
  const logs: string[] = [];
  const command = Object.create(PaymentsSync.prototype) as PaymentsSync & Record<string, unknown>;
  const manager = {
    driver: () => driver,
    assertCapability: () => {},
  };
  // `logger` (and friends) are GETTERS on `BaseCommand`, so plain assignment throws.
  const fields: Record<string, unknown> = {
    ...flags,
    app: {
      config: { get: () => ({ billing: { store: async () => store } }) },
      container: { make: async () => manager },
    },
    logger: {
      info: (message: string) => logs.push(message),
      success: (message: string) => logs.push(message),
      warning: (message: string) => logs.push(`WARN ${message}`),
      error: (message: string) => logs.push(`ERROR ${message}`),
    },
  };
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(command, key, { value, writable: true, configurable: true });
  }
  await command.run();
  return logs;
}

describe('payments:sync settlement dates', () => {
  it('records the GATEWAY settlement date, not the moment the reconcile ran', async () => {
    // The bug: `paidAt: new Date()`. Run this in August and January's charge became August's
    // revenue — and running it again in September would move it a second time.
    const store = new InMemoryBillingStore();
    await runSync(store, fakeDriver([invoice()], { pay_1: payment() }));

    const row = await store.findPaymentByGatewayId('pay_1');
    expect(row?.status).toBe('paid');
    expect(row?.paidAt).toEqual(new Date(JANUARY));
  });

  it('invents no date when the gateway carries none', async () => {
    const store = new InMemoryBillingStore();
    await runSync(store, fakeDriver([invoice()], { pay_1: payment({ paidAt: undefined }) }));

    // `null`, not "now". A charge whose settlement date the gateway never stated is not a
    // charge that settled today.
    expect((await store.findPaymentByGatewayId('pay_1'))?.paidAt).toBeNull();
  });

  it('does not overwrite a paid_at already recorded', async () => {
    const store = new InMemoryBillingStore();
    await store.savePayment({
      gatewayId: 'pay_1',
      provider: 'asaas',
      status: 'pending',
      amount: 10_000,
      currency: 'brl',
      paidAt: new Date(JANUARY),
    });

    await runSync(
      store,
      fakeDriver([invoice()], { pay_1: payment({ paidAt: '2026-08-01T00:00:00.000Z' }) }),
    );

    const row = await store.findPaymentByGatewayId('pay_1');
    expect(row?.status).toBe('paid');
    expect(row?.paidAt).toEqual(new Date(JANUARY));
  });

  it('asks the gateway nothing once a row has converged', async () => {
    // What makes a repeated reconcile cheap: paid locally, paid at the gateway, dated. There
    // is nothing left for `findPayment` to say, so it is not called.
    const store = new InMemoryBillingStore();
    const driver = fakeDriver([invoice()], { pay_1: payment() });
    await runSync(store, driver);
    driver.recorded.found.length = 0;

    await runSync(store, driver);
    expect(driver.recorded.found).toEqual([]);
  });
});

describe('payments:sync reconciles in both directions', () => {
  it('corrects a local `paid` row the gateway says was refunded', async () => {
    // The exact drift the command exists for, and the one it could not fix: it only ever
    // wrote `paid`, and counted this invoice as "skipped (non-paid)".
    const store = new InMemoryBillingStore();
    await store.savePayment({
      gatewayId: 'pay_1',
      provider: 'asaas',
      status: 'paid',
      amount: 10_000,
      currency: 'brl',
      paidAt: new Date(JANUARY),
    });

    await runSync(
      store,
      // `Invoice['status']` has no `refunded` member, so a reversed charge lists as `draft`.
      fakeDriver([invoice({ status: 'draft' })], { pay_1: payment({ status: 'refunded' }) }),
    );

    expect((await store.findPaymentByGatewayId('pay_1'))?.status).toBe('refunded');
  });

  it('records a charge the gateway says failed, instead of calling it skipped', async () => {
    const store = new InMemoryBillingStore();
    await runSync(
      store,
      fakeDriver([invoice({ status: 'open' })], { pay_1: payment({ status: 'failed' }) }),
    );
    expect((await store.findPaymentByGatewayId('pay_1'))?.status).toBe('failed');
  });

  it('NEVER moves a locally disputed row, whatever the gateway says', async () => {
    // A chargeback is money the bank has pulled back. The gateway's payment resource often
    // still reports the charge as received, so reconciling it back to `paid` would re-count
    // money that is gone. Only the dispute's own close event resolves one.
    const store = new InMemoryBillingStore();
    await store.savePayment({
      gatewayId: 'pay_1',
      provider: 'asaas',
      status: 'disputed',
      amount: 10_000,
      currency: 'brl',
      paidAt: new Date(JANUARY),
    });

    const logs = await runSync(store, fakeDriver([invoice()], { pay_1: payment() }));

    expect((await store.findPaymentByGatewayId('pay_1'))?.status).toBe('disputed');
    expect(logs.join('\n')).toContain('disputed');
    expect(logs.join('\n')).toContain('left alone');
  });

  it('leaves a row alone when the gateway has no payment to answer with', async () => {
    const store = new InMemoryBillingStore();
    await runSync(store, fakeDriver([invoice()], {}));
    expect(await store.findPaymentByGatewayId('pay_1')).toBeNull();
  });
});
