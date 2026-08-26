import { describe, expect, it } from 'vitest';
import {
  PAYMENTS_DIAGNOSTIC_EVENTS,
  claimPaymentsDiagnostics,
  isPaymentsDiagnosticClaimed,
  publishPayments,
} from '../src/diagnostics.js';

describe('payments diagnostics', () => {
  it('emits on the structural slot when installed (no-op otherwise)', () => {
    const events: [string, string, unknown][] = [];
    const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
    (globalThis as Record<symbol, unknown>)[EMIT_SLOT] = (
      lib: string,
      event: string,
      payload: unknown,
    ) => {
      events.push([lib, event, payload]);
    };
    try {
      publishPayments('charge.created', {
        gatewayId: 'pay_1',
        provider: 'asaas',
        amount: 1990,
        currency: 'brl',
      });
      expect(events).toHaveLength(1);
      expect(events[0]![0]).toBe('payments');
      expect(events[0]![1]).toBe('charge.created');
    } finally {
      delete (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
    }
  });

  it('is a no-op when diagnostics is not installed', () => {
    const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
    delete (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
    expect(() =>
      publishPayments('charge.created', {
        gatewayId: 'x',
        provider: 'asaas',
        amount: 1,
        currency: 'brl',
      }),
    ).not.toThrow();
  });

  it('claims and releases channels (reference-counted)', () => {
    const CLAIMS_SLOT = Symbol.for('@agora/diagnostics:claims');
    delete (globalThis as Record<symbol, unknown>)[CLAIMS_SLOT];
    expect(isPaymentsDiagnosticClaimed('charge.created')).toBe(false);
    const release = claimPaymentsDiagnostics(['charge.created']);
    expect(isPaymentsDiagnosticClaimed('charge.created')).toBe(true);
    const release2 = claimPaymentsDiagnostics(['charge.created']);
    expect(isPaymentsDiagnosticClaimed('charge.created')).toBe(true);
    release2();
    expect(isPaymentsDiagnosticClaimed('charge.created')).toBe(true);
    release();
    expect(isPaymentsDiagnosticClaimed('charge.created')).toBe(false);
  });

  it('exposes the runtime event catalog for watchers', () => {
    expect(PAYMENTS_DIAGNOSTIC_EVENTS).toContain('charge.created');
    expect(PAYMENTS_DIAGNOSTIC_EVENTS).toContain('webhook.processed');
  });
});
