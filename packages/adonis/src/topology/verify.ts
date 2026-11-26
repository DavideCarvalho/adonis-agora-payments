import { timingSafeEqual } from 'node:crypto';
import type { HttpContext } from '@adonisjs/core/http';

/**
 * What a payments control plane trusts about a request: derived from the verified token, never from the
 * request. The shape every Agora control plane uses — `authkitTenantVerifier` from
 * `@adonis-agora/authkit-client` returns it.
 */
export interface VerifiedTenant {
  /** The application (the partition). This is the ONLY source of the app a token may touch. */
  partition: string;
  /** `payments:charge`, `payments:events`, `payments:*`, … Never empty. */
  capabilities: string[];
  /**
   * The human an agent is acting for (RFC 8693 `act`), when the token says. Audit uses
   * `actor ?? clientId ?? partition`; authorization always uses the token's own capabilities.
   */
  actor?: string;
  /** The service-tenant client behind the token, when it says. */
  clientId?: string;
  /** Epoch ms after which calls with this token must stop. */
  expiresAt?: number;
  /** The calling app, for an authkit app-call token (its audience already names this app). */
  app?: string;
}

/** What a verifier receives. Only `token` is trusted, once verified. */
export interface TenantAuthRequest {
  /** The bearer token (or the shared secret). */
  token?: string | undefined;
  /** The app the caller claims (`x-payments-app`). Advisory only. */
  partition?: string | undefined;
  /** Same as `partition` (the wire name other libs use). Advisory only. */
  tenant?: string | undefined;
  /** The app the caller claims; the name this package uses for `partition`. */
  app?: string | undefined;
  headers?: Readonly<Record<string, string | undefined>> | undefined;
}

/** The top-level `verifyTenant` contract. */
export type TenantVerifier = (
  request: TenantAuthRequest,
) => VerifiedTenant | null | Promise<VerifiedTenant | null>;

/** A class instance implementing `verify`. */
export interface TenantVerifierObject {
  verify(request: TenantAuthRequest): VerifiedTenant | null | Promise<VerifiedTenant | null>;
}

/** A lazily imported verifier module: a verifier, a class, or an object with `verify`. */
export interface TenantVerifierModule {
  default?: TenantVerifier | TenantVerifierObject | (new () => TenantVerifierObject);
  verify?: TenantVerifier | TenantVerifierObject;
  tenantVerifier?: TenantVerifier | TenantVerifierObject;
}

/** The accepted forms: a function, a class instance, a class, or a lazy `() => import(...)`. */
export type TenantVerifierInput =
  | TenantVerifier
  | TenantVerifierObject
  | (new () => TenantVerifierObject)
  | (() => Promise<TenantVerifierModule> | TenantVerifierModule);

function hasVerify(value: unknown): value is TenantVerifierObject {
  return (
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { verify?: unknown }).verify === 'function'
  );
}

function isVerifierClass(value: unknown): value is new () => TenantVerifierObject {
  return (
    typeof value === 'function' &&
    typeof (value as { prototype?: { verify?: unknown } }).prototype?.verify === 'function'
  );
}

/**
 * Validates a verifier's answer. `null` refuses; `{ partition, capabilities }` accepts; anything
 * else throws, so a malformed answer is never taken for an accepted tenant. Capabilities are NOT
 * defaulted: a verifier must say what the token may do.
 */
export function checkVerifiedTenant(result: unknown): VerifiedTenant | null {
  if (result === null || result === undefined) return null;
  const value = result as Partial<VerifiedTenant> & { tenant?: unknown; scope?: unknown };
  if (
    typeof value === 'object' &&
    typeof value.partition === 'string' &&
    value.partition.length > 0 &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((capability) => typeof capability === 'string') &&
    (value.actor === undefined || typeof value.actor === 'string') &&
    (value.clientId === undefined || typeof value.clientId === 'string') &&
    (value.expiresAt === undefined || typeof value.expiresAt === 'number')
  ) {
    return value as VerifiedTenant;
  }
  throw new TypeError(
    `[@adonis-agora/payments] verifyTenant must return { partition: string, capabilities: string[] } or null${
      value && typeof result === 'object' && 'tenant' in value
        ? ' (it returned `tenant`; rename it to `partition`)'
        : ''
    }`,
  );
}

