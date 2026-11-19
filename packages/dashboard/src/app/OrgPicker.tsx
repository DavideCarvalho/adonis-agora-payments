import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { ScopeChip, ScopeMenu } from '../agora-kit/blocks/scope-menu';
import { paymentsClient, selectedTenant, type TenantPicker } from '../client/payments-client';

/** Put the picked organization in the page URL (`?tenant=`, absent = all), keeping the hash. */
function writeTenantToUrl(tenant: string | undefined): void {
  const url = new URL(window.location.href);
  if (tenant === undefined) url.searchParams.delete('tenant');
  else url.searchParams.set('tenant', tenant);
  window.history.pushState(null, '', url.toString());
  // A pushState fires nothing: say the URL moved (usePageTenant follows it).
  window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
}

/**
 * `?tenant=` as the page URL has it now, following a pick and back/forward (`popstate`), so the
 * picker and the data it scopes never disagree.
 */
export function usePageTenant(): string | undefined {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener('popstate', onChange);
      return () => window.removeEventListener('popstate', onChange);
    },
    selectedTenant,
    () => undefined,
  );
}

/** The label of an organization id (or "All organizations"). */
export function tenantLabel(picker: TenantPicker | undefined, id: string | undefined): string {
  if (id === undefined) return 'All organizations';
  return picker?.tenants.find((t) => t.id === id)?.label ?? id;
}

/** The organization picker's data, shared by the header control and the lists' column. */
export function useTenantPicker(): TenantPicker | undefined {
  const { data } = useQuery({
    queryKey: ['tenants'],
    queryFn: () => paymentsClient.tenants(),
    staleTime: 60_000,
    refetchInterval: false,
  });
  return data;
}

const TEXT = {
  noun: 'Organization',
  all: 'All organizations',
  some: 'Every organization you can see',
  search: 'Search organizations',
  empty: 'No organizations.',
};

/**
 * The topbar's "Organization" control (tenancy on), the kit's header picker as in every console:
 * a fixed chip for one organization (or none), a searchable list for several ("All
 * organizations" first when the viewer may see every one). Nothing when tenancy is off. A pick
 * goes to the page URL (`?tenant=`, a history entry); the console re-reads whenever it moves.
 */
export function OrgPicker() {
  const picker = useTenantPicker();
  const current = usePageTenant();

  if (!picker || picker.mode === 'off') return null;

  if (picker.mode === 'none' || picker.mode === 'fixed') {
    const only = picker.mode === 'fixed' ? picker.tenants[0] : undefined;
    return <ScopeChip noun={TEXT.noun} label={only ? only.label : 'none'} kind="tenant" />;
  }

  return (
    <ScopeMenu
      items={picker.tenants}
      all={picker.all}
      current={current}
      text={TEXT}
      labelOf={(id) => tenantLabel(picker, id)}
      onChoose={(tenant) => {
        // Recorded server-side (audit); the URL is what every request reads.
        void paymentsClient.selectTenant(tenant ?? '*').catch(() => undefined);
        writeTenantToUrl(tenant);
      }}
    />
  );
}
