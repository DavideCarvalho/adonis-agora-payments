import { describe, expect, it } from 'vitest';
import { DEFAULT_PERIOD, resolvePeriod } from '../../src/dashboard/period.js';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('resolvePeriod', () => {
  it('defaults to 30 days ending now', () => {
    const period = resolvePeriod({}, NOW);
    expect(period.preset).toBe(DEFAULT_PERIOD);
    expect(period.to).toEqual(NOW);
    expect(NOW.getTime() - period.from.getTime()).toBe(30 * DAY);
  });

  it('honors each preset', () => {
    expect(NOW.getTime() - resolvePeriod({ period: '24h' }, NOW).from.getTime()).toBe(DAY);
    expect(NOW.getTime() - resolvePeriod({ period: '7d' }, NOW).from.getTime()).toBe(7 * DAY);
    expect(NOW.getTime() - resolvePeriod({ period: '90d' }, NOW).from.getTime()).toBe(90 * DAY);
  });

  it('falls back to the default for an unknown preset', () => {
    expect(resolvePeriod({ period: 'forever' }, NOW).preset).toBe(DEFAULT_PERIOD);
    expect(resolvePeriod({ period: 42 }, NOW).preset).toBe(DEFAULT_PERIOD);
  });

  it('uses an explicit from/to range', () => {
    const period = resolvePeriod(
      { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' },
      NOW,
    );
    expect(period.preset).toBe('custom');
    expect(period.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('rejects a half-supplied custom range rather than inventing the other half', () => {
    expect(resolvePeriod({ from: '2026-01-01T00:00:00.000Z' }, NOW).preset).toBe(DEFAULT_PERIOD);
    expect(resolvePeriod({ to: '2026-01-01T00:00:00.000Z' }, NOW).preset).toBe(DEFAULT_PERIOD);
  });

  it('rejects a BACKWARDS range instead of producing an empty window', () => {
    // An empty window would report zero revenue, which reads as "you earned nothing" rather
    // than "you asked for nothing".
    const period = resolvePeriod(
      { from: '2026-02-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' },
      NOW,
    );
    expect(period.preset).toBe(DEFAULT_PERIOD);
  });

  it('rejects an unparseable date', () => {
    expect(resolvePeriod({ from: 'yesterday', to: 'today' }, NOW).preset).toBe(DEFAULT_PERIOD);
  });
});
