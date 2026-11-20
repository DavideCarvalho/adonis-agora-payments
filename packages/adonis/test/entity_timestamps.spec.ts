import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { BaseModel } from '@adonisjs/lucid/orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BillingStore } from '../src/billing/billing_store.js';
import { LucidBillingStore } from '../src/billing/lucid_billing_store.js';
import {
  customers,
  disputes,
  paymentDetail,
  payments,
  subscriptionDetail,
  subscriptions,
} from '../src/dashboard/handlers.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

/**
 * `createdAt` + `updatedAt` on every mutable billing entity: customers, subscriptions (gateway and
 * managed), payments and disputes. Created is stamped once; updated starts equal to it and moves on
 * every write that changes the row.
 *
 * The same contract runs against the in-memory store and the Lucid store on SQLite (whose
 * `DATETIME` keeps whole seconds, hence the clock steps of a minute).
 */
const T0 = new Date('2026-11-20T10:00:00.000Z');
const T1 = new Date('2026-11-20T10:01:00.000Z');
const T2 = new Date('2026-11-20T10:02:00.000Z');

type AnyStore = BillingStore;

function contract(name: string, setup: () => Promise<{ store: AnyStore; at: (d: Date) => void }>) {
  describe(name, () => {
    let store: AnyStore;
    let at: (d: Date) => void;

    beforeAll(async () => {
      ({ store, at } = await setup());
    });

    it('customers: created set once, updated moves on update', async () => {
      at(T0);
      await store.saveCustomer({ gatewayId: 'cus_ts', provider: 'asaas', email: 'a@x.test' });
      let [row] = await store.listCustomers({ gatewayId: 'cus_ts' });
      expect(row?.createdAt?.toISOString()).toBe(T0.toISOString());
      expect(row?.updatedAt?.toISOString()).toBe(T0.toISOString());

      at(T1);
      await store.saveCustomer({ gatewayId: 'cus_ts', provider: 'asaas', email: 'b@x.test' });
      [row] = await store.listCustomers({ gatewayId: 'cus_ts' });
      expect(row?.createdAt?.toISOString()).toBe(T0.toISOString());
      expect(row?.updatedAt?.toISOString()).toBe(T1.toISOString());
    });

    it('payments: created set once, updated moves on update', async () => {
      at(T0);
      const base = { gatewayId: 'pay_ts', provider: 'asaas', amount: 1000, currency: 'BRL' };
      await store.savePayment({ ...base, status: 'pending' });
      let [row] = await store.listPayments({ gatewayId: 'pay_ts' });
      expect(row?.createdAt?.toISOString()).toBe(T0.toISOString());
      expect(row?.updatedAt?.toISOString()).toBe(T0.toISOString());

      at(T1);
      await store.savePayment({ ...base, status: 'paid', paidAt: T1 });
      [row] = await store.listPayments({ gatewayId: 'pay_ts' });
      expect(row?.createdAt?.toISOString()).toBe(T0.toISOString());
      expect(row?.updatedAt?.toISOString()).toBe(T1.toISOString());
    });

    it('gateway subscriptions: created set once, updated moves on update', async () => {
      at(T0);
      const base = { gatewayId: 'sub_ts', provider: 'asaas', customerId: 'cus_ts', planId: 'pro' };
      await store.saveSubscription({ ...base, status: 'active' });
      let [row] = await store.listSubscriptions({ gatewayId: 'sub_ts' });
      expect(row?.createdAt?.toISOString()).toBe(T0.toISOString());
      expect(row?.updatedAt?.toISOString()).toBe(T0.toISOString());

      at(T1);
      await store.saveSubscription({ ...base, status: 'canceled' });
      [row] = await store.listSubscriptions({ gatewayId: 'sub_ts' });
      expect(row?.createdAt?.toISOString()).toBe(T0.toISOString());
      expect(row?.updatedAt?.toISOString()).toBe(T1.toISOString());
    });

    it('managed subscriptions: updated moves on updateManagedSubscription', async () => {
      at(T0);
      const created = await store.createManagedSubscription({
        provider: 'asaas',
        customerId: 'cus_ts',
        status: 'active',
        planId: 'pro',
        amount: 4900,
        currency: 'BRL',
        cycle: 'MONTHLY',
        currentPeriodStart: T0,
        currentPeriodEnd: T2,
        nextChargeAt: T2,
      });
      const id = String((created as { id: unknown }).id);
      let [row] = await store.listSubscriptions({ id });
      const createdAt = row?.createdAt?.toISOString();
      expect(createdAt).toBeDefined();
      expect(row?.updatedAt?.toISOString()).toBe(createdAt);

      at(T2);
      await store.updateManagedSubscription(id, { amount: 5900 });
      [row] = await store.listSubscriptions({ id });
      expect(row?.createdAt?.toISOString()).toBe(createdAt);
      expect(row?.updatedAt?.toISOString()).toBe(T2.toISOString());
    });

    it('disputes: created set once, updated moves on update', async () => {
      at(T0);
      const base = { gatewayId: 'dp_ts', paymentGatewayId: 'pay_ts', provider: 'asaas' };
      await store.saveDispute({ ...base, status: 'open' });
      let [row] = await store.listDisputes({ paymentGatewayId: 'pay_ts' });
      expect(row?.createdAt?.toISOString()).toBe(T0.toISOString());
      expect(row?.updatedAt?.toISOString()).toBe(T0.toISOString());

      at(T1);
      await store.saveDispute({ ...base, status: 'lost', outcome: 'lost', closedAt: T1 });
      [row] = await store.listDisputes({ paymentGatewayId: 'pay_ts' });
      expect(row?.createdAt?.toISOString()).toBe(T0.toISOString());
      expect(row?.updatedAt?.toISOString()).toBe(T1.toISOString());
    });
  });
}

