import { describe, expect, it } from 'vitest';
import type { BillingStore } from '../src/billing/billing_store.js';
import {
  advancePeriod,
  cancelManagedSubscription,
  createManagedSubscription,
  cycleIdempotencyKey,
  renewDueManagedSubscriptions,
} from '../src/billing/managed_subscriptions.js';
import type { PaymentsDriver } from '../src/driver.js';
import { gatewaySubscriptionLifecycle } from '../src/subscription_lifecycle.js';
import { resolveSubscriptionMode } from '../src/subscription_mode.js';
import { FakePaymentsDriver } from '../src/testing/fake_payments_driver.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

/** A gateway that takes charges and cannot do subscriptions at all — the Woovi shape. */
class ChargeOnlyDriver extends FakePaymentsDriver {
  readonly capabilities = {
    subscriptions: true,
    subscriptionLifecycle: { create: true, update: false, cancel: false },
  };
  failNextCharge = false;

  async charge(input: Parameters<PaymentsDriver['charge']>[0]) {
    if (this.failNextCharge) {
      this.failNextCharge = false;
      throw new Error('gateway said no');
    }
    return super.charge(input);
  }
}

const store = () => new InMemoryBillingStore() as unknown as BillingStore;

describe('managed subscriptions', () => {
  describe('advancePeriod', () => {
    /**
     * The bug this exists to prevent: naive month arithmetic turns 31 January into 3 March,
     * so a subscription that starts on the 31st drifts forward through every short month
     * until its billing date no longer resembles the one the customer agreed to.
     */
    it('clamps to the last day of the target month instead of rolling over', () => {
      expect(advancePeriod(new Date('2026-01-31T00:00:00Z'), 'MONTHLY')).toEqual(
        new Date('2026-02-28T00:00:00Z'),
      );
      // And it does not stay clamped: March has a 31st, so the date comes back.
      expect(advancePeriod(new Date('2026-03-31T00:00:00Z'), 'MONTHLY')).toEqual(
        new Date('2026-04-30T00:00:00Z'),
      );
    });

    it('advances the day-based and month-based cycles', () => {
      expect(advancePeriod(new Date('2026-01-01T00:00:00Z'), 'WEEKLY')).toEqual(
        new Date('2026-01-08T00:00:00Z'),
      );
      expect(advancePeriod(new Date('2026-01-01T00:00:00Z'), 'QUARTERLY')).toEqual(
        new Date('2026-04-01T00:00:00Z'),
      );
      expect(advancePeriod(new Date('2026-01-01T00:00:00Z'), 'YEARLY')).toEqual(
        new Date('2027-01-01T00:00:00Z'),
      );
    });
  });

  it('charges the first cycle and carries the app reference', async () => {
    const driver = new ChargeOnlyDriver();
    const billing = store();

    const result = await createManagedSubscription(driver, billing, {
      customerId: 'cus_1',
      planId: 'tier:pro',
      amount: 9900,
      cycle: 'MONTHLY',
      method: 'pix',
      externalReference: 'sub:local-1',
      startDate: '2026-01-10',
    });

    expect(result.currentPeriodEnd).toEqual(new Date('2026-02-10T00:00:00Z'));
    // No gateway subscription was created — only a charge. That is what makes this work on a
    // gateway whose subscription API cannot cancel.
    expect(driver.createSubscriptionCalls).toHaveLength(0);
    expect(driver.chargeCalls).toHaveLength(1);
    // The reference rides every cycle, so a renewal routes through the ordinary webhook path
    // rather than a per-gateway lookup.
    expect(driver.chargeCalls[0]!.input.externalReference).toBe('sub:local-1');
  });

  it('renews a due subscription and advances the period', async () => {
    const driver = new ChargeOnlyDriver();
    const billing = store();
    await createManagedSubscription(driver, billing, {
      customerId: 'cus_1',
      planId: 'p',
      amount: 100,
      cycle: 'MONTHLY',
      externalReference: 'sub:local-1',
      startDate: '2026-01-10',
    });

    const outcomes = await renewDueManagedSubscriptions(() => driver, billing, {
      now: new Date('2026-02-10T00:00:00Z'),
    });

    expect(outcomes).toEqual([{ subscriptionId: expect.any(String), result: 'charged' }]);
    expect(driver.chargeCalls).toHaveLength(2);

    // Not due again until the next cycle: renewing twice in one period is a double charge.
    const again = await renewDueManagedSubscriptions(() => driver, billing, {
      now: new Date('2026-02-11T00:00:00Z'),
    });
    expect(again).toEqual([]);
  });

  /**
   * A failed charge must NOT advance the period. Advancing it would roll the customer into a
   * month they never paid for, and the failure would never be retried.
   */
  it('leaves a failed renewal due instead of skipping the cycle', async () => {
    const driver = new ChargeOnlyDriver();
    const billing = store();
    await createManagedSubscription(driver, billing, {
      customerId: 'cus_1',
      planId: 'p',
      amount: 100,
      cycle: 'MONTHLY',
      startDate: '2026-01-10',
    });

    driver.failNextCharge = true;
    const failed = await renewDueManagedSubscriptions(() => driver, billing, {
      now: new Date('2026-02-10T00:00:00Z'),
    });
    expect(failed[0]).toMatchObject({ result: 'failed', error: 'gateway said no' });

    // Still due, and succeeds on the next pass.
    const retried = await renewDueManagedSubscriptions(() => driver, billing, {
      now: new Date('2026-02-10T00:00:00Z'),
    });
    expect(retried[0]).toMatchObject({ result: 'charged' });
  });

  it('cancels without touching the gateway', async () => {
    const driver = new ChargeOnlyDriver();
    const billing = store();
    const created = await createManagedSubscription(driver, billing, {
      customerId: 'cus_1',
      planId: 'p',
      amount: 100,
      cycle: 'MONTHLY',
      startDate: '2026-01-10',
    });

    await cancelManagedSubscription(billing, created.id);

    // The gateway has no cancel API at all; the point is that none was needed.
    expect(driver.cancelSubscriptionCalls).toHaveLength(0);
    const outcomes = await renewDueManagedSubscriptions(() => driver, billing, {
      now: new Date('2026-03-10T00:00:00Z'),
    });
    expect(outcomes).toEqual([]);
    expect(driver.chargeCalls).toHaveLength(1);
  });

  it('cancel at period end stops the next charge without refunding the paid one', async () => {
    const driver = new ChargeOnlyDriver();
    const billing = store();
    const created = await createManagedSubscription(driver, billing, {
      customerId: 'cus_1',
      planId: 'p',
      amount: 100,
      cycle: 'MONTHLY',
      startDate: '2026-01-10',
    });

    await cancelManagedSubscription(billing, created.id, { atPeriodEnd: true });

    const outcomes = await renewDueManagedSubscriptions(() => driver, billing, {
      now: new Date('2026-02-10T00:00:00Z'),
    });
    // Ended, not charged: the whole promise of "cancel at period end" is that no further
    // money moves once the paid period is over.
    expect(outcomes).toEqual([{ subscriptionId: created.id, result: 'ended' }]);
    expect(driver.chargeCalls).toHaveLength(1);
  });

  /** Two passes over the same window must ask the gateway for the SAME charge. */
  it('keys each cycle idempotently by subscription and period', () => {
    const key = cycleIdempotencyKey('sub_1', new Date('2026-02-10T12:00:00Z'));
    expect(key).toBe('sub:sub_1:2026-02-10');
    expect(cycleIdempotencyKey('sub_1', new Date('2026-02-10T23:59:00Z'))).toBe(key);
    expect(cycleIdempotencyKey('sub_1', new Date('2026-03-10T00:00:00Z'))).not.toBe(key);
  });
});

