import type { HttpContext } from '@adonisjs/core/http';
import { describe, expect, it } from 'vitest';
import {
  defaultAuthorize,
  defaultOwner,
  resolveConfig,
  resolveRequestUser,
} from '../../src/client/define_config.js';

const ctx = (auth: unknown) => ({ auth }) as unknown as HttpContext;

describe('payments client config', () => {
  it('is disabled by default', () => {
    // The one default that is different from the dashboard's, and deliberately: this
    // endpoint is reachable by every logged-in browser, not just an operator.
    expect(resolveConfig().enabled).toBe(false);
    expect(resolveConfig({ enabled: true }).enabled).toBe(true);
  });

  it('normalizes the mount path', () => {
    expect(resolveConfig().path).toBe('/payments/client');
    expect(resolveConfig({ path: 'checkout/' }).path).toBe('/checkout');
    expect(resolveConfig({ path: '//checkout//status//' }).path).toBe('/checkout//status');
    expect(resolveConfig({ path: '/' }).path).toBe('');
  });

  it('resolves the user structurally, from authkit or from an AdonisJS guard', async () => {
    // `getUser()` — @adonis-agora/authkit-client's Authenticator.
    expect(await resolveRequestUser(ctx({ getUser: async () => ({ id: 7 }) }))).toEqual({ id: 7 });
    // `.user` — any @adonisjs/auth guard.
    expect(await resolveRequestUser(ctx({ user: { id: 9 } }))).toEqual({ id: 9 });
    // Neither. Nothing is imported from either package to tell them apart.
    expect(await resolveRequestUser(ctx({}))).toBeNull();
    expect(await resolveRequestUser(ctx(undefined))).toBeNull();
    expect(await resolveRequestUser(undefined)).toBeNull();
  });

  it('treats a throwing getUser as anonymous, not as a 500', async () => {
    const throwing = ctx({
      getUser: async () => {
        throw new Error('unauthenticated');
      },
    });
    expect(await resolveRequestUser(throwing)).toBeNull();
    expect(await defaultAuthorize(throwing)).toBe(false);
  });

  it('default authorize requires a resolved user', async () => {
    expect(await defaultAuthorize(ctx({ user: { id: 1 } }))).toBe(true);
    expect(await defaultAuthorize(ctx({}))).toBe(false);
  });

  it('default owner derives { type: User, id } from that same user', async () => {
    expect(await defaultOwner(ctx({ user: { id: 42 } }))).toEqual({ type: 'User', id: '42' });
    expect(await defaultOwner(ctx({ getUser: async () => ({ id: 'u_1' }) }))).toEqual({
      type: 'User',
      id: 'u_1',
    });
    // No user, or a user with no id, is nobody — and nobody owns nothing.
    expect(await defaultOwner(ctx({}))).toBeNull();
    expect(await defaultOwner(ctx({ user: {} }))).toBeNull();
    expect(await defaultOwner(ctx({ user: { id: '' } }))).toBeNull();
  });

  it('resolveReference defaults to the identity mapping', async () => {
    const config = resolveConfig();
    expect(await config.resolveReference(ctx({}), 'pi_123')).toBe('pi_123');
  });
});
