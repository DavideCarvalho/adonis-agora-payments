import { describe, expect, it } from 'vitest';
import { capabilityAllows, hasCapability } from '../src/topology/protocol.js';

describe('capabilityAllows', () => {
  it('matches an exact capability', () => {
    expect(capabilityAllows(['payments:charge'], 'payments:charge')).toBe(true);
  });

  it('lets `*` match everything', () => {
    expect(capabilityAllows(['*'], 'payments:charge')).toBe(true);
    expect(capabilityAllows(['*'], 'payments:subscriptions:cancel')).toBe(true);
    expect(capabilityAllows(['*'], 'flags:read')).toBe(true);
  });

  it('lets `payments:*` match every payments capability', () => {
    for (const capability of [
      'payments:charge',
      'payments:customers',
      'payments:refund',
      'payments:subscriptions',
      'payments:disputes',
      'payments:read',
      'payments:events',
    ]) {
      expect(capabilityAllows(['payments:*'], capability)).toBe(true);
    }
  });

  it('lets a middle `*` match exactly one segment', () => {
    expect(capabilityAllows(['payments:*:read'], 'payments:subscriptions:read')).toBe(true);
    expect(capabilityAllows(['payments:*:read'], 'payments:subscriptions:write')).toBe(false);
    expect(capabilityAllows(['payments:*:read'], 'payments:read')).toBe(false);
    expect(capabilityAllows(['payments:*:read'], 'payments:a:b:read')).toBe(false);
  });

  it('lets a trailing `*` match zero or more further segments', () => {
    expect(capabilityAllows(['payments:subscriptions:*'], 'payments:subscriptions')).toBe(true);
    expect(capabilityAllows(['payments:subscriptions:*'], 'payments:subscriptions:cancel')).toBe(
      true,
    );
    expect(capabilityAllows(['payments:subscriptions:*'], 'payments:subscriptions:a:b')).toBe(true);
    expect(capabilityAllows(['payments:subscriptions:*'], 'payments:charge')).toBe(false);
    expect(capabilityAllows(['payments:*'], 'payments')).toBe(true);
  });

  it('implies nothing between capabilities', () => {
    expect(capabilityAllows(['payments:read'], 'payments:charge')).toBe(false);
    expect(capabilityAllows(['payments:charge'], 'payments:charge:extra')).toBe(false);
    expect(capabilityAllows(['payments:charge:extra'], 'payments:charge')).toBe(false);
  });

  it('refuses unrelated namespaces', () => {
    expect(capabilityAllows(['flags:*'], 'payments:charge')).toBe(false);
    expect(capabilityAllows(['crypto:*', 'flags:read'], 'payments:read')).toBe(false);
  });

  it('refuses an empty grant list and ignores empty or non-string grants', () => {
    expect(capabilityAllows([], 'payments:charge')).toBe(false);
    expect(capabilityAllows([''], 'payments:charge')).toBe(false);
    expect(capabilityAllows([null, 42, undefined] as unknown as string[], 'payments:charge')).toBe(
      false,
    );
    expect(capabilityAllows(['', 'payments:charge'], 'payments:charge')).toBe(true);
  });
});

describe('hasCapability', () => {
  it('delegates to capabilityAllows', () => {
    expect(hasCapability(['payments:*'], 'payments:refund')).toBe(true);
    expect(hasCapability(['*'], 'payments:refund')).toBe(true);
    expect(hasCapability(['payments:refund'], 'payments:refund')).toBe(true);
    expect(hasCapability(['payments:read'], 'payments:refund')).toBe(false);
  });

  it('only needs a non-empty list when nothing is required (whoami)', () => {
    expect(hasCapability(['payments:read'], null)).toBe(true);
    expect(hasCapability([], null)).toBe(false);
  });
});
