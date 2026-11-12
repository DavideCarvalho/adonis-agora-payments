import type { ResolvedPaymentsTenancy, TenantFilter } from '../agora/tenancy.js';
import { tenantOwnerTypes } from '../agora/tenancy.js';

/**
 * Which billing rows a tenant-scoped read may see, expressed over `billing_customers`.
 *
 * A customer belongs to a tenant when its `owner_type` is one of {@link tenantOwnerTypes} and its
 * `owner_id` is the tenant's id. Payments, subscriptions, usage and disputes belong to the tenant
 * of their customer. Everything else (no customer, no owner, or an owner that is not a tenant,
 * such as a `User`) is a "no tenant" row.
 */
export interface BillingOwnerScope {
  /** Owner types that denote a tenant (`['organization']`). */
  tenantOwnerTypes: readonly string[];
  /** The tenants whose rows are visible. */
  tenantIds: readonly string[];
  /** Also show rows that belong to no tenant. */
  includeNull: boolean;
}

/** The scope of a tenant filter, or `undefined` for "no filtering" (`system` / `all`). */
export function ownerScopeOfFilter(
  tenancy: ResolvedPaymentsTenancy,
  filter: TenantFilter,
): BillingOwnerScope | undefined {
  switch (filter.mode) {
    case 'system':
    case 'all':
      return undefined;
    case 'tenantless':
      return { tenantOwnerTypes: tenantOwnerTypes(tenancy), tenantIds: [], includeNull: true };
    case 'tenant':
      return {
        tenantOwnerTypes: tenantOwnerTypes(tenancy),
        tenantIds: [filter.tenant.id],
        includeNull: tenancy.nullRows === 'shared',
      };
  }
}

/** The tenant a customer's owner is, or `null` when the owner is not a tenant. */
export function tenantOfOwner(
  scope: Pick<BillingOwnerScope, 'tenantOwnerTypes'>,
  owner: { ownerType?: string | null; ownerId?: string | null } | null | undefined,
): string | null {
  if (owner === null || owner === undefined) return null;
  const type = owner.ownerType ?? null;
  const id = owner.ownerId ?? null;
  if (type === null || id === null || id === '') return null;
  return scope.tenantOwnerTypes.includes(type) ? id : null;
}

/** Whether a row whose customer is owned by `owner` is inside `scope`. */
export function ownerInScope(
  scope: BillingOwnerScope | undefined,
  owner: { ownerType?: string | null; ownerId?: string | null } | null | undefined,
): boolean {
  if (scope === undefined) return true;
  const tenant = tenantOfOwner(scope, owner);
  return tenant === null ? scope.includeNull : scope.tenantIds.includes(tenant);
}
