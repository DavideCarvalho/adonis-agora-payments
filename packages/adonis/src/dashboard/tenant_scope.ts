import type { BillingOwnerScope } from '../billing/owner_scope.js';
import type { ConsoleTenants } from './console_authorize.js';

/**
 * Which organizations (tenants) the console shows a viewer, once tenancy is on:
 *
 * - `authorized`: what `authorize` granted (`'*'` = every organization, and rows of none), a list,
 *   the viewer's own active organization (`own`), or nothing (`'none'`: a viewer with none).
 * - `selected`: the organization the viewer picked (`?tenant=`), already checked against it.
 * - `ids`: what the reads are confined to (`undefined` = no confinement).
 * - `forged`: `?tenant=` named an organization outside `authorized`; the reads are empty.
 */
export interface ConsoleTenantScope {
  authorized: ConsoleTenants | 'none';
  own?: { id: string; kind?: string | undefined; slug?: string | undefined };
  selected: string | undefined;
  ids: string[] | undefined;
  /** With `ids`: also rows of no organization (`'*'` viewers, or `nullRows: 'shared'`). */
  includeNull: boolean;
  forged: boolean;
}

/**
 * Resolve the console scope (identical rule in every Agora console):
 *
 * 1. `authorize` granted no `tenants` → the viewer's own active organization (none → nothing).
 * 2. `tenants: [...]` → those; `'*'` → every organization, plus rows of none.
 * 3. `?tenant=<id>` narrows to one of them; an id outside them reads as empty (`forged`).
 */
export function resolveConsoleTenantScope(input: {
  granted: ConsoleTenants | undefined;
  own: { id: string; kind?: string | undefined; slug?: string | undefined } | undefined;
  selected: string | undefined;
  nullRows?: 'tenantless' | 'shared';
}): ConsoleTenantScope {
  const shared = input.nullRows === 'shared';
  const authorized: ConsoleTenantScope['authorized'] =
    input.granted !== undefined ? input.granted : input.own ? [input.own.id] : 'none';
  const picked = input.selected?.trim() || undefined;
  const pick = picked === '*' ? undefined : picked;
  const base = {
    authorized,
    ...(input.granted === undefined && input.own ? { own: input.own } : {}),
  };
  if (authorized === 'none') {
    return {
      ...base,
      selected: undefined,
      ids: [],
      includeNull: false,
      forged: pick !== undefined,
    };
  }
  if (pick === undefined) {
    return authorized === '*'
      ? { ...base, selected: undefined, ids: undefined, includeNull: true, forged: false }
      : { ...base, selected: undefined, ids: [...authorized], includeNull: shared, forged: false };
  }
  if (authorized === '*' || authorized.includes(pick)) {
    return { ...base, selected: pick, ids: [pick], includeNull: shared, forged: false };
  }
  return { ...base, selected: pick, ids: [], includeNull: false, forged: true };
}

/** The store-level scope of a console scope, or `undefined` when the viewer sees everything. */
export function ownerScopeOfConsole(
  scope: ConsoleTenantScope,
  tenantOwnerTypes: readonly string[],
): BillingOwnerScope | undefined {
  if (scope.ids === undefined) return undefined;
  return { tenantOwnerTypes, tenantIds: scope.ids, includeNull: scope.includeNull };
}
