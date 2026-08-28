import { describe, expect, it } from 'vitest';
import type { Health, HealthCheck } from '../client/payments-client';
import { failingChecks, healthTarget, healthyLine } from './health';

function check(overrides: Partial<HealthCheck> & Pick<HealthCheck, 'key'>): HealthCheck {
  return { label: 'label', count: 0, healthy: true, hint: 'hint', ...overrides };
}

function report(checks: HealthCheck[]): Health {
  return {
    healthy: checks.every((c) => c.healthy),
    checkedAt: '2026-08-27T12:00:00.000Z',
    checks,
    failures: [],
  };
}

/**
 * Where a failing check sends the operator.
 *
 * A count with no way to reach its rows is decoration, and a count that reaches the WRONG rows is
 * worse — it lands them on a screen full of healthy records and teaches them to distrust the
 * number. Each mapping is asserted individually rather than as a shape.
 */
describe('healthTarget', () => {
  it('sends stuck events to the in-flight ledger rows, which is where they actually are', () => {
    // A stuck event is one still sitting at `received`. Sending this to `failed` would show none.
    expect(healthTarget('stuck_webhooks')).toMatchObject({
      screen: 'webhooks',
      status: 'received',
    });
  });

  it('sends failed events to the failed ledger rows', () => {
    expect(healthTarget('failed_webhooks')).toMatchObject({ screen: 'webhooks', status: 'failed' });
  });

  it('sends unconfirmed charges to the PAYMENTS screen, filtered to pending', () => {
    // The one that crosses screens: these are payment rows, not ledger rows.
    expect(healthTarget('unconfirmed_payments')).toMatchObject({
      screen: 'payments',
      status: 'pending',
    });
  });

  it('labels every target so the button says what it will show', () => {
    for (const key of ['stuck_webhooks', 'failed_webhooks', 'unconfirmed_payments'] as const) {
      expect(healthTarget(key).label.length).toBeGreaterThan(0);
    }
  });
});

describe('failingChecks', () => {
  it('keeps only the checks that are firing', () => {
    const checks = [
      check({ key: 'stuck_webhooks' }),
      check({ key: 'failed_webhooks', count: 3, healthy: false }),
      check({ key: 'unconfirmed_payments', count: 1, healthy: false }),
    ];
    expect(failingChecks(report(checks)).map((c) => c.key)).toEqual([
      'failed_webhooks',
      'unconfirmed_payments',
    ]);
  });

  it('is empty on a healthy install', () => {
    expect(failingChecks(report([check({ key: 'stuck_webhooks' })]))).toEqual([]);
  });
});

describe('healthyLine', () => {
  it('names what was checked rather than just saying OK', () => {
    // A green line that does not say what it looked at is a green line nobody believes on the day
    // it matters.
    const line = healthyLine(report([check({ key: 'stuck_webhooks' })]));
    expect(line).toContain('stuck');
    expect(line).toContain('unconfirmed');
  });
});
