import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyStandardWebhookSignature } from '../src/webhook_security.js';

/**
 * Standard Webhooks, with the part that actually bites: the KEY DERIVATION.
 *
 * The spec says base64-decode the secret after stripping `whsec_`; Polar instead uses the
 * secret's raw UTF-8 bytes, prefix included. Neither vendor documents which it does — both
 * were read out of their SDK source. Getting it wrong fails closed, so the cost is a
 * rejected webhook rather than an accepted forgery, which is exactly why it can sit
 * undetected until a real callback arrives.
 */
describe('verifyStandardWebhookSignature', () => {
  const NOW = new Date('2026-08-27T12:00:00.000Z');
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const id = 'msg_1';
  const rawBody = '{"type":"order.paid"}';
  const secret = 'whsec_c2VjcmV0LWtleS1oZXJl';

  const signWith = (key: Buffer) =>
    createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`, 'utf8').digest('base64');

  const base64Key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const rawKey = Buffer.from(secret, 'utf8');

  const headers = (signature: string, ts = timestamp) => ({
    'webhook-id': id,
    'webhook-timestamp': ts,
    'webhook-signature': signature,
  });

  it('accepts a signature made with the spec base64 derivation', () => {
    const ok = verifyStandardWebhookSignature({
      rawBody,
      headers: headers(`v1,${signWith(base64Key)}`),
      secret,
      keyEncoding: 'base64',
      now: NOW,
    });
    expect(ok).toBe(true);
  });

  it('accepts a signature made with the raw-bytes derivation', () => {
    const ok = verifyStandardWebhookSignature({
      rawBody,
      headers: headers(`v1,${signWith(rawKey)}`),
      secret,
      keyEncoding: 'raw',
      now: NOW,
    });
    expect(ok).toBe(true);
  });

  it('rejects a signature made with the OTHER derivation', () => {
    // The whole reason `keyEncoding` exists. Both directions, because either driver
    // adopting the other's derivation is the same silent, closed failure.
    expect(
      verifyStandardWebhookSignature({
        rawBody,
        headers: headers(`v1,${signWith(rawKey)}`),
        secret,
        keyEncoding: 'base64',
        now: NOW,
      }),
    ).toBe(false);

    expect(
      verifyStandardWebhookSignature({
        rawBody,
        headers: headers(`v1,${signWith(base64Key)}`),
        secret,
        keyEncoding: 'raw',
        now: NOW,
      }),
    ).toBe(false);
  });

  it('rejects a tampered body', () => {
    expect(
      verifyStandardWebhookSignature({
        rawBody: '{"type":"order.refunded"}',
        headers: headers(`v1,${signWith(base64Key)}`),
        secret,
        keyEncoding: 'base64',
        now: NOW,
      }),
    ).toBe(false);
  });

  it('accepts when any entry in a rotation list matches', () => {
    // A secret being rotated is signed with both keys at once; checking only the first
    // entry would reject every genuine webhook for the length of the rotation.
    const signature = `v1,${signWith(Buffer.from('other', 'utf8'))} v1,${signWith(base64Key)}`;
    expect(
      verifyStandardWebhookSignature({
        rawBody,
        headers: headers(signature),
        secret,
        keyEncoding: 'base64',
        now: NOW,
      }),
    ).toBe(true);
  });

  it('rejects a replay outside the tolerance, and accepts it when tolerance is off', () => {
    const old = String(Math.floor(NOW.getTime() / 1000) - 3600);
    const signature = `v1,${createHmac('sha256', base64Key).update(`${id}.${old}.${rawBody}`, 'utf8').digest('base64')}`;

    expect(
      verifyStandardWebhookSignature({
        rawBody,
        headers: headers(signature, old),
        secret,
        keyEncoding: 'base64',
        now: NOW,
      }),
    ).toBe(false);

    expect(
      verifyStandardWebhookSignature({
        rawBody,
        headers: headers(signature, old),
        secret,
        keyEncoding: 'base64',
        toleranceSeconds: 0,
        now: NOW,
      }),
    ).toBe(true);
  });

  it('rejects when a required header is missing', () => {
    expect(
      verifyStandardWebhookSignature({
        rawBody,
        headers: { 'webhook-id': id, 'webhook-timestamp': timestamp },
        secret,
        keyEncoding: 'base64',
        now: NOW,
      }),
    ).toBe(false);
  });
});
