/**
 * The dashboard-gate contract: what an `authorize` hook may answer, and how that answer becomes an
 * HTTP status. Framework-light (no AdonisJS types), so it is unit-testable on its own.
 *
 * Every `@adonis-agora` console (payments, durable, telescope, media, agent) carries an IDENTICAL
 * copy of these types — copied, not shared through a package — so a hook such as
 * `@adonis-agora/authz`'s `authorizeByRoles` can be dropped into any of them and mean the same thing.
 *
 * The one rule that matters most: a decision OBJECT is truthy, so `if (!(await authorize(ctx)))`
 * would wave `{ allowed: false }` through. Always go through {@link resolveAuthorizeResult}.
 */

/**
 * A structured answer from an `authorize` hook. `reason` lets a console tell "nobody is signed in"
 * (`401`) apart from "signed in, but not allowed" (`403`). Omitted on a denial → `403`.
 */
export interface AuthorizeDecision {
  allowed: boolean;
  reason?: 'unauthenticated' | 'forbidden';
}

/** What an `authorize` hook returns: a bare boolean, or an {@link AuthorizeDecision}. */
export type AuthorizeResult = boolean | AuthorizeDecision;

/** An {@link AuthorizeResult} normalized to the HTTP answer it maps to. */
export type ResolvedAuthorizeResult =
  | { allowed: true }
  | { allowed: false; status: 401; reason: 'unauthenticated' }
  | { allowed: false; status: 403; reason: 'forbidden' };

const FORBIDDEN = { allowed: false, status: 403, reason: 'forbidden' } as const;

/**
 * Normalize whatever an `authorize` hook returned. Fails CLOSED: only `true` or an object whose
 * `allowed` is exactly `true` passes; anything else (`false`, `{ allowed: false }`, `undefined`, a
 * malformed value) is a denial — `401` when the hook said `reason: 'unauthenticated'`, `403`
 * otherwise.
 */
export function resolveAuthorizeResult(result: unknown): ResolvedAuthorizeResult {
  if (result === true) return { allowed: true };
  if (typeof result !== 'object' || result === null) return FORBIDDEN;
  const decision = result as Partial<AuthorizeDecision>;
  if (decision.allowed === true) return { allowed: true };
  if (decision.reason === 'unauthenticated') {
    return { allowed: false, status: 401, reason: 'unauthenticated' };
  }
  return FORBIDDEN;
}

/**
 * Run an `authorize` hook and normalize its answer. A hook that THROWS is a `403` denial, never a
 * `500` and never a pass; the error is handed back so the caller can log it.
 */
export async function runAuthorize<Ctx>(
  hook: (ctx: Ctx) => AuthorizeResult | Promise<AuthorizeResult>,
  ctx: Ctx,
): Promise<ResolvedAuthorizeResult & { hookError?: unknown }> {
  try {
    return resolveAuthorizeResult(await hook(ctx));
  } catch (error) {
    return { ...FORBIDDEN, hookError: error };
  }
}
