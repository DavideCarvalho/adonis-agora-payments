import { beforeEach, describe, expect, it } from 'vitest';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import type { PaymentsDriver } from '../src/driver.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';
import type { WebhookEvent } from '../src/types.js';

/**
 * A chargeback is the one webhook that takes revenue AWAY.
 *
 * `BillingStatus` carried `'disputed'` from the start while nothing could ever set it: the
 * processor knew six event types and none of them was a dispute, so a chargeback arrived as
 * an unknown type, passed through unprocessed, and the payment row went on saying `paid`.
 * The app found out from its bank statement.
 */
describe('payment.disputed', () => {
  let store: InMemoryBillingStore;
  let processor: WebhookProcessor;

  const driver = { provider: 'stripe' } as unknown as PaymentsDriver;

  const disputeOf = (gatewayId: string): WebhookEvent => ({
    id: `evt_dispute_${gatewayId}`,
    provider: 'stripe',
    type: 'payment.disputed',
    data: { gatewayId, amount: 4990, currency: 'brl' },
    raw: { reason: 'fraudulent' },
  });

  beforeEach(async () => {
    store = new InMemoryBillingStore();
    processor = new WebhookProcessor({ store, driver });
    await store.savePayment({
      gatewayId: 'pi_1',
      provider: 'stripe',
      status: 'paid',
      amount: 4990,
      currency: 'brl',
      customerId: 'cus_1',
    });
  });

  it('moves a paid payment to disputed', async () => {
    await processor.process(disputeOf('pi_1'));
    const payment = await store.findPaymentByGatewayId('pi_1');
    expect(payment?.status).toBe('disputed');
  });

  it('keeps the customer the payment already had', async () => {
    await processor.process(disputeOf('pi_1'));
    // The dispute payload carries the gateway id and the money, not the customer — losing
    // it here would orphan the row from the account whose access has to be reconsidered.
    expect((await store.findPaymentByGatewayId('pi_1'))?.customerId).toBe('cus_1');
  });

  it('stores the raw payload, which is where the reason lives', async () => {
    await processor.process(disputeOf('pi_1'));
    expect((await store.findPaymentByGatewayId('pi_1'))?.payload).toEqual({
      reason: 'fraudulent',
    });
  });

  it('runs a registered handler for it', async () => {
    const seen: string[] = [];
    const withHandler = new WebhookProcessor({
      store,
      driver,
      handlers: { 'payment.disputed': (event) => void seen.push(event.id) },
    });
    await withHandler.process(disputeOf('pi_1'));
    expect(seen).toEqual(['evt_dispute_pi_1']);
  });

  it('does not resurrect a payment it has never seen', async () => {
    await processor.process(disputeOf('pi_unknown'));
    // A dispute for an unrecorded payment must not conjure a row: the amount and currency
    // come from the dispute, and inventing a payment from them would report revenue that
    // this install never took.
    expect(await store.findPaymentByGatewayId('pi_unknown')).toBeNull();
  });

  it('rejects a malformed payload instead of silently doing nothing', async () => {
    const malformed = { ...disputeOf('pi_1'), data: { nothing: true } } as unknown as WebhookEvent;
    await expect(processor.process(malformed)).rejects.toThrow('Malformed payment.disputed');
  });
});
