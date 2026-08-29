import { describe, expect, it } from 'vitest';
import {
  assertRoleIsDispatchable,
  resolveDispatchMode,
  resolveRole,
} from '../src/billing/resolve_dispatch.js';

/**
 * `billing.dispatcher` is the only option able to name every backend — the
 * boolean `durable` alias can only say durable or not. Reading the alias first would make an
 * explicit `dispatcher` a silent no-op.
 */
describe('resolveDispatchMode', () => {
  it('defaults to auto', () => {
    expect(resolveDispatchMode({})).toBe('auto');
    expect(resolveDispatchMode({ billing: {} })).toBe('auto');
  });

  it('refuses the queue dispatcher, which was never implemented', () => {
    // It was in the type, in the config docs and in the dispatcher's own comments, and
    // `queueDispatch` was never read — so the mode fell through and silently ran
    // durable-or-in-process. Boot is the only place this can be honest.
    expect(() => resolveDispatchMode({ billing: { dispatcher: 'queue' } } as never)).toThrow(
      /is not implemented/,
    );
  });

  it('reads billing.dispatcher', () => {
    expect(resolveDispatchMode({ billing: { dispatcher: 'durable' } })).toBe('durable');
    expect(resolveDispatchMode({ billing: { dispatcher: 'durable' } })).toBe('durable');
    expect(resolveDispatchMode({ billing: { dispatcher: 'in-process' } })).toBe('in-process');
  });

  it('prefers dispatcher over the legacy alias when both are set', () => {
    expect(resolveDispatchMode({ billing: { dispatcher: 'in-process', durable: true } })).toBe(
      'in-process',
    );
  });

  it('still honours the legacy durable alias on its own', () => {
    expect(resolveDispatchMode({ billing: { durable: true } })).toBe('durable');
    expect(resolveDispatchMode({ billing: { durable: false } })).toBe('in-process');
    expect(resolveDispatchMode({ billing: { durable: 'auto' } })).toBe('auto');
  });
});

describe('resolveRole', () => {
  it('runs both halves by default', () => {
    expect(resolveRole({})).toBe('all');
  });

  it('reads billing.role', () => {
    expect(resolveRole({ billing: { role: 'api' } })).toBe('api');
    expect(resolveRole({ billing: { role: 'worker' } })).toBe('worker');
  });
});

describe('assertRoleIsDispatchable', () => {
  it('allows a split over a dispatcher that has a channel', () => {
    expect(() => assertRoleIsDispatchable('api', 'durable')).not.toThrow();
    // Durable is the only one with a channel. `'queue'` used to be allowed here, which
    // produced an api process doing all the work and a worker sitting idle.
    expect(() => assertRoleIsDispatchable('worker', 'in-process')).toThrow();
  });

  it('never constrains the single-process default', () => {
    expect(() => assertRoleIsDispatchable('all', 'in-process')).not.toThrow();
    expect(() => assertRoleIsDispatchable('all', 'auto')).not.toThrow();
  });

  it('refuses to split over in-process, which has no channel', () => {
    expect(() => assertRoleIsDispatchable('api', 'in-process')).toThrow(/no channel/);
    expect(() => assertRoleIsDispatchable('worker', 'in-process')).toThrow(/no channel/);
  });

  it('refuses to split over auto, which can silently resolve to in-process', () => {
    expect(() => assertRoleIsDispatchable('api', 'auto')).toThrow(/no channel/);
  });

  it('names the fix in the error', () => {
    expect(() => assertRoleIsDispatchable('worker', 'auto')).toThrow(/Set dispatcher to "durable"/);
  });
});