contract('in-memory store', async () => {
  const store = new InMemoryBillingStore();
  let clock = T0;
  store.now = () => clock;
  // `createManagedSubscription` stamps the wall clock, like the Lucid model does.
  return {
    store: store as unknown as AnyStore,
    at: (d) => {
      clock = d;
      vi.setSystemTime(d);
    },
  };
});

describe('Lucid store on SQLite', () => {
  let db: Database;

  beforeAll(async () => {
    const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
    await app.init();
    db = new Database(
      {
        connection: 'sqlite',
        connections: {
          sqlite: {
            client: 'better-sqlite3',
            connection: { filename: ':memory:' },
            useNullAsDefault: true,
          },
        },
      },
      new LoggerFactory().create(),
      new Emitter(app),
    );
    BaseModel.useAdapter(db.modelAdapter());
  });

  afterAll(async () => {
    await db?.manager.closeAll();
  });

  contract('round trip', async () => ({
    store: new LucidBillingStore() as unknown as AnyStore,
    at: (d) => vi.setSystemTime(d),
  }));
});

describe('console DTOs', () => {
  const store = new InMemoryBillingStore();
  let clock = T0;
  store.now = () => clock;
  const deps = { store: store as unknown as BillingStore, currency: 'BRL' };
  const req = (
    over: Partial<{ params: Record<string, string>; query: Record<string, unknown> }>,
  ) => ({
    params: {},
    query: {},
    ...over,
  });

  beforeAll(async () => {
    vi.setSystemTime(T0);
    await store.saveCustomer({ gatewayId: 'cus_dto', provider: 'asaas' });
    await store.savePayment({
      gatewayId: 'pay_dto',
      provider: 'asaas',
      status: 'pending',
      amount: 100,
      currency: 'BRL',
      customerId: 'cus_dto',
    });
    await store.saveSubscription({
      gatewayId: 'sub_dto',
      provider: 'asaas',
      customerId: 'cus_dto',
      status: 'active',
      planId: 'pro',
    });
    await store.saveDispute({
      gatewayId: 'dp_dto',
      paymentGatewayId: 'pay_dto',
      provider: 'asaas',
      status: 'open',
    });
    clock = T1;
    await store.savePayment({
      gatewayId: 'pay_dto',
      provider: 'asaas',
      status: 'paid',
      amount: 100,
      currency: 'BRL',
      paidAt: T1,
    });
  });

  const stamps = { createdAt: T0.toISOString(), updatedAt: T0.toISOString() };
  const rowsOf = (body: unknown) => (body as { data: Record<string, unknown>[] }).data;

  it('lists expose createdAt and updatedAt as ISO strings', async () => {
    expect(rowsOf((await customers(deps, req({}))).body)[0]).toMatchObject(stamps);
    expect(rowsOf((await subscriptions(deps, req({}))).body)[0]).toMatchObject(stamps);
    expect(rowsOf((await disputes(deps, req({}))).body)[0]).toMatchObject(stamps);
    expect(rowsOf((await payments(deps, req({}))).body)[0]).toMatchObject({
      createdAt: T0.toISOString(),
      updatedAt: T1.toISOString(),
    });
  });

  it('details expose both', async () => {
    const payment = (await paymentDetail(deps, req({ params: { gatewayId: 'pay_dto' } }))).body as {
      payment: Record<string, unknown>;
    };
    expect(payment.payment).toMatchObject({
      createdAt: T0.toISOString(),
      updatedAt: T1.toISOString(),
    });
    const sub = (await subscriptionDetail(deps, req({ params: { id: 'sub_dto' } }))).body as {
      subscription: Record<string, unknown>;
      customer: Record<string, unknown>;
    };
    expect(sub.subscription).toMatchObject(stamps);
    expect(sub.customer).toMatchObject(stamps);
  });

  it('serializes an unknown updatedAt (a custom store that fills none) as null', async () => {
    const bare = {
      ...deps,
      store: new Proxy(store, {
        get(target, key) {
          if (key === 'countCustomers') return async () => 1;
          if (key !== 'listCustomers') {
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return async () => [
            {
              id: '1',
              gatewayId: 'cus_old',
              provider: 'asaas',
              ownerType: null,
              ownerId: null,
              email: null,
              name: null,
              taxId: null,
              createdAt: null,
            },
          ];
        },
      }) as unknown as BillingStore,
    };
    expect(rowsOf((await customers(bare, req({}))).body)[0]).toMatchObject({
      createdAt: null,
      updatedAt: null,
    });
  });
});

afterAll(() => {
  vi.useRealTimers();
});
