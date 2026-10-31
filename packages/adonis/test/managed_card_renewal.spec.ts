import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillingStore } from '../src/billing/billing_store.js';
import {
  createManagedSubscription,
  renewDueManagedSubscriptions,
  updateManagedPaymentMethod,
} from '../src/billing/managed_subscriptions.js';
import type { PaymentsDriver } from '../src/driver.js';
import { AsaasDriver } from '../src/drivers/asaas.js';
import { cycleReference, routingReference } from '../src/drivers/shared.js';
import { FakePaymentsDriver } from '../src/testing/fake_payments_driver.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

type ChargeInput = Parameters<PaymentsDriver['charge']>[0];

class RecordingDriver extends FakePaymentsDriver {
  readonly inputs: ChargeInput[] = [];
  failures = 0;
  async charge(input: ChargeInput) {
    this.inputs.push(input);
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('Transação não autorizada');
    }
    return super.charge(input);
  }
}

const card = {
  token: 'tok_1',
  holder: {
    name: 'A',
    email: 'a@b.c',
    cpfCnpj: '1',
    postalCode: '1',
    addressNumber: '1',
    phone: '1',
  },
};

async function subscribed(driver: PaymentsDriver, billing: BillingStore, withCard = true) {
  return createManagedSubscription(driver, billing, {
    customerId: 'cus_1',
    planId: 'p',
    amount: 4900,
    cycle: 'MONTHLY',
    method: withCard ? 'credit_card' : 'pix',
    startDate: '2026-01-10',
    externalReference: 'sub:abc',
    ...(withCard ? { card } : {}),
  });
}

const store = () => new InMemoryBillingStore() as unknown as BillingStore;
const DUE = new Date('2026-02-10T00:00:00Z');

describe('managed card renewal', () => {
  it('a card declined at signup leaves nothing to renew', async () => {
    const driver = new RecordingDriver();
    const billing = store();
    driver.failures = 1;

    await expect(subscribed(driver, billing)).rejects.toThrow('Transação não autorizada');

    expect(await renewDueManagedSubscriptions(() => driver, billing, { now: DUE })).toEqual([]);
    expect(driver.inputs).toHaveLength(1);
  });

  it('charges the saved token on every renewal, without resending holder data', async () => {
    const driver = new RecordingDriver();
    const billing = store();
    await subscribed(driver, billing);

    const [outcome] = await renewDueManagedSubscriptions(() => driver, billing, { now: DUE });

    expect(outcome).toMatchObject({ result: 'charged' });
    expect(driver.inputs[1]).toMatchObject({ paymentMethodId: 'tok_1', method: 'credit_card' });
    expect(driver.inputs[1]?.card).toBeUndefined();
  });

  it('sends no payment method for a subscription that never had a card', async () => {
    const driver = new RecordingDriver();
    const billing = store();
    await subscribed(driver, billing, false);

    await renewDueManagedSubscriptions(() => driver, billing, { now: DUE });

    expect(driver.inputs[1]?.paymentMethodId).toBeUndefined();
  });

  it('backs off between failed attempts and reports the streak', async () => {
    const driver = new RecordingDriver();
    const billing = store();
    await subscribed(driver, billing);
    driver.failures = 2;

    const [first] = await renewDueManagedSubscriptions(() => driver, billing, { now: DUE });
    expect(first).toMatchObject({
      result: 'failed',
      failureCount: 1,
      externalReference: 'sub:abc',
    });

    // Next hourly tick is inside the delay: the card is not touched again.
    const tick = new Date(DUE.getTime() + 30 * 60 * 1000);
    expect(await renewDueManagedSubscriptions(() => driver, billing, { now: tick })).toEqual([]);
    expect(driver.inputs).toHaveLength(2);

    const later = new Date(DUE.getTime() + 2 * 60 * 60 * 1000);
    const [second] = await renewDueManagedSubscriptions(() => driver, billing, { now: later });
    expect(second).toMatchObject({ result: 'failed', failureCount: 2 });

    const muchLater = new Date(DUE.getTime() + 24 * 60 * 60 * 1000);
    const [third] = await renewDueManagedSubscriptions(() => driver, billing, { now: muchLater });
    expect(third).toMatchObject({ result: 'charged' });
    // Same period the failures were for: a retry does not skip or double a month.
    expect(driver.inputs[3]?.idempotencyKey).toBe(driver.inputs[1]?.idempotencyKey);
  });

  it('treats a charge the gateway answered as failed like a thrown one', async () => {
    class DecliningDriver extends RecordingDriver {
      declined = false;
      async charge(input: ChargeInput) {
        const payment = await super.charge(input);
        return this.declined ? { ...payment, status: 'failed' as const } : payment;
      }
    }
    const driver = new DecliningDriver();
    const billing = store();
    await subscribed(driver, billing);
    driver.declined = true;

    const [outcome] = await renewDueManagedSubscriptions(() => driver, billing, { now: DUE });

    expect(outcome).toMatchObject({ result: 'failed', failureCount: 1 });
  });

  it('a new card replaces the token and is tried on the next pass', async () => {
    const driver = new RecordingDriver();
    const billing = store();
    const created = await subscribed(driver, billing);
    driver.failures = 1;
    await renewDueManagedSubscriptions(() => driver, billing, { now: DUE });

    const changedAt = new Date(DUE.getTime() + 60 * 1000);
    await updateManagedPaymentMethod(billing, created.id, 'tok_2', { now: changedAt });

    const [outcome] = await renewDueManagedSubscriptions(() => driver, billing, {
      now: changedAt,
    });
    expect(outcome).toMatchObject({ result: 'charged' });
    expect(driver.inputs.at(-1)).toMatchObject({ paymentMethodId: 'tok_2' });
  });

  it('a new card on a healthy subscription does not bring the charge forward', async () => {
    const driver = new RecordingDriver();
    const billing = store();
    const created = await subscribed(driver, billing);
    const midCycle = new Date('2026-01-20T00:00:00Z');

    await updateManagedPaymentMethod(billing, created.id, 'tok_2', { now: midCycle });

    expect(await renewDueManagedSubscriptions(() => driver, billing, { now: midCycle })).toEqual(
      [],
    );
  });
});

