import { createHash, timingSafeEqual } from 'node:crypto';
import type { HttpContext } from '@adonisjs/core/http';

/**
 * The console access contract every `@adonis-agora` console (durable, telescope, media, payments,
 * agent, the authkit admin) takes for its `authorize` option. These types are copied, not shared
 * through a package, and kept identical across the libs: TypeScript is structural, so one
 * authorizer class satisfies every console.
 */

/** What an authorizer may answer. */
export type ConsoleAuthorizeResult =
  | boolean
  | { allowed: true }
  | { allowed: false; reason?: 'unauthenticated' | 'forbidden' }
  | { redirectTo: string };

/** A class form, for an authorizer in its own file (`@inject()` works). */
export interface ConsoleAuthorizer {
  authorize(ctx: HttpContext): ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>;
}

// biome-ignore lint/suspicious/noExplicitAny: the constructor takes whatever the container injects.
export type ConsoleAuthorizerClass = new (...args: any[]) => ConsoleAuthorizer;

/** The `authorize` option: an inline function, the authorizer class, or a lazy import of it. */
export type ConsoleAuthorize =
  | ((ctx: HttpContext) => ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>)
  | ConsoleAuthorizerClass
  | (() => Promise<{ default: ConsoleAuthorizerClass }>);

/** A {@link ConsoleAuthorizeResult} normalized to the answer the console writes. */
export type ConsoleAuthorizeDecision =
  | { allowed: true }
  | { allowed: false; status: 401; reason: 'unauthenticated' }
  | { allowed: false; status: 403; reason: 'forbidden'; error?: unknown }
  | { allowed: false; status: 302; redirectTo: string };

const FORBIDDEN = { allowed: false, status: 403, reason: 'forbidden' } as const;

function isAuthorizerClass(value: unknown): value is ConsoleAuthorizerClass {
  return (
    typeof value === 'function' &&
    typeof (value as { prototype?: { authorize?: unknown } }).prototype?.authorize === 'function'
  );
}

/** A module namespace whose `default` export is an authorizer class: a lazy import resolved. */
function lazyModuleClass(value: unknown): ConsoleAuthorizerClass | undefined {
  if (typeof value !== 'object' || value === null || !('default' in value)) return undefined;
  const candidate = (value as { default: unknown }).default;
  return isAuthorizerClass(candidate) ? candidate : undefined;
}

/**
 * Normalize an authorizer's answer. Fails closed: only `true` or `{ allowed: true }` passes;
 * `{ redirectTo }` with a non-empty string is a redirect; anything else is a denial (`401` for
 * `reason: 'unauthenticated'`, `403` otherwise).
 */
export function normalizeConsoleAuthorizeResult(result: unknown): ConsoleAuthorizeDecision {
  if (result === true) return { allowed: true };
  if (typeof result !== 'object' || result === null) return FORBIDDEN;
  const value = result as { allowed?: unknown; reason?: unknown; redirectTo?: unknown };
  if (value.allowed === true) return { allowed: true };
  if (value.allowed === undefined && typeof value.redirectTo === 'string' && value.redirectTo) {
    return { allowed: false, status: 302, redirectTo: value.redirectTo };
  }
  if (value.reason === 'unauthenticated') {
    return { allowed: false, status: 401, reason: 'unauthenticated' };
  }
  return FORBIDDEN;
}

async function instantiate(
  Authorizer: ConsoleAuthorizerClass,
  ctx: HttpContext,
): Promise<ConsoleAuthorizer> {
  const resolver = (ctx as { containerResolver?: { make?: unknown } }).containerResolver;
  if (resolver && typeof resolver.make === 'function') {
    return (await (resolver.make as (c: ConsoleAuthorizerClass) => unknown)(
      Authorizer,
    )) as ConsoleAuthorizer;
  }
  return new Authorizer();
}

/**
 * Turn an `authorize` option into one guard function.
 *
 * - A class is built through the request's container (`ctx.containerResolver.make`), so
 *   `@inject()` works, and its `authorize(ctx)` is called.
 * - A function is called with `ctx`. When it resolves to a module whose `default` is an
 *   authorizer class, it was a lazy import: the class is remembered (the import runs once per
 *   returned guard) and used as above.
 * - A thrown error is a `403` denial, carried on `error` so the caller can log it.
 */
export function resolveConsoleAuthorize(
  authorize: ConsoleAuthorize,
): (ctx: HttpContext) => Promise<ConsoleAuthorizeDecision> {
  let lazyClass: ConsoleAuthorizerClass | undefined;

  const run = async (ctx: HttpContext): Promise<unknown> => {
    if (lazyClass) return (await instantiate(lazyClass, ctx)).authorize(ctx);
    if (isAuthorizerClass(authorize)) return (await instantiate(authorize, ctx)).authorize(ctx);
    const result = await (authorize as (ctx: HttpContext) => unknown)(ctx);
    const imported = lazyModuleClass(result);
    if (imported) {
      lazyClass = imported;
      return (await instantiate(imported, ctx)).authorize(ctx);
    }
    return result;
  };

  return async (ctx) => {
    try {
      return normalizeConsoleAuthorizeResult(await run(ctx));
    } catch (error) {
      return { ...FORBIDDEN, error };
    }
  };
}

/** Options for {@link authorizeByToken}. */
export interface AuthorizeByTokenOptions {
  /** The shared secret callers send as `Authorization: Bearer <token>`. */
  token: string | undefined;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * An `authorize` check for machine access: allows a request whose `Authorization` header is
 * `Bearer <token>` (compared in constant time), and answers
 * `{ allowed: false, reason: 'unauthenticated' }` (`401`) otherwise. Only the header is read.
 *
 * ```ts
 * authorize: authorizeByToken({ token: env.get('CONSOLE_TOKEN') }),
 * ```
 *
 * Throws at config time when `token` is empty or undefined.
 */
export function authorizeByToken(options: AuthorizeByTokenOptions): ConsoleAuthorize {
  const token = options?.token;
  if (typeof token !== 'string' || token === '') {
    throw new Error(
      '[@adonis-agora/payments] authorizeByToken: `token` must be a non-empty string',
    );
  }
  const expected = digest(token);
  return (ctx: HttpContext): ConsoleAuthorizeResult => {
    const header = ctx.request.header('authorization');
    const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
    if (match?.[1] && timingSafeEqual(digest(match[1]), expected)) return { allowed: true };
    return { allowed: false, reason: 'unauthenticated' };
  };
}
