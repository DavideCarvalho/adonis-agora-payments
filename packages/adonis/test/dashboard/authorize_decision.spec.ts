import { describe, expect, it } from 'vitest';
import { resolveAuthorizeResult, runAuthorize } from '../../src/dashboard/authorize_decision.js';

/**
 * The dashboard-gate contract every Agora console copies. The case that matters most is the
 * first denial: `{ allowed: false }` is a truthy object, and it must still DENY.
 */
describe('resolveAuthorizeResult', () => {
  it('denies { allowed: false } with a 403', () => {
    expect(resolveAuthorizeResult({ allowed: false })).toEqual({
      allowed: false,
      status: 403,
      reason: 'forbidden',
    });
  });

  it('maps reason unauthenticated to 401 and forbidden to 403', () => {
    expect(resolveAuthorizeResult({ allowed: false, reason: 'unauthenticated' })).toMatchObject({
      status: 401,
      reason: 'unauthenticated',
    });
    expect(resolveAuthorizeResult({ allowed: false, reason: 'forbidden' })).toMatchObject({
      status: 403,
      reason: 'forbidden',
    });
  });

  it('passes true and { allowed: true }', () => {
    expect(resolveAuthorizeResult(true)).toEqual({ allowed: true });
    expect(resolveAuthorizeResult({ allowed: true })).toEqual({ allowed: true });
  });

  it('fails closed on false and anything malformed', () => {
    for (const value of [false, undefined, null, 1, 'yes', {}, { allowed: 'true' }]) {
      expect(resolveAuthorizeResult(value)).toMatchObject({ allowed: false, status: 403 });
    }
  });
});

describe('runAuthorize', () => {
  it('awaits an async hook', async () => {
    expect(await runAuthorize(async () => ({ allowed: true }), null)).toEqual({ allowed: true });
  });

  it('turns a throw into a 403 and hands the error back', async () => {
    const error = new Error('boom');
    const outcome = await runAuthorize(() => {
      throw error;
    }, null);
    expect(outcome).toMatchObject({ allowed: false, status: 403, reason: 'forbidden' });
    expect(outcome.hookError).toBe(error);
  });
});
