/**
 * Structural reader for the tenancy contract `@adonis-agora/context` publishes on its global slot
 * (`Symbol.for('@agora/context:tenancy')`, version 1). This package never imports context: with
 * the slot missing, too old, or throwing, tenancy reads as OFF and payments behaves exactly as it
 * does without tenancy.
 *
 * The tenant here is the customer a piece of data belongs to (an organization, a clinic…), never a
 * process topology.
 */

const TENANCY = Symbol.for('@agora/context:tenancy');
const ACCESSOR = Symbol.for('@agora/context:accessor');

/** One level of a tenant chain (outermost first). */
export interface TenantLevel {
  id: string;
  kind: string;
  slug?: string;
  role?: string;
}

/** The active tenant, as context publishes it. */
export interface TenantRef extends TenantLevel {
  source: string;
  chain?: TenantLevel[];
  family?: string;
}

/** How a read or write must be scoped right now (the rule every Agora lib applies). */
export type TenantFilter =
  | { mode: 'system' }
  | { mode: 'all' }
  | { mode: 'tenantless' }
  | { mode: 'tenant'; tenant: TenantRef; chain?: TenantLevel[] };

/** What a tenant id resolves to in `billing_customers`: an owner type and id. */
export interface TenantOwner {
  type: string;
  id: string;
}

/** The `tenancy` option of `config/payments.ts`. */
export type PaymentsTenancyOption =
  | 'inherit'
  | false
  | {
      /** `'inherit'` (default) follows `tenancy.enabled` in `config/context.ts`. */
      enabled?: 'inherit' | boolean;
      /** Tenant kinds payments honours; another kind reads as no tenant. Default: context's. */
      kinds?: string[];
      /** Only consider tenants of this family (a request can carry several). */
      family?: string;
      /**
       * Customers owned by no tenant: `'tenantless'` (default) shows them only to requests without
       * a tenant; `'shared'` also shows them inside every tenant.
       */
      nullRows?: 'tenantless' | 'shared';
      /** A missing tenant is an error (`E_TENANT_REQUIRED`) instead of the no-tenant pool. */
      required?: boolean;
      /**
       * The `billing_customers.owner_type` a tenant's customer is recorded under. Default: the
       * tenant's kind (`'organization'`).
       */
      ownerType?: string | ((tenant: TenantRef) => string);
      /**
       * Which owner types ARE tenants, and of which kind (`{ Organization: 'organization' }`).
       * Used to run webhook handlers inside the customer's tenant and to scope the console.
       * Default: derived from `ownerType` (a string maps to the first of `kinds`, else
       * `'organization'`); otherwise every kind in `kinds` maps to itself.
       */
      ownerKinds?: Record<string, string>;
    };

/** {@link PaymentsTenancyOption} resolved against context. */
export interface ResolvedPaymentsTenancy {
  enabled: boolean;
  kinds?: string[];
  family?: string;
  nullRows: 'tenantless' | 'shared';
  required: boolean;
  ownerType(tenant: TenantRef): string;
  /** Owner type → tenant kind. */
  ownerKinds: Record<string, string>;
}

interface TenancySlot {
  version?: number;
  tenancy?: () => { enabled?: boolean; kinds?: string[]; required?: boolean } | undefined;
  tenantFilter?: (options?: {
    kinds?: string[];
    family?: string;
    required?: boolean;
  }) => TenantFilter;
  withTenant?: <T>(input: Record<string, unknown> | null, fn: () => T) => T;
  allTenants?: <T>(fn: () => T) => T;
  tenantLabels?: (ids: string[], kind?: string) => Promise<Record<string, string>>;
}

interface AccessorSlot {
  userRef?: () => { type?: string; id?: string | number } | undefined;
}

function slot<T>(key: symbol): T | undefined {
  const value = (globalThis as Record<symbol, unknown>)[key];
  return value !== null && typeof value === 'object' ? (value as T) : undefined;
}

/** Context's tenancy slot, when a context that publishes version 1 is installed. */
export function tenancySlot(): TenancySlot | undefined {
  const tenancy = slot<TenancySlot>(TENANCY);
  return tenancy?.version === 1 && typeof tenancy.tenantFilter === 'function' ? tenancy : undefined;
}

const OFF: ResolvedPaymentsTenancy = Object.freeze({
  enabled: false,
  nullRows: 'tenantless' as const,
  required: false,
  ownerType: (tenant: TenantRef) => tenant.kind,
  ownerKinds: Object.freeze({}) as Record<string, string>,
});

/**
 * Resolve the `tenancy` option. Off with `false`, without context, or when context leaves it off
 * (`'inherit'`, the default).
 */
