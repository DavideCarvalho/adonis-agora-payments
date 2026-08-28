import type { HttpContext } from '@adonisjs/core/http';
import type { BillingStore } from '../billing/billing_store.js';

/**
 * The app-side row a payment belongs to — the same `{ type, id }` pair
 * `ensureCustomer({ owner })` writes into `billing_customers`.
 */
export interface PaymentOwner {
  type: string;
  id: string;
}

/** A normalized payment, built from named columns only. See `handlers.ts`. */
export interface ClientPayment {
  gatewayId: string;
  provider: string;
  status: string;
  /** Integer minor units, exactly as stored. */
  amount: number;
  currency: string;
  customerId: string | null;
  paidAt: Date | null;
}

/** Whether this request may talk to the client endpoint at all. */
export type ClientAuthorizeHook = (ctx: HttpContext) => boolean | Promise<boolean>;

/** Who is asking. `null` denies the request (`401`). */
export type ClientOwnerHook = (
  ctx: HttpContext,
) => PaymentOwner | null | Promise<PaymentOwner | null>;

/**
 * Whether this caller may see the payment behind `externalReference`.
 *
 * The reference is the ONLY thing the browser supplies, so this hook is where an app says
 * how a reference is tied back to a caller. It is never given the payment: a hook that
 * received the row it is guarding invites "return true if the row exists", which is the
 * IDOR this endpoint exists to make unwritable.
 */
export type ClientAuthorizeReferenceHook = (
  ctx: HttpContext,
  externalReference: string,
) => boolean | Promise<boolean>;

/**
 * Map the reference the browser polls with onto the `gateway_id` the billing store keys
 * payments by. Return `null` for "no such reference" (the endpoint answers `404`).
 *
 * Needed only when the two differ. `billing_payments` has no `external_reference` column —
 * the reference a charge carried is echoed on the gateway's webhook, not stored — so by
 * default the endpoint reads the reference AS the gateway id, which is what `charge()`
 * returned (`payment.id`) and what several Pix gateways make equal to the reference you
 * sent (Woovi's `correlationID`, Efí's `txid`).
 *
 * This is a LOOKUP, not a guard: {@link ClientAuthorizeReferenceHook} still runs on what it
 * resolves.
 */
export type ClientResolveReferenceHook = (
  ctx: HttpContext,
  reference: string,
) => string | null | Promise<string | null>;

/** Shape of `config/payments_client.ts`. */
export interface PaymentsClientConfig {
  /**
   * Master switch. Defaults to **`false`**: a payments endpoint reachable from a browser is
   * an authorization surface, and an app takes one on deliberately or not at all.
   */
  enabled?: boolean;
  /** URL prefix the endpoint mounts under. Defaults to `/payments/client`. */
  path?: string;
  /**
   * Is this request allowed at all. Defaults to "there is a resolved user" — read
   * structurally off `ctx.auth` (see {@link resolveRequestUser}). A denial is `401`.
   */
  authorize?: ClientAuthorizeHook;
  /**
   * Who is asking, as `{ type, id }`. Defaults to `{ type: 'User', id: String(user.id) }`
   * from that same resolved user. `null` is a `401`.
   */
  owner?: ClientOwnerHook;
  /**
   * May this caller see THIS payment. **The load-bearing one.**
   *
   * Defaults to the customer-registry check: resolve the owner, look them up with
   * `findCustomerByOwner`, and allow only when the payment's `customerId` is the gateway
   * customer that owner actually holds. An app that never recorded customers is DENIED with
   * a message saying so — never allowed by default.
   */
  authorizeReference?: ClientAuthorizeReferenceHook;
  /** See {@link ClientResolveReferenceHook}. Defaults to the identity mapping. */
  resolveReference?: ClientResolveReferenceHook;
}

/** Why a reference was refused. Developer-facing — it never reaches the browser. */
export interface ReferenceDenied {
  allowed: false;
  reason: string;
}

export type ReferenceOutcome = { allowed: true } | ReferenceDenied;

/** Everything the ownership guard is allowed to see. */
export interface ReferenceGuardRequest {
  ctx: HttpContext;
  /** The reference as the browser sent it (before {@link ClientResolveReferenceHook}). */
  reference: string;
  /** The already-loaded payment, normalized. */
  payment: ClientPayment;
  /** The already-resolved caller. Never `null` — a request with no owner never gets here. */
  owner: PaymentOwner;
  store: BillingStore;
}

/**
 * The internal form of the ownership check. Always present on a resolved config, so there
 * is no code path through the handler that reaches a payment without running one.
 */
export type ReferenceGuard = (request: ReferenceGuardRequest) => Promise<ReferenceOutcome>;

/** A fully-resolved config — every field present (defaults applied). */
export interface ResolvedPaymentsClientConfig {
  enabled: boolean;
  path: string;
  authorize: ClientAuthorizeHook;
  owner: ClientOwnerHook;
  resolveReference: ClientResolveReferenceHook;
  /** The app's `authorizeReference`, adapted — or the built-in registry check. */
  guard: ReferenceGuard;
}

