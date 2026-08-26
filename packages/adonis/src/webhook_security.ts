import { createHmac, verify as cryptoVerify, timingSafeEqual } from 'node:crypto';

/**
 * Shared webhook-auth primitives for the drivers. Every gateway signs webhooks
 * differently (Stripe: SDK HMAC; AbacatePay: HMAC-SHA256; Woovi: HMAC-SHA1 or
 * RSA-SHA256; Asaas: shared token), but the comparison and digest mechanics are the
 * same — they live here so every driver verifies with the same, timing-safe code.
 */

/** Length-independent, timing-safe string comparison. */
export function safeCompare(received: string, expected: string): boolean {
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Compute an HMAC over the raw webhook body and compare it to the signature header,
 * timing-safe. `digest` matches the gateway's encoding (`base64` for AbacatePay and
 * Woovi's HMAC mode).
 */
export function verifyHmacSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
  algorithm: 'sha256' | 'sha1',
): boolean {
  if (signature === undefined || signature === '') return false;
  const expected = createHmac(algorithm, secret).update(rawBody, 'utf8').digest('base64');
  return safeCompare(signature, expected);
}

/**
 * Verify Woovi's recommended `x-webhook-signature`: an RSA-SHA256 signature made with
 * Woovi's private key, verified here against the public key published at
 * `GET /api/v1/webhook/public-keys`. The key may be pasted as PEM or as the base64 of a
 * PEM document (the dashboard shows it base64-encoded).
 */
export function verifyRsaSha256Signature(
  rawBody: string,
  signature: string | undefined,
  publicKey: string,
): boolean {
  if (signature === undefined || signature === '') return false;
  const pem = publicKey.includes('-----BEGIN')
    ? publicKey
    : Buffer.from(publicKey, 'base64').toString('utf8');
  return cryptoVerify(
    'RSA-SHA256',
    Buffer.from(rawBody, 'utf8'),
    pem,
    Buffer.from(signature, 'base64'),
  );
}

/**
 * Enforce a configured webhook credential against the request headers. Returns the
 * header value when valid; throws when the driver has a secret configured but the
 * request doesn't carry it or carries a wrong one — fail-closed whenever a secret IS
 * set. Drivers only reach this when their credential is configured.
 */
export function requireMatchingCredential(
  received: string | undefined,
  expected: string,
  provider: string,
  what: string,
): void {
  if (received === undefined || received === '') {
    throw new Error(`[payments] Missing webhook ${what} on ${provider} request.`);
  }
  if (!safeCompare(received, expected)) {
    throw new Error(`[payments] Invalid ${provider} webhook ${what}.`);
  }
}
