import { describe, expect, it } from 'vitest';
import { isActionable, paymentStatusClass, webhookStatusClass } from './status';

describe('paymentStatusClass', () => {
  it('maps the modelled statuses onto their own hue', () => {
    expect(paymentStatusClass('paid')).toBe('s-paid');
    expect(paymentStatusClass('failed')).toBe('s-failed');
    expect(paymentStatusClass('refunded')).toBe('s-refunded');
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
