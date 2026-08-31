import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute, screenKey } from './routes';

describe('parseRoute', () => {
  it('lands on the overview for an empty, bare or unknown hash', () => {
    expect(parseRoute('')).toEqual({ screen: 'overview' });
    expect(parseRoute('#')).toEqual({ screen: 'overview' });
    expect(parseRoute('#/')).toEqual({ screen: 'overview' });
    expect(parseRoute('#/nope')).toEqual({ screen: 'overview' });
    // A stale bookmark to a screen that no longer exists must not carry its query along either.
    expect(parseRoute('#/nope?status=failed')).toEqual({ screen: 'overview' });
    // Not a route at all — an anchor.
    expect(parseRoute('#top')).toEqual({ screen: 'overview' });
  });

  it('reads the screen, with or without the leading #', () => {
    expect(parseRoute('#/subscriptions')).toEqual({ screen: 'subscriptions' });
    expect(parseRoute('/webhooks')).toEqual({ screen: 'webhooks' });
  });

  it('reads the seeded status and customer filters', () => {
    expect(parseRoute('#/webhooks?status=failed')).toEqual({
      screen: 'webhooks',
      status: 'failed',
    });
    expect(parseRoute('#/activity?status=webhook.rejected')).toEqual({
      screen: 'activity',
      status: 'webhook.rejected',
    });
    expect(parseRoute('#/payments?customer=cus_9f2')).toEqual({
      screen: 'payments',
      customerId: 'cus_9f2',
    });
    // Empty values are absent, not empty strings — `?status=` must not filter to nothing.
    expect(parseRoute('#/payments?status=&customer=')).toEqual({ screen: 'payments' });
  });

  it('reads the open payment id on the payments screen only', () => {
    expect(parseRoute('#/payments/pay_8f2')).toEqual({ screen: 'payments', paymentId: 'pay_8f2' });
    expect(parseRoute('#/payments/pay%2F8f2?status=paid')).toEqual({
      screen: 'payments',
      paymentId: 'pay/8f2',
      status: 'paid',
    });
    // Other screens have no detail dialog; a trailing segment there is noise.
    expect(parseRoute('#/customers/whatever')).toEqual({ screen: 'customers' });
  });

  it('survives an id that is not valid percent-encoding', () => {
    expect(parseRoute('#/payments/100%')).toEqual({ screen: 'payments', paymentId: '100%' });
  });
});

describe('formatRoute', () => {
  it('round-trips through parseRoute', () => {
    const routes = [
      { screen: 'overview' as const },
      { screen: 'webhooks' as const, status: 'failed' },
      { screen: 'payments' as const, customerId: 'cus_9f2' },
      { screen: 'payments' as const, paymentId: 'pay/8f2 x', status: 'paid' },
      { screen: 'activity' as const, status: 'webhook.rejected' },
    ];
    for (const route of routes) {
      expect(parseRoute(formatRoute(route))).toEqual(route);
    }
  });

  it('writes the screen alone when nothing is seeded', () => {
    expect(formatRoute({ screen: 'disputes' })).toBe('#/disputes');
    expect(formatRoute({ screen: 'disputes', status: undefined })).toBe('#/disputes');
  });

  it('encodes the payment id so a slash in it cannot read as a path segment', () => {
    expect(formatRoute({ screen: 'payments', paymentId: 'a/b' })).toBe('#/payments/a%2Fb');
  });

  it('drops a payment id on any screen but payments', () => {
    expect(formatRoute({ screen: 'customers', paymentId: 'pay_1' })).toBe('#/customers');
  });
});

describe('screenKey', () => {
  it('changes with the seed, so a new seed remounts the screen', () => {
    expect(screenKey({ screen: 'payments', status: 'pending' })).not.toBe(
      screenKey({ screen: 'payments', status: 'failed' }),
    );
    expect(screenKey({ screen: 'payments' })).not.toBe(
      screenKey({ screen: 'payments', customerId: 'cus_1' }),
    );
  });

  it('ignores the open payment, so opening a detail keeps the list mounted', () => {
    expect(screenKey({ screen: 'payments', paymentId: 'pay_1' })).toBe(
      screenKey({ screen: 'payments' }),
    );
  });
});
