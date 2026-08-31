import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LucidBillingStore } from '../../src/billing/lucid_billing_store.js';
import {
  dropBillingTables,
  type LucidDatabase,
  truncateBillingTables,
} from '../../src/billing/schema.js';
import { createIntegrationDatabase, type IntegrationDatabase } from './harness.js';

/**
 * The test-teardown trap, against a real Postgres — the only place it is visible.
 *
 * `LucidBillingStore` memoizes schema creation in `#schemaReady`, so an app that calls the
 * exported `dropBillingTables` between test groups leaves the store believing the tables are
 * still there: every following query then fails on a relation that nothing will re-create.
 * The app that found it worked around the whole thing with a hand-written
 * `truncateBillingTables` and a `to_regclass` guard, documenting the failure that forced it:
 * *"sem limpar as LINHAS entre grupos, o ledger de webhooks de um teste dedupe o evento do
 * seguinte — a idempotência da lib funcionando contra a suíte."*
 */
describe('billing teardown (integration)', () => {
  let database: IntegrationDatabase;
  let store: LucidBillingStore;

  beforeAll(async () => {
    // `migrate: false`: the store's own auto-creation is what is under test here.
    database = await createIntegrationDatabase('teardown_test', { migrate: false });
    store = new LucidBillingStore();
  });

  afterAll(async () => {
    await database.teardown();
  });

  const db = () => database.db as unknown as LucidDatabase;

  it("empties the ledger so one group's event does not dedupe the next group's", async () => {
    const record = () =>
      store.recordWebhookEvent({
        gatewayEventId: 'evt_shared',
        provider: 'asaas',
        type: 'payment.succeeded',
        payload: {},
      });

    expect(await record()).not.toBeNull();
    // Second group, same event id — the library's idempotency, working against the suite.
    expect(await record()).toBeNull();

    await truncateBillingTables(db());

    expect(await record()).not.toBeNull();
  });

  it('leaves the store usable after a DROP, because the drop invalidates its memo', async () => {
    await store.savePayment({
      gatewayId: 'pay_1',
      provider: 'asaas',
      status: 'paid',
      amount: 100,
      currency: 'brl',
    });

    await dropBillingTables(db());

    // Without the cache reset this throws `relation "billing_payments" does not exist`: the
    // store created the tables once, remembered that it had, and never looks again.
    expect(await store.findPaymentByGatewayId('pay_1')).toBeNull();
    await store.savePayment({
      gatewayId: 'pay_2',
      provider: 'asaas',
      status: 'paid',
      amount: 100,
      currency: 'brl',
    });
    expect((await store.findPaymentByGatewayId('pay_2'))?.status).toBe('paid');
  });
});
