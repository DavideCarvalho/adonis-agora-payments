import {
  contextUserId,
  currentTenantFilter,
  type ResolvedPaymentsTenancy,
  type TenantOwner,
  tenantOwner,
} from './agora/tenancy.js';
import type { BillingStore, CustomerListItem } from './billing/billing_store.js';

/** Options for `payments.currentOwner()` / `payments.currentCustomer()`. */
export interface CurrentCustomerOptions {
  /**
   * The request, when you have it: its signed-in user (`ctx.auth.user.id`) is the fallback owner
   * outside an organization. Without it the user comes from `@adonis-agora/context`'s `userRef`.
   */
  ctx?: unknown;
  /** Only this gateway's customer. Default: the default provider first, then the others. */
  provider?: string;
}

/** The signed-in user's id from `ctx.auth.user`, read structurally. */
function requestUserId(ctx: unknown): string | undefined {
  try {
    const user = (ctx as { auth?: { user?: { id?: unknown } | null } } | null | undefined)?.auth
      ?.user;
    const id = user?.id;
    if (typeof id === 'string' && id !== '') return id;
    if (typeof id === 'number' || typeof id === 'bigint') return String(id);
  } catch {
    // an auth getter that throws means "nobody"
  }
  return undefined;
}

/**
 * Who is paying right now: the active organization (tenant) when there is one, else the signed-in
 * user (`{ type: userOwnerType, id }`), else `null`.
 *
 * With tenancy `required`, a request with no organization throws `E_TENANT_REQUIRED` instead of
 * falling back to the user.
 */
export function resolveCurrentOwner(input: {
  tenancy: ResolvedPaymentsTenancy;
  userOwnerType: string;
  ctx?: unknown;
}): TenantOwner | null {
  const filter = currentTenantFilter(input.tenancy);
  if (filter.mode === 'tenant') return tenantOwner(input.tenancy, filter.tenant);
  const userId = requestUserId(input.ctx) ?? contextUserId();
  return userId === undefined ? null : { type: input.userOwnerType, id: userId };
}

/** The customer `owner` holds, at `provider` or at the first of `providers` that has one. */
export async function findOwnedCustomer(
  store: Pick<BillingStore, 'listCustomers'>,
  owner: TenantOwner,
  providers: readonly string[],
): Promise<CustomerListItem | null> {
  for (const provider of providers) {
    const [row] = await store.listCustomers({
      ownerType: owner.type,
      ownerId: owner.id,
      provider,
      size: 1,
    });
    if (row !== undefined) return row;
  }
  return null;
}
