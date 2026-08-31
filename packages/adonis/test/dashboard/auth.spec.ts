import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultAuthorize, resolveConfig } from '../../src/dashboard/define_config.js';

/** Minimal HttpContext stand-in exposing the bits the guard reads. */
function fakeCtx(
  opts: { headers?: Record<string, string>; qs?: Record<string, string> } = {},
): HttpContext {
  const headers = opts.headers ?? {};
  return {
    request: {
      header: (name: string) => headers[name.toLowerCase()],
      qs: () => opts.qs ?? {},
    },
  } as unknown as HttpContext;
}

const NODE_ENV = process.env.NODE_ENV;
const TOKEN = process.env.PAYMENTS_DASHBOARD_TOKEN;

/** Set an env var to a string value, or remove it entirely when `undefined`. */
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

describe('defaultAuthorize', () => {
  beforeEach(() => {
    setEnv('PAYMENTS_DASHBOARD_TOKEN', undefined);
  });
  afterEach(() => {
    setEnv('NODE_ENV', NODE_ENV);
    setEnv('PAYMENTS_DASHBOARD_TOKEN', TOKEN);
  });

  it('allows everything outside production', () => {
    process.env.NODE_ENV = 'development';
    expect(defaultAuthorize(fakeCtx())).toBe(true);
  });

  it('denies in production when no token is configured (fail-closed)', () => {
    // The posture that matters: an operator who ships to production without setting the token
    // gets a closed door, not an open console.
    process.env.NODE_ENV = 'production';
    setEnv('PAYMENTS_DASHBOARD_TOKEN', undefined);
    expect(defaultAuthorize(fakeCtx())).toBe(false);
    process.env.PAYMENTS_DASHBOARD_TOKEN = '';
    expect(defaultAuthorize(fakeCtx())).toBe(false);
  });

  it('denies in production with a wrong token', () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENTS_DASHBOARD_TOKEN = 'secret';
    expect(defaultAuthorize(fakeCtx({ headers: { authorization: 'Bearer nope' } }))).toBe(false);
  });

  it('denies in production with a token of a different length (the timingSafeEqual guard)', () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENTS_DASHBOARD_TOKEN = 'secret';
    expect(defaultAuthorize(fakeCtx({ headers: { authorization: 'Bearer s' } }))).toBe(false);
  });

  it('allows in production with a matching bearer token', () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENTS_DASHBOARD_TOKEN = 'secret';
    expect(defaultAuthorize(fakeCtx({ headers: { authorization: 'Bearer secret' } }))).toBe(true);
  });

  it('accepts the token via the x-payments-token header', () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENTS_DASHBOARD_TOKEN = 'secret';
    expect(defaultAuthorize(fakeCtx({ headers: { 'x-payments-token': 'secret' } }))).toBe(true);
  });

  it('accepts the token via the query string', () => {
    process.env.NODE_ENV = 'production';
    process.env.PAYMENTS_DASHBOARD_TOKEN = 'secret';
    expect(defaultAuthorize(fakeCtx({ qs: { token: 'secret' } }))).toBe(true);
  });
});

describe('resolveConfig', () => {
  it('defaults to enabled, the /payments-dashboard mount, BRL and defaultAuthorize', () => {
    const config = resolveConfig();
    expect(config.enabled).toBe(true);
    // NOT `/payments` — that prefix already carries the gateway webhook route.
    expect(config.path).toBe('/payments');
    expect(config.currency).toBe('BRL');
    expect(config.authorize).toBe(defaultAuthorize);
    expect(config.dashboardAuth).toBeNull();
  });

  it('normalizes the mount path', () => {
    expect(resolveConfig({ path: 'ops/billing' }).path).toBe('/ops/billing');
    expect(resolveConfig({ path: '/ops/billing/' }).path).toBe('/ops/billing');
    expect(resolveConfig({ path: '///ops//' }).path).toBe('/ops');
  });

  it('keeps a root mount as the empty string, not "/"', () => {
    // `''` is what makes `${path}/api` come out as `/api` instead of `//api`.
    expect(resolveConfig({ path: '/' }).path).toBe('');
  });

  it('carries enabled:false through', () => {
    expect(resolveConfig({ enabled: false }).enabled).toBe(false);
  });

  it('keeps a custom authorize hook', () => {
    const authorize = () => true;
    expect(resolveConfig({ authorize }).authorize).toBe(authorize);
  });

  it('resolves dashboardAuth at boot so a bad config fails closed immediately', () => {
    expect(() => resolveConfig({ dashboardAuth: { secret: '', login: () => null } })).toThrow(
      /secret is required/,
    );
    expect(() => resolveConfig({ dashboardAuth: { secret: 's' } })).toThrow(/login/);
    const resolved = resolveConfig({ dashboardAuth: { secret: 's', login: () => null } });
    expect(resolved.dashboardAuth?.modes).toEqual(['login']);
  });
});
