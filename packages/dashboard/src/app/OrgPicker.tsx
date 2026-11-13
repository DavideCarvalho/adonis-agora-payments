import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ChevronDownIcon } from '../agora-kit/icons';
import { Popover, PopoverContent, PopoverTrigger } from '../agora-kit/ui/popover';
import { paymentsClient, selectedTenant, type TenantPicker } from '../client/payments-client';
import { BuildingIcon } from './icons';
import { CONTROL_CLASS } from './ui/field';

/** Put the picked organization in the page URL (`?tenant=`, absent = all), keeping the hash. */
function writeTenantToUrl(tenant: string | undefined): void {
  const url = new URL(window.location.href);
  if (tenant === undefined) url.searchParams.delete('tenant');
  else url.searchParams.set('tenant', tenant);
  window.history.pushState(null, '', url.toString());
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

const CHIP =
  'flex h-[30px] items-center gap-1.5 rounded-md border border-border bg-panel-2 px-2.5 text-[11.5px] text-fg-2 [&_svg]:size-3.5 [&_svg]:text-faint';

/**
 * The topbar's "Organization" control (tenancy on): a fixed chip for one organization, a searchable
 * list for several ("All organizations" first when the viewer may see every one). Nothing when
 * tenancy is off.
 */
export function OrgPicker({ onChange }: { onChange?: () => void }) {
  const picker = useTenantPicker();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [current, setCurrent] = useState(selectedTenant());

  if (!picker || picker.mode === 'off') return null;

  if (picker.mode === 'none') {
    return (
      <span className={CHIP} data-org-picker="none">
        <BuildingIcon />
        <span className="hidden text-faint sm:inline">Organization</span> none
      </span>
    );
  }
  if (picker.mode === 'fixed') {
    return (
      <span className={CHIP} data-org-picker="fixed">
        <BuildingIcon />
        <span className="hidden text-faint sm:inline">Organization</span>
        <span className="max-w-40 truncate">
          {picker.tenants[0]?.label ?? picker.tenants[0]?.id}
        </span>
      </span>
    );
  }

  const choose = async (tenant: string | undefined) => {
    setOpen(false);
    setSearch('');
    await paymentsClient.selectTenant(tenant ?? '*').catch(() => undefined);
    writeTenantToUrl(tenant);
    setCurrent(tenant);
    onChange?.();
    await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'tenants' });
  };
  const needle = search.trim().toLowerCase();
  const shown = picker.tenants.filter(
    (t) =>
      needle === '' ||
      t.label.toLowerCase().includes(needle) ||
      t.id.toLowerCase().includes(needle),
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={`${CHIP} transition-colors hover:border-line-strong hover:text-fg`}
        aria-label="Organization"
        data-org-picker="pick"
      >
        <BuildingIcon />
        <span className="max-w-40 truncate">{tenantLabel(picker, current)}</span>
        <ChevronDownIcon />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 max-w-[calc(100vw-2rem)] gap-1 p-1">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search organizations…"
          aria-label="search organizations"
          className={`mb-1 h-7 w-full ${CONTROL_CLASS}`}
        />
        <div role="listbox" aria-label="Organizations" className="max-h-72 overflow-y-auto">
          {picker.all && (
            <button
              type="button"
              role="option"
              aria-selected={current === undefined}
              onClick={() => void choose(undefined)}
              className={OPTION}
            >
              All organizations
            </button>
          )}
          {shown.map((t) => (
            <button
              key={t.id}
              type="button"
              role="option"
              aria-selected={current === t.id}
              onClick={() => void choose(t.id)}
              className={`flex flex-col ${OPTION}`}
            >
              <span className="truncate">{t.label}</span>
              {t.label !== t.id && (
                <span className="mono truncate text-[10px] text-faint">{t.id}</span>
              )}
            </button>
          ))}
          {shown.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-dim">No organization matches.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const OPTION =
  'w-full rounded-md px-2 py-1.5 text-left text-xs text-fg hover:bg-hover aria-selected:bg-brand-soft';