describe('subscription mode resolution', () => {
  it('narrowest wins and the default is the old behaviour', () => {
    expect(resolveSubscriptionMode(undefined, 'woovi')).toBe('gateway');
    expect(resolveSubscriptionMode({ mode: 'managed' }, 'woovi')).toBe('managed');
    // Per-provider beats global...
    expect(
      resolveSubscriptionMode({ mode: 'managed', providers: { asaas: 'gateway' } }, 'asaas'),
    ).toBe('gateway');
    // ...and the call beats both.
    expect(resolveSubscriptionMode({ mode: 'gateway' }, 'woovi', true)).toBe('managed');
    expect(resolveSubscriptionMode({ mode: 'managed' }, 'woovi', false)).toBe('gateway');
  });
});

describe('gateway subscription lifecycle', () => {
  it('falls back to the coarse flag so existing drivers keep their meaning', () => {
    const legacy = { capabilities: { subscriptions: true } } as unknown as PaymentsDriver;
    expect(gatewaySubscriptionLifecycle(legacy)).toEqual({
      create: true,
      update: true,
      cancel: true,
    });

    const none = { capabilities: { subscriptions: false } } as unknown as PaymentsDriver;
    expect(gatewaySubscriptionLifecycle(none)).toEqual({
      create: false,
      update: false,
      cancel: false,
    });
  });

  it('reports the asymmetric gateway honestly', () => {
    const woovi = {
      capabilities: {
        subscriptions: true,
        subscriptionLifecycle: { create: true, update: false, cancel: false },
      },
    } as unknown as PaymentsDriver;
    // `subscriptions: true` alone was true about the only question it could answer and
    // misleading about the two that decide whether an app can offer a cancel button.
    expect(gatewaySubscriptionLifecycle(woovi)).toEqual({
      create: true,
      update: false,
      cancel: false,
    });
  });
});
