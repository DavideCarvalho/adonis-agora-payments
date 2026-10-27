import * as crypto from 'node:crypto';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    createPublicKey: vi.fn(actual.createPublicKey),
    verify: vi.fn(actual.verify),
  };
});

const { verifyRsaSha256Signature } = await import('../src/webhook_security.js');

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const sign = (body: string) => {
    const signer = createSign('RSA-SHA256');
    signer.update(body);
    return signer.sign(privateKey, 'base64');
  };
  return { pem, sign };
}

describe('verifyRsaSha256Signature key parsing', () => {
  beforeEach(() => {
    vi.mocked(crypto.createPublicKey).mockClear();
    vi.mocked(crypto.verify).mockClear();
  });

  it('parses a configured key once, however many webhooks it verifies', () => {
    const { pem, sign } = keyPair();
    for (const body of ['{"a":1}', '{"a":2}', '{"a":3}']) {
      expect(verifyRsaSha256Signature(body, sign(body), pem)).toBe(true);
    }
    // The base64-of-PEM spelling the Woovi dashboard shows is a different string: one more parse.
    const base64 = Buffer.from(pem, 'utf8').toString('base64');
    expect(verifyRsaSha256Signature('{"a":4}', sign('{"a":4}'), base64)).toBe(true);
    expect(verifyRsaSha256Signature('{"a":5}', sign('{"a":5}'), base64)).toBe(true);

    expect(crypto.createPublicKey).toHaveBeenCalledTimes(2);
    const keys = vi.mocked(crypto.verify).mock.calls.map((call) => call[2]);
    expect(keys.every((key) => key instanceof crypto.KeyObject)).toBe(true);
    expect(new Set(keys.slice(0, 3)).size).toBe(1);
  });

  it('still rejects a wrong signature against the cached key', () => {
    const { pem, sign } = keyPair();
    expect(verifyRsaSha256Signature('{"a":1}', sign('{"a":1}'), pem)).toBe(true);
    expect(verifyRsaSha256Signature('{"a":2}', sign('{"a":1}'), pem)).toBe(false);
  });

  it('keeps a bounded number of keys', () => {
    const pairs = Array.from({ length: 40 }, keyPair);
    for (const { pem, sign } of pairs) verifyRsaSha256Signature('{}', sign('{}'), pem);
    vi.mocked(crypto.createPublicKey).mockClear();

    // The newest are still cached; the oldest were evicted and parse again.
    const newest = pairs.at(-1);
    const oldest = pairs[0];
    verifyRsaSha256Signature('{}', newest?.sign('{}'), newest?.pem ?? '');
    expect(crypto.createPublicKey).toHaveBeenCalledTimes(0);
    verifyRsaSha256Signature('{}', oldest?.sign('{}'), oldest?.pem ?? '');
    expect(crypto.createPublicKey).toHaveBeenCalledTimes(1);
  });
});
