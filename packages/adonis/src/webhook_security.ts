import { createHash, createHmac, verify as cryptoVerify, timingSafeEqual } from 'node:crypto';
import { headerValue } from './http.js';

/**
 * Shared webhook-auth primitives for the drivers. Every gateway signs webhooks
 * differently (Stripe: SDK HMAC; AbacatePay: HMAC-SHA256; Woovi: HMAC-SHA1 or
 * RSA-SHA256; Asaas: shared token; PagBank: a bare SHA-256 over token+body), but the
 * comparison and digest mechanics are the same — they live here so every driver verifies with the same, timing-safe code.
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
  /**
   * How the gateway encodes the digest. Base64 is the default because the first gateways
   * here used it; hex is at least as common (Paddle, Lemon Squeezy, Razorpay, Mercado Pago,
   * Mollie all send hex), and getting it wrong fails CLOSED — every signature mismatches —
   * so it is safe to leave to the caller.
   */
  encoding: 'base64' | 'hex' = 'base64',
): boolean {
  if (signature === undefined || signature === '') return false;
  const expected = createHmac(algorithm, secret).update(rawBody, 'utf8').digest(encoding);
  return safeCompare(signature, expected);
}

/**
 * The same check over a payload the gateway builds rather than the raw body.
 *
 * Several schemes sign a CONSTRUCTED string — Paddle's `ts:body`, Standard Webhooks'
 * `id.timestamp.body`, Square's `notificationUrl + body`, Mercado Pago's id/request/ts
 * manifest. The signed bytes are the whole security property, so building them is the one
 * step a driver must own; this only removes the reason to hand-roll the comparison, which
 * is where a `===` creeps back in and reintroduces a timing side channel.
 */
export function verifyHmacOverPayload(
  payload: string,
  signature: string | undefined,
  secret: string,
  algorithm: 'sha256' | 'sha1',
  encoding: 'base64' | 'hex' = 'base64',
): boolean {
  if (signature === undefined || signature === '') return false;
  const expected = createHmac(algorithm, secret).update(payload, 'utf8').digest(encoding);
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

/**
 * Verify PagBank's `x-authenticity-token`: the hex SHA-256 of `<token>-<rawBody>`, where
 * `<token>` is the very same Bearer token that authenticates API calls.
 *
 * Read that construction again, because it is not an HMAC. It is a secret **prefix**
 * hashed with a Merkle–Damgård function, which is the textbook setup for a
 * length-extension forgery: anyone who has seen one valid (body, token) pair can compute
 * a valid token for that body plus a suffix, without ever learning the secret. What saves
 * it in practice is that the forged body is the original body followed by binary padding,
 * and `JSON.parse` rejects that — so a forgery has to survive the parser, not just the
 * hash. It is still weaker than the HMAC every other gateway here uses, and the secret is
 * shared with the API credential, so rotating one rotates the other.
 *
 * The comparison is timing-safe and case-insensitive (PagBank sends lowercase hex).
 */
export function verifyPagBankAuthenticityToken(
  rawBody: string,
  received: string | undefined,
  token: string,
): boolean {
  if (received === undefined || received === '') return false;
  const expected = createHash('sha256').update(`${token}-${rawBody}`, 'utf8').digest('hex');
  return safeCompare(received.toLowerCase(), expected);
}

/**
 * Verify a [Standard Webhooks](https://www.standardwebhooks.com/) signature.
 *
 * The scheme: sign `` `${webhook-id}.${webhook-timestamp}.${rawBody}` `` with HMAC-SHA256,
 * base64. The `webhook-signature` header carries a SPACE-SEPARATED list of `v1,<sig>` — a
 * list, because a secret being rotated is signed with both keys at once, so checking only
 * the first entry breaks every rotation.
 *
 * `keyEncoding` is the part that bites, and neither vendor documents it — both derivations
 * below were read out of their own SDK source:
 *
 * - `'base64'` (the spec default) — strip the `whsec_` prefix and base64-DECODE the rest.
 *   Dodo Payments does this.
 * - `'raw'` — use the secret's UTF-8 bytes as-is, `whsec_` prefix included. Polar does this
 *   (its SDK base64-encodes the secret before handing it to the reference library, which
 *   decodes it straight back).
 *
 * Getting it wrong fails closed — every signature mismatches — so the cost is a rejected
 * webhook, not an accepted forgery. Which is why each driver pins its own derivation with a
 * test that signs using the OTHER one and asserts rejection.
 *
 * `toleranceSeconds` bounds replay. It defaults to 5 minutes, the spec's own recommendation;
 * pass `0` to skip the check. Note the idempotency ledger already makes a replayed event a
 * no-op — this is the outer guard, not the only one.
 */
export function verifyStandardWebhookSignature(options: {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  secret: string;
  keyEncoding: 'base64' | 'raw';
  toleranceSeconds?: number;
  /** Overridable clock, so the tolerance is testable. */
  now?: Date;
}): boolean {
  const id = headerValue(options.headers, 'webhook-id');
  const timestamp = headerValue(options.headers, 'webhook-timestamp');
  const signature = headerValue(options.headers, 'webhook-signature');
  if (!id || !timestamp || !signature) return false;

  const tolerance = options.toleranceSeconds ?? 300;
  if (tolerance > 0) {
    const sent = Number(timestamp);
    if (!Number.isFinite(sent)) return false;
    const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
    if (Math.abs(nowSeconds - sent) > tolerance) return false;
  }

  const key =
    options.keyEncoding === 'raw'
      ? Buffer.from(options.secret, 'utf8')
      : Buffer.from(options.secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${options.rawBody}`, 'utf8')
    .digest('base64');

  // Every `v1,<sig>` entry is checked: during a secret rotation the gateway signs with both
  // the old and the new key, and only one of them can match.
  return signature
    .split(' ')
    .filter((part) => part.startsWith('v1,'))
    .some((part) => safeCompare(part.slice(3), expected));
}
