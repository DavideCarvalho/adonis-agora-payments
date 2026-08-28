import { describe, expect, it } from 'vitest';
import {
  isActionable,
  paymentStatusClass,
  subscriptionIsBilling,
  subscriptionNeedsAttention,
  subscriptionStatusClass,
  webhookStatusClass,
} from './status';

describe('paymentStatusClass', () => {
  it('maps the modelled statuses onto their own hue', () => {
    expect(paymentStatusClass('paid')).toBe('s-paid');
    expect(paymentStatusClass('failed')).toBe('s-failed');
    expect(paymentStatusClass('refunded')).toBe('s-refunded');
  });

  it('gives authorized and disputed their own hue instead of collapsing them into paid', () => {
    // `authorized` is money HELD, not taken; `disputed` is money already pulled back. Neither may
    // render as a flavour of `paid`.
    expect(paymentStatusClass('authorized')).toBe('s-authorized');
    expect(paymentStatusClass('disputed')).toBe('s-disputed');
  });

  it('does NOT let an unmodelled gateway status borrow a hue', () => {
    // A status nobody modelled must not be able to render as if it were "paid".
    expect(paymentStatusClass('AUTHORIZED_PENDING_CAPTURE')).toBe('s-unknown');
    expect(paymentStatusClass('')).toBe('s-unknown');
  });
});

describe('webhookStatusClass', () => {
  it('maps the ledger statuses', () => {
    expect(webhookStatusClass('received')).toBe('s-received');
    expect(webhookStatusClass('processed')).toBe('s-processed');
    expect(webhookStatusClass('failed')).toBe('s-failed');
  });

  it('falls back for anything else', () => {
    expect(webhookStatusClass('weird')).toBe('s-unknown');
  });
});

describe('isActionable', () => {
  it('is true only for a failed row', () => {
    expect(isActionable('failed')).toBe(true);
    expect(isActionable('processed')).toBe(false);
    expect(isActionable('received')).toBe(false);
    expect(isActionable('paid')).toBe(false);
  });
});

describe('subscriptionStatusClass', () => {
  it('gives every modelled subscription status its own hue', () => {
    expect(subscriptionStatusClass('active')).toBe('s-active');
    expect(subscriptionStatusClass('trialing')).toBe('s-trialing');
    expect(subscriptionStatusClass('past_due')).toBe('s-past_due');
    expect(subscriptionStatusClass('incomplete')).toBe('s-incomplete');
    expect(subscriptionStatusClass('ended')).toBe('s-ended');
  });

  it('never renders paused with the same class as active', () => {
    // The whole point: a paused subscriber is NOT paying, and several gateways collapse the two.
    expect(subscriptionStatusClass('paused')).toBe('s-paused');
    expect(subscriptionStatusClass('paused')).not.toBe(subscriptionStatusClass('active'));
  });

  it('falls back for a status nobody modelled', () => {
    expect(subscriptionStatusClass('SUSPENDED_BY_GATEWAY')).toBe('s-unknown');
  });
});

describe('subscriptionNeedsAttention', () => {
  it('is true for the states where money was expected and did not arrive', () => {
    expect(subscriptionNeedsAttention('past_due')).toBe(true);
    expect(subscriptionNeedsAttention('incomplete')).toBe(true);
  });

  it('leaves the deliberate states alone so the alarm list stays worth reading', () => {
    for (const status of ['active', 'trialing', 'paused', 'canceled', 'ended']) {
      expect([status, subscriptionNeedsAttention(status)]).toEqual([status, false]);
    }
  });
});

describe('subscriptionIsBilling', () => {
  it('is true only while the subscription is actually collecting', () => {
    expect(subscriptionIsBilling('active')).toBe(true);
    expect(subscriptionIsBilling('trialing')).toBe(true);
  });

  it('is false for paused — the trap this function exists for', () => {
    expect(subscriptionIsBilling('paused')).toBe(false);
    expect(subscriptionIsBilling('past_due')).toBe(false);
    expect(subscriptionIsBilling('canceled')).toBe(false);
  });
});
