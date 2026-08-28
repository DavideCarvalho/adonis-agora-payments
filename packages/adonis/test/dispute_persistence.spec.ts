import { beforeEach, describe, expect, it } from 'vitest';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import type { PaymentsDriver } from '../src/driver.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';
import type { WebhookEvent } from '../src/types.js';

/**
 * What the three dispute events now WRITE.
 *
 * Before this, the processor reacted to all three and persisted none of them: the response
 * deadline arrived on the event, went out on the diagnostics bus, and was gone. The payment
 * row could say `disputed`, but nothing anywhere said by WHEN somebody had to answer — so
 * missing a window lost the money by default rather than on the merits.
 *
 * The dispute row is ADDITIONAL. Every assertion about the payment row here is the old
 * behaviour, re-asserted: a warning still moves no money, a won close still returns it.
 */
describe('dispute persistence', () => {
  let store: InMemoryBillingStore;
  let processor: WebhookProcessor;

  const driver = { provider: 'stripe' } as unknown as PaymentsDriver;
  const DUE = '2026-09-03T12:00:00.000Z';

  const event = (
    type: string,
    data: Record<string, unknown>,
    id = `evt_${type}_${String(data.disputeId ?? data.gatewayId)}`,
  ): WebhookEvent => ({
    id,
    provider: 'stripe',
    type,
    data,
    raw: { object: type },
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

  describe('payment.dispute_warning', () => {
    it('records the warning and its deadline', async () => {
      await processor.process(
        event('payment.dispute_warning', {
          gatewayId: 'pi_1',
          disputeId: 'issfr_1',
          reason: 'made_with_stolen_card',
          actionableUntil: DUE,
        }),
      );

      const dispute = await store.findDisputeByGatewayId('issfr_1');
      expect(dispute?.status).toBe('warning');
      expect(dispute?.paymentGatewayId).toBe('pi_1');
      expect(dispute?.reason).toBe('made_with_stolen_card');
      expect(dispute?.evidenceDueBy).toEqual(new Date(DUE));
      expect(dispute?.payload).toEqual({ object: 'payment.dispute_warning' });
    });

    it('still does not move the payment row', async () => {
      await processor.process(
        event('payment.dispute_warning', { gatewayId: 'pi_1', disputeId: 'issfr_1' }),
      );
      // No money has moved: a row that says `paid` is telling the truth, and calling this a
      // chargeback is the exact bug the three-event vocabulary exists to prevent.
      expect((await store.findPaymentByGatewayId('pi_1'))?.status).toBe('paid');
    });

    it('records a warning with no amount at all', async () => {
      // Stripe's early fraud warning names a charge and a fraud type — no amount, no
      // currency. Refusing it for that would throw away the earliest alert the library gets.
      await processor.process(
        event('payment.dispute_warning', { gatewayId: 'pi_1', disputeId: 'issfr_1' }),
      );
      const dispute = await store.findDisputeByGatewayId('issfr_1');
      expect(dispute?.amount).toBeNull();
      expect(dispute?.currency).toBeNull();
    });

    it('ignores an unparseable deadline instead of failing the webhook', async () => {
      await processor.process(
        event('payment.dispute_warning', {
          gatewayId: 'pi_1',
          disputeId: 'issfr_1',
          actionableUntil: 'soon',
        }),
      );
      // An Invalid Date would be rejected by Postgres, failing the whole delivery — and
      // through the ledger, every redelivery of it. One dropped field beats a lost chargeback.
      expect((await store.findDisputeByGatewayId('issfr_1'))?.evidenceDueBy).toBeNull();
    });
  });

  describe('payment.disputed', () => {
    it('records an open dispute and still moves the payment to disputed', async () => {
      await processor.process(
        event('payment.disputed', {
          gatewayId: 'pi_1',
          disputeId: 'dp_1',
          amount: 4990,
          currency: 'brl',
          reason: 'fraudulent',
          actionableUntil: DUE,
        }),
      );

      expect((await store.findPaymentByGatewayId('pi_1'))?.status).toBe('disputed');
      const dispute = await store.findDisputeByGatewayId('dp_1');
      expect(dispute?.status).toBe('open');
      expect(dispute?.amount).toBe(4990);
      expect(dispute?.evidenceDueBy).toEqual(new Date(DUE));
    });

    it('records the dispute even when the payment was never seen', async () => {
      await processor.process(
        event('payment.disputed', {
          gatewayId: 'pi_unknown',
          disputeId: 'dp_x',
          amount: 100,
          currency: 'brl',
          actionableUntil: DUE,
        }),
      );
      // The payment row is still not conjured — inventing one would report revenue that
      // never landed — but a chargeback against a charge this install never saw is exactly
      // the one somebody has to be told about, and its deadline is what makes it actionable.
      expect(await store.findPaymentByGatewayId('pi_unknown')).toBeNull();
      expect((await store.findDisputeByGatewayId('dp_x'))?.paymentGatewayId).toBe('pi_unknown');
    });

    it('upgrades the warning row rather than opening a second dispute', async () => {
      await processor.process(
        event('payment.dispute_warning', {
          gatewayId: 'pi_1',
          disputeId: 'dp_1',
          actionableUntil: DUE,
        }),
      );
      await processor.process(
        event('payment.disputed', {
          gatewayId: 'pi_1',
          disputeId: 'dp_1',
          amount: 4990,
          currency: 'brl',
        }),
      );

      expect(await store.countDisputes({})).toBe(1);
      const dispute = await store.findDisputeByGatewayId('dp_1');
      expect(dispute?.status).toBe('open');
      // The chargeback event carries no deadline; the warning's must survive it.
      expect(dispute?.evidenceDueBy).toEqual(new Date(DUE));
    });
  });

  describe('payment.dispute_closed', () => {
    beforeEach(async () => {
      await processor.process(
        event('payment.disputed', {
          gatewayId: 'pi_1',
          disputeId: 'dp_1',
          amount: 4990,
          currency: 'brl',
          actionableUntil: DUE,
        }),
      );
    });

    it('closes the dispute row and puts a won payment back to paid', async () => {
      await processor.process(
        event('payment.dispute_closed', { gatewayId: 'pi_1', disputeId: 'dp_1', outcome: 'won' }),
      );

      expect((await store.findPaymentByGatewayId('pi_1'))?.status).toBe('paid');
      const dispute = await store.findDisputeByGatewayId('dp_1');
      expect(dispute?.status).toBe('won');
      expect(dispute?.outcome).toBe('won');
      expect(dispute?.closedAt).toBeInstanceOf(Date);
    });

    it.each(['lost', 'canceled', 'expired'])(
      'records a %s outcome and leaves the payment disputed',
      async (outcome) => {
        await processor.process(
          event('payment.dispute_closed', { gatewayId: 'pi_1', disputeId: 'dp_1', outcome }),
        );
        expect((await store.findPaymentByGatewayId('pi_1'))?.status).toBe('disputed');
        expect((await store.findDisputeByGatewayId('dp_1'))?.status).toBe(outcome);
      },
    );

    it('drops out of the deadline read once it is closed', async () => {
      const now = new Date('2026-09-01T12:00:00.000Z');
      expect(await store.countDisputesDueWithin({ withinHours: 72, now })).toBe(1);
      await processor.process(
        event('payment.dispute_closed', { gatewayId: 'pi_1', disputeId: 'dp_1', outcome: 'lost' }),
      );
      // What stops the health check alerting forever on a window nobody has to answer.
      expect(await store.countDisputesDueWithin({ withinHours: 72, now })).toBe(0);
    });

    it('writes nothing when the close carries no outcome', async () => {
      await expect(
        processor.process(
          event('payment.dispute_closed', { gatewayId: 'pi_1', disputeId: 'dp_1' }, 'evt_no_out'),
        ),
      ).rejects.toThrow('carries no outcome');
      // A close with no outcome is not a close, and reporting one the gateway never sent is
      // the failure the whole event exists to avoid.
      const dispute = await store.findDisputeByGatewayId('dp_1');
      expect(dispute?.status).toBe('open');
      expect(dispute?.closedAt).toBeNull();
    });
  });

  describe('the key a dispute is written under', () => {
    it('uses the gateway dispute id when the event carries one', async () => {
      await processor.process(
        event('payment.dispute_warning', { gatewayId: 'pi_1', disputeId: 'dp_real' }),
      );
      expect((await store.listDisputes({})).map((row) => row.gatewayId)).toEqual(['dp_real']);
    });

    it('synthesizes a reconcilable key when the gateway sends no dispute id', async () => {
      await processor.process(event('payment.dispute_warning', { gatewayId: 'pi_1' }));
      const [row] = await store.listDisputes({});
      // Prefixed, so it can never collide with a real gateway id in the same unique column,
      // and it still names the payment — a row nobody can reconcile is worse than no row.
      expect(row?.gatewayId).toBe('dispute:stripe:pi_1');
      expect(row?.paymentGatewayId).toBe('pi_1');
    });

    it('rejoins the row a later event stops naming', async () => {
      // Several gateways send the dispute id when it opens and omit it when it closes. Both
      // have to land on the SAME row, or the close opens a second dispute and the deadline
      // check keeps alerting on a window that was already answered.
      await processor.process(
        event('payment.disputed', {
          gatewayId: 'pi_1',
          disputeId: 'dp_1',
          amount: 4990,
          currency: 'brl',
          actionableUntil: DUE,
        }),
      );
      await processor.process(
        event('payment.dispute_closed', { gatewayId: 'pi_1', outcome: 'lost' }, 'evt_close_noid'),
      );

      expect(await store.countDisputes({})).toBe(1);
      expect((await store.findDisputeByGatewayId('dp_1'))?.status).toBe('lost');
    });

    it('starts a new row for a chargeback after an earlier dispute closed', async () => {
      await processor.process(
        event('payment.dispute_warning', { gatewayId: 'pi_1', disputeId: 'dp_1' }),
      );
      await processor.process(
        event('payment.dispute_closed', { gatewayId: 'pi_1', disputeId: 'dp_1', outcome: 'won' }),
      );
      await processor.process(
        event('payment.disputed', {
          gatewayId: 'pi_1',
          disputeId: 'dp_2',
          amount: 4990,
          currency: 'brl',
        }),
      );

      expect((await store.listDisputes({})).map((row) => row.gatewayId).sort()).toEqual([
        'dp_1',
        'dp_2',
      ]);
    });
  });
});
