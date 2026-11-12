import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** What a card form ticket allows: tokenizing cards for one customer of one gateway, until it expires. */
export interface CardTicket {
  /** Gateway customer id. */
  customerId: string;
  /** The configured provider name the customer belongs to. */
  provider: string;
  /** Expiry, epoch milliseconds. */
  expiresAt: number;
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret)
    .update(`payments-account-card:${payload}`)
    .digest('base64url');
}

/** Issue the ticket the account console's card form sends with the card. */
export function issueCardTicket(secret: string, ticket: CardTicket): string {
  const payload = Buffer.from(
    JSON.stringify({ c: ticket.customerId, p: ticket.provider, e: ticket.expiresAt }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

/** Verify a ticket: `null` when malformed, forged or expired. */
export function verifyCardTicket(
  secret: string,
  value: unknown,
  now: number = Date.now(),
): CardTicket | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(value.slice(dot + 1));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      typeof raw.c !== 'string' ||
      typeof raw.p !== 'string' ||
      typeof raw.e !== 'number' ||
      raw.e < now
    ) {
      return null;
    }
    return { customerId: raw.c, provider: raw.p, expiresAt: raw.e };
  } catch {
    return null;
  }
}

function sealKey(secret: string): Buffer {
  return createHash('sha256').update(`payments-account-card-seal:${secret}`).digest();
}

/**
 * Encrypt a reusable card token for the trip through the browser (AES-256-GCM, bound to the
 * customer), so the page, the form post and any log of it only ever carry ciphertext.
 */
export function sealCardToken(secret: string, token: string, customerId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(secret), iv);
  cipher.setAAD(Buffer.from(customerId, 'utf8'));
  const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** The token {@link sealCardToken} sealed for this customer, or `null`. */
export function unsealCardToken(secret: string, sealed: string, customerId: string): string | null {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length < 29 || raw.length > 1024) return null;
    const decipher = createDecipheriv('aes-256-gcm', sealKey(secret), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(customerId, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