/**
 * Turns any `verifyTenant` form into the function the server calls: a function, an object with
 * `verify` (a class instance), a class, or a lazy import of one. Authkit's
 * `authkitTenantVerifier()` is the function form and needs no wrapper.
 */
export function resolveTenantVerifier(
  input: TenantVerifierInput,
): (request: TenantAuthRequest) => Promise<VerifiedTenant | null> {
  if (isVerifierClass(input)) {
    let instance: TenantVerifierObject | undefined;
    return async (request) => {
      instance ??= new input();
      return checkVerifiedTenant(await instance.verify(request));
    };
  }
  if (hasVerify(input)) {
    return async (request) => checkVerifiedTenant(await input.verify(request));
  }
  if (typeof input !== 'function') {
    throw new TypeError(
      '[@adonis-agora/payments] `verifyTenant` must be a function, an object with verify() (a class instance), or a lazy import of one',
    );
  }
  const fn = input as (request: TenantAuthRequest) => unknown;
  let lazy: Promise<(request: TenantAuthRequest) => Promise<VerifiedTenant | null>> | undefined;
  return async (request) => {
    if (lazy) return (await lazy)(request);
    const result = await fn(request);
    const exported =
      result && typeof result === 'object' && 'default' in (result as Record<string, unknown>)
        ? (result as TenantVerifierModule).default
        : undefined;
    const named =
      exported ??
      (result && typeof result === 'object'
        ? ((result as TenantVerifierModule).tenantVerifier ??
          (result as TenantVerifierModule).verify)
        : undefined);
    if (named !== undefined) {
      lazy = Promise.resolve(resolveTenantVerifier(named as TenantVerifierInput));
      return (await lazy)(request);
    }
    return checkVerifiedTenant(result);
  };
}

/** Constant-time comparison that does not leak the length through an early return. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export interface SharedSecretTenant {
  secret: string;
  /**
   * What this app may do, e.g. `['payments:charge', 'payments:events']`. Default
   * `['payments:*']`: a shared secret is a full-trust credential, so pass the narrow list whenever
   * the app does not need everything.
   */
  capabilities?: string[];
  /** The human to record in the audit trail when the secret is used by an agent. */
  actor?: string;
}

/**
 * One shared secret per app, compared in constant time. The caller names its app with
 * `x-payments-app`; the secret proves it. Without authkit this is the whole auth story.
 */
export function sharedSecretVerifier(options: {
  partitions: Record<string, string | SharedSecretTenant>;
}): TenantVerifier {
  return (request) => {
    const app = request.app ?? request.partition ?? request.tenant;
    if (!request.token || !app) return null;
    const entry = options.partitions[app];
    if (entry === undefined) return null;
    const config = typeof entry === 'string' ? { secret: entry } : entry;
    if (!sameSecret(request.token, config.secret)) return null;
    return {
      partition: app,
      capabilities: config.capabilities ?? ['payments:*'],
      ...(config.actor !== undefined ? { actor: config.actor } : {}),
    };
  };
}

/** The bearer token of a request (`authorization: Bearer`), or `x-api-key` for shared secrets. */
export function bearerToken(ctx: HttpContext): string | undefined {
  const header = ctx.request.header('authorization');
  if (header && /^bearer\s+/i.test(header)) return header.replace(/^bearer\s+/i, '').trim();
  return ctx.request.header('x-api-key') ?? undefined;
}

/** The headers a verifier may need, lowercased. */
export function requestHeaders(ctx: HttpContext): Record<string, string | undefined> {
  const request = ctx.request as unknown as {
    headers?: (() => Record<string, string | string[]>) | Record<string, string | string[]>;
  };
  // Adonis exposes `headers()` as a method that reads `this.request`: calling the detached function
  // throws ("Cannot read properties of undefined"), so it must be invoked on the request itself.
  const headers =
    typeof request.headers === 'function' ? request.headers.call(ctx.request) : request.headers;
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    out[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}