/**
 * The minimum of `ctx.auth` this package reads.
 *
 * Structural on purpose, copied from `@adonis-agora/authz`'s `authorizeByRoles`: it fits
 * `@adonis-agora/authkit-client`'s `Authenticator` (`getUser()`) and any `@adonisjs/auth`
 * guard (`.user`) without importing either, so this package depends on neither.
 */
interface AuthLike {
  getUser?: () => Promise<unknown>;
  user?: unknown;
}

/**
 * The user behind a request, or `null`.
 *
 * A throwing `getUser()` (some guards throw rather than return `null` for an anonymous
 * request) is a denial, not a `500`.
 */
export async function resolveRequestUser(ctx: unknown): Promise<unknown> {
  const auth = (ctx as { auth?: AuthLike } | null | undefined)?.auth;
  if (!auth) return null;
  try {
    return (await auth.getUser?.()) ?? auth.user ?? null;
  } catch {
    return null;
  }
}

/** The default {@link PaymentsClientConfig.authorize}: there must be a resolved user. */
export async function defaultAuthorize(ctx: HttpContext): Promise<boolean> {
  return (await resolveRequestUser(ctx)) !== null;
}

/** The default {@link PaymentsClientConfig.owner}: `{ type: 'User', id: String(user.id) }`. */
export async function defaultOwner(ctx: HttpContext): Promise<PaymentOwner | null> {
  const user = (await resolveRequestUser(ctx)) as { id?: unknown } | null;
  const id = user?.id;
  if (id === undefined || id === null || id === '') return null;
  return { type: 'User', id: String(id) };
}

/**
 * The default ownership check: the payment's gateway customer must be the one this owner
 * holds at that gateway, per `billing_customers`.
 *
 * Every branch that cannot PROVE ownership denies. In particular an app that never called
 * `ensureCustomer({ store, owner })` has an empty registry, and an empty registry means
 * "unknown", not "allowed" — the failure mode of the opposite choice is that every
 * authenticated user can read every payment by guessing a reference.
 */
export const registryReferenceGuard: ReferenceGuard = async ({ payment, owner, store }) => {
  if (!payment.customerId) {
    return {
      allowed: false,
      reason: `[payments] Payment ${payment.gatewayId} has no customer recorded, so no owner can be proven for it. Charge through a gateway customer, or supply your own \`authorizeReference\` in config/payments_client.ts.`,
    };
  }

  const mapping = (await store.findCustomerByOwner(owner.type, owner.id, payment.provider)) as {
    gatewayId?: unknown;
  } | null;
  const heldGatewayId = typeof mapping?.gatewayId === 'string' ? mapping.gatewayId : null;

  if (!heldGatewayId) {
    return {
      allowed: false,
      reason: `[payments] No billing_customers mapping for ${owner.type}:${owner.id} at "${payment.provider}", so ownership of this payment cannot be proven and the request was denied. Record the mapping with \`ensureCustomer(driver, id, input, { store, owner })\`, or supply your own \`authorizeReference\` in config/payments_client.ts.`,
    };
  }

  if (heldGatewayId !== payment.customerId) {
    return {
      allowed: false,
      reason: `[payments] ${owner.type}:${owner.id} holds customer ${heldGatewayId} at "${payment.provider}", but payment ${payment.gatewayId} belongs to ${payment.customerId}.`,
    };
  }

  return { allowed: true };
};

/**
 * Adapt an app-supplied `authorizeReference` into the internal {@link ReferenceGuard}.
 *
 * The hook only ever sees `(ctx, reference)` — the payment stays behind this adapter.
 */
function adaptAuthorizeReference(hook: ClientAuthorizeReferenceHook): ReferenceGuard {
  return async ({ ctx, reference }) => {
    if (await hook(ctx, reference)) return { allowed: true };
    return {
      allowed: false,
      reason: `[payments] authorizeReference denied reference "${reference}".`,
    };
  };
}

/** Apply defaults to a partial config, producing a fully-resolved one. */
export function resolveConfig(config: PaymentsClientConfig = {}): ResolvedPaymentsClientConfig {
  const rawPath = config.path ?? '/payments/client';
  // Normalize: a single leading slash, no trailing slash (root collapses to '').
  const trimmed = `/${rawPath.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  return {
    // Opt-in, unlike the dashboard: this one is reachable by every logged-in browser.
    enabled: config.enabled ?? false,
    path: trimmed === '/' ? '' : trimmed,
    authorize: config.authorize ?? defaultAuthorize,
    owner: config.owner ?? defaultOwner,
    resolveReference: config.resolveReference ?? ((_ctx, reference) => reference),
    guard: config.authorizeReference
      ? adaptAuthorizeReference(config.authorizeReference)
      : registryReferenceGuard,
  };
}

/** Identity helper giving `config/payments_client.ts` full type-checking. */
export function defineConfig(config: PaymentsClientConfig = {}): PaymentsClientConfig {
  return config;
}
