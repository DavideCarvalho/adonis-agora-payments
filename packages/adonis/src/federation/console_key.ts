import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

/**
 * The X25519 key an app's console commands are sealed to (token mode of the federated console), and
 * the seal itself. The same construction and wire format as the agora crypto-kit's `sealTo` /
 * `openWith` (`agora:pk1:<kid>:<ephemeral x>:<iv>:<tag>:<ciphertext>`: ephemeral X25519 + HKDF-SHA256
 * + AES-256-GCM), kept here so `@adonis-agora/payments` needs no crypto package at runtime.
 */

/** An X25519 JSON Web Key (RFC 8037). The private key also has `d`. */
export interface OkpJwk {
  kty: 'OKP';
  crv: 'X25519';
  x: string;
  /** Private part: present on a private key only. */
  d?: string;
  kid: string;
  use?: 'enc';
  alg?: 'ECDH-ES';
}

const SEALED_TO_PREFIX = 'agora:pk1:';
const KID = /^[A-Za-z0-9._-]{1,128}$/;
/** PKCS#8 prefix of a raw 32-byte X25519 private key (RFC 8410). */
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');

/** RFC 7638 thumbprint of the key: a stable `kid`. */
function thumbprint(x: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ crv: 'X25519', kty: 'OKP', x }))
    .digest('base64url');
}

/**
 * The same X25519 key pair every time from `secret` (the app's `APP_KEY`): HKDF-SHA256(secret,
 * salt = `purpose`) is the private key. Nothing to store: every instance derives it, and a new
 * `APP_KEY` makes a new key (and `kid`).
 */
export function deriveX25519KeyPair(
  secret: string,
  purpose: string,
): { publicKey: OkpJwk; privateKey: OkpJwk } {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error(
      '[@adonis-agora/payments] the console-command key needs an APP_KEY of 16+ characters',
    );
  }
  const info = Buffer.from('agora:okp:v1:x25519', 'utf8');
  const seed = Buffer.from(hkdfSync('sha256', secret, Buffer.from(purpose, 'utf8'), info, 32));
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  seed.fill(0);
  const raw = key.export({ format: 'jwk' }) as { x: string; d: string };
  const publicKey: OkpJwk = {
    kty: 'OKP',
    crv: 'X25519',
    x: raw.x,
    kid: thumbprint(raw.x),
    use: 'enc',
    alg: 'ECDH-ES',
  };
  return { publicKey, privateKey: { ...publicKey, d: raw.d } };
}

/** Whether `value` is an X25519 public JWK with a `kid` (and no private part). */
export function isX25519PublicJwk(value: unknown): value is OkpJwk {
  const jwk = value as Partial<OkpJwk> | undefined;
  return (
    !!jwk &&
    typeof jwk === 'object' &&
    jwk.kty === 'OKP' &&
    jwk.crv === 'X25519' &&
    typeof jwk.x === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(jwk.x) &&
    typeof jwk.kid === 'string' &&
    KID.test(jwk.kid) &&
    jwk.d === undefined
  );
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
function decode(part: string | undefined): Buffer | undefined {
  if (part === undefined || !/^[A-Za-z0-9_-]+$/.test(part)) return undefined;
  const bytes = Buffer.from(part, 'base64url');
  return b64(bytes) === part ? bytes : undefined;
}

const publicNodeKey = (x: string) =>
  createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' });

function contentKey(shared: Buffer, kid: string, ephemeralX: string, recipientX: string): Buffer {
  const info = Buffer.from(JSON.stringify(['agora:pk1', kid, ephemeralX, recipientX]), 'utf8');
  return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), info, 32));
}

const aadOf = (kid: string, aad: string | undefined) =>
  Buffer.from(JSON.stringify(['agora:pk1', kid, aad ?? null]), 'utf8');

/** Encrypts `value` so only the holder of `recipient`'s private key opens it. */
export function sealTo(recipient: OkpJwk, value: string, options: { aad?: string } = {}): string {
  if (recipient?.kty !== 'OKP' || recipient.crv !== 'X25519' || !KID.test(recipient.kid ?? '')) {
    throw new Error('[@adonis-agora/payments] sealTo() needs an X25519 public JWK with a kid');
  }
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralX = (ephemeral.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: publicNodeKey(recipient.x),
  });
  const key = contentKey(shared, recipient.kid, ephemeralX, recipient.x);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(aadOf(recipient.kid, options.aad));
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const parts = [recipient.kid, ephemeralX, b64(iv), b64(cipher.getAuthTag()), b64(body)];
  return `${SEALED_TO_PREFIX}${parts.join(':')}`;
}

/** Opens a {@link sealTo} value with `privateKey` (its `kid` must be the one sealed for). */
export function openWith(
  privateKey: OkpJwk,
  sealed: string,
  options: { aad?: string } = {},
): string {
  if (typeof sealed !== 'string' || !sealed.startsWith(SEALED_TO_PREFIX)) {
    throw new Error('not an agora:pk1 value');
  }
  const [kid, ephemeralX, ivPart, tagPart, bodyPart, ...extra] = sealed
    .slice(SEALED_TO_PREFIX.length)
    .split(':');
  const ephemeral = decode(ephemeralX);
  const iv = decode(ivPart);
  const tag = decode(tagPart);
  const body = bodyPart === '' ? Buffer.alloc(0) : decode(bodyPart);
  if (!kid || !KID.test(kid) || extra.length > 0 || ephemeral?.length !== 32) {
    throw new Error('malformed agora:pk1 value');
  }
  if (iv?.length !== 12 || tag?.length !== 16 || !body) {
    throw new Error('malformed agora:pk1 value');
  }
  if (kid !== privateKey.kid || typeof privateKey.d !== 'string') {
    throw new Error(`no X25519 private key with kid "${kid}"`);
  }
  const shared = diffieHellman({
    privateKey: createPrivateKey({
      key: { kty: 'OKP', crv: 'X25519', x: privateKey.x, d: privateKey.d },
      format: 'jwk',
    }),
    publicKey: publicNodeKey(ephemeralX as string),
  });
  const cek = contentKey(shared, kid, ephemeralX as string, privateKey.x);
  const decipher = createDecipheriv('aes-256-gcm', cek, iv, { authTagLength: 16 });
  decipher.setAAD(aadOf(kid, options.aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
