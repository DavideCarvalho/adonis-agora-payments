import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/dashboard/define_config.js';

describe('resolveConfig', () => {
  it('defaults to enabled, the /payments mount, BRL and no authorize', () => {
    const config = resolveConfig();
    expect(config.enabled).toBe(true);
    expect(config.path).toBe('/payments');
    expect(config.currency).toBe('BRL');
    expect(config.authorize).toBeNull();
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