export function resolvePaymentsTenancy(
  option: PaymentsTenancyOption | undefined,
): ResolvedPaymentsTenancy {
  if (option === false) return OFF;
  const reader = tenancySlot();
  if (reader === undefined) return OFF;
  const own = typeof option === 'object' && option !== null ? option : {};
  let context: { enabled?: boolean; kinds?: string[]; required?: boolean } | undefined;
  try {
    context = reader.tenancy?.();
  } catch {
    context = undefined;
  }
  const enabled =
    own.enabled === undefined || own.enabled === 'inherit'
      ? context?.enabled === true
      : own.enabled === true;
  if (!enabled) return OFF;
  const kinds = own.kinds ?? context?.kinds;
  const ownerTypeOption = own.ownerType;
  const ownerType =
    typeof ownerTypeOption === 'function'
      ? ownerTypeOption
      : typeof ownerTypeOption === 'string'
        ? () => ownerTypeOption
        : (tenant: TenantRef) => tenant.kind;
  const ownerKinds: Record<string, string> = own.ownerKinds
    ? { ...own.ownerKinds }
    : typeof ownerTypeOption === 'string'
      ? { [ownerTypeOption]: kinds?.[0] ?? 'organization' }
      : Object.fromEntries((kinds ?? ['organization']).map((kind) => [kind, kind]));
  return {
    enabled: true,
    ...(kinds !== undefined ? { kinds: [...kinds] } : {}),
    ...(own.family !== undefined ? { family: own.family } : {}),
    nullRows: own.nullRows ?? 'tenantless',
    required: own.required ?? context?.required === true,
    ownerType,
    ownerKinds,
  };
}

/**
 * How the current request (or job) must be scoped. Tenancy off → `system` (nothing filtered). A
 * tenant of a kind payments does not honour reads as `tenantless`; with `required` that throws
 * context's `E_TENANT_REQUIRED`.
 */
export function currentTenantFilter(tenancy: ResolvedPaymentsTenancy): TenantFilter {
  if (!tenancy.enabled) return { mode: 'system' };
  const reader = tenancySlot();
  const filter = reader?.tenantFilter?.({
    ...(tenancy.kinds !== undefined ? { kinds: tenancy.kinds } : {}),
    ...(tenancy.family !== undefined ? { family: tenancy.family } : {}),
    required: tenancy.required,
  });
  if (filter === undefined || filter === null || typeof filter !== 'object') {
    return { mode: 'system' };
  }
  if (filter.mode === 'tenant' && tenancy.kinds !== undefined) {
    if (!tenancy.kinds.includes(filter.tenant.kind)) return { mode: 'tenantless' };
  }
  return filter;
}

/** The billing owner of a tenant (`{ type: ownerType(tenant), id: tenant.id }`). */
export function tenantOwner(tenancy: ResolvedPaymentsTenancy, tenant: TenantRef): TenantOwner {
  return { type: tenancy.ownerType(tenant), id: tenant.id };
}

/**
 * The owner the current tenant bills as, or `null` outside a tenant. Throws context's
 * `E_TENANT_REQUIRED` when tenancy is `required` and there is none.
 */
export function currentTenantOwner(tenancy: ResolvedPaymentsTenancy): TenantOwner | null {
  const filter = currentTenantFilter(tenancy);
  return filter.mode === 'tenant' ? tenantOwner(tenancy, filter.tenant) : null;
}

/** The owner types that denote a tenant (keys of `ownerKinds`). */
export function tenantOwnerTypes(tenancy: ResolvedPaymentsTenancy): string[] {
  return Object.keys(tenancy.ownerKinds);
}

/**
 * Run `fn` inside the tenant a billing owner is, when the owner IS a tenant (its type is in
 * `ownerKinds`) and tenancy is on. Otherwise `fn` runs as it is.
 */
export function runInOwnerTenant<T>(
  tenancy: ResolvedPaymentsTenancy,
  owner: { type: string | null; id: string | null } | null,
  fn: () => T,
): T {
  if (!tenancy.enabled || owner === null || owner.type === null || owner.id === null) return fn();
  const kind = tenancy.ownerKinds[owner.type];
  const reader = tenancySlot();
  if (kind === undefined || typeof reader?.withTenant !== 'function') return fn();
  return reader.withTenant({ id: owner.id, kind, source: 'app' }, fn);
}

/** Run `fn` across every tenant (context's `allTenants`), or as is without context. */
export function acrossTenants<T>(fn: () => T): T {
  const reader = tenancySlot();
  return typeof reader?.allTenants === 'function' ? reader.allTenants(fn) : fn();
}

/** Display labels for tenant ids, from context's label resolver; ids map to themselves otherwise. */
export async function tenantLabels(ids: string[], kind?: string): Promise<Record<string, string>> {
  const labels: Record<string, string> = Object.fromEntries(ids.map((id) => [id, id]));
  const reader = tenancySlot();
  if (typeof reader?.tenantLabels !== 'function' || ids.length === 0) return labels;
  try {
    const resolved = await reader.tenantLabels(ids, kind);
    for (const id of ids) {
      const label = resolved?.[id];
      if (typeof label === 'string' && label !== '') labels[id] = label;
    }
  } catch {
    // labels are display only
  }
  return labels;
}

/** The signed-in user's id as context knows it (`userRef`), when there is one. */
export function contextUserId(): string | undefined {
  const accessor = slot<AccessorSlot>(ACCESSOR);
  try {
    const ref = accessor?.userRef?.();
    const id = ref?.id;
    return id === undefined || id === null || id === '' ? undefined : String(id);
  } catch {
    return undefined;
  }
}