describe('per-cycle reference', () => {
  it('differs per cycle and routes back to the app reference', () => {
    const january = cycleReference('sub:abc', 'sub:row:2026-01-10');
    const february = cycleReference('sub:abc', 'sub:row:2026-02-10');
    expect(january).not.toBe(february);
    expect(routingReference(january)).toBe('sub:abc');
    expect(routingReference('sub:abc')).toBe('sub:abc');
    expect(january.length).toBeLessThanOrEqual(100);
  });
});

describe('Asaas renewal over the wire', () => {
  afterEach(() => vi.unstubAllGlobals());

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const asaasPayment = (id: string, externalReference: string) => ({
    id,
    value: 49,
    status: 'CONFIRMED',
    billingType: 'CREDIT_CARD',
    customer: 'cus_1',
    externalReference,
  });

  /** A tiny Asaas: filters by reference like the real list endpoint does. */
  function fakeAsaas() {
    const created: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          created.push(body);
          return json(asaasPayment(`pay_${created.length}`, body.externalReference));
        }
        const reference = new URL(url).searchParams.get('externalReference');
        const rows = created
          .filter((row) => row.externalReference === reference)
          .map((row, index) => asaasPayment(`pay_old_${index}`, String(row.externalReference)));
        return json({ data: rows });
      }),
    );
    return created;
  }

  it('creates a new charge each cycle, carrying the token', async () => {
    const created = fakeAsaas();
    const driver = new AsaasDriver({ config: () => ({}) } as never, { apiKey: 'k', sandbox: true });
    const billing = store();
    await subscribed(driver, billing);

    await renewDueManagedSubscriptions(() => driver, billing, { now: DUE });

    expect(created).toHaveLength(2);
    expect(created[1]).toMatchObject({ creditCardToken: 'tok_1', billingType: 'CREDIT_CARD' });
    expect(created[1]?.creditCardHolderInfo).toBeUndefined();
  });

  it('a repeated pass over one cycle does not charge twice', async () => {
    const created = fakeAsaas();
    const driver = new AsaasDriver({ config: () => ({}) } as never, { apiKey: 'k', sandbox: true });
    const key = 'sub:row:2026-02-10';
    const input = {
      customerId: 'cus_1',
      amount: 4900,
      method: 'credit_card',
      externalReference: 'sub:abc',
      idempotencyKey: key,
      paymentMethodId: 'tok_1',
    };

    await driver.charge(input);
    await driver.charge(input);

    expect(created).toHaveLength(1);
    expect(routingReference(String(created[0]?.externalReference))).toBe('sub:abc');
  });
});
