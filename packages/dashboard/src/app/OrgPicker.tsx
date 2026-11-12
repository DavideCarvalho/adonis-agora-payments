import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { paymentsClient, selectedTenant, type TenantPicker } from '../client/payments-client';

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
  'mono flex items-center gap-1.5 rounded-sm border border-line bg-panel px-2 py-1 text-[11px] text-zinc-300';

/**
 * The header's "Organization" control (tenancy on): a fixed chip for one organization, a searchable
 * list for several ("All organizations" first when the viewer may see every one). Nothing when
 * tenancy is off.
 */
export function OrgPicker({ onChange }: { onChange?: () => void }) {
  const picker = useTenantPicker();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [current, setCurrent] = useState(selectedTenant());
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!picker || picker.mode === 'off') return null;

  if (picker.mode === 'none') {
    return (
      <span className={CHIP} data-org-picker="none">
        <span className="text-zinc-500">Organization</span> none
      </span>
    );
  }
  if (picker.mode === 'fixed') {
    return (
      <span className={CHIP} data-org-picker="fixed">
        <span className="text-zinc-500">Organization</span>
        {picker.tenants[0]?.label ?? picker.tenants[0]?.id}
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
    <div className="relative" ref={root} data-org-picker="pick">
      <button
        type="button"
        className={`${CHIP} hover:border-zinc-600`}
        aria-label="Organization"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="text-zinc-500">Organization</span>
        {tenantLabel(picker, current)}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-sm border border-line bg-panel p-1 shadow-lg">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="search organizations…"
            aria-label="search organizations"
            className="mb-1 w-full rounded-sm border border-line bg-transparent px-2 py-1 text-xs text-zinc-200 outline-none"
          />
          <div role="listbox" aria-label="Organizations" className="max-h-72 overflow-y-auto">
            {picker.all && (
              <button
                type="button"
                role="option"
                aria-selected={current === undefined}
                onClick={() => void choose(undefined)}
                className="w-full rounded-sm px-2 py-1.5 text-left text-xs text-zinc-200 hover:bg-panel-2"
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
                className="flex w-full flex-col rounded-sm px-2 py-1.5 text-left text-xs text-zinc-200 hover:bg-panel-2"
              >
                <span className="truncate">{t.label}</span>
                {t.label !== t.id && (
                  <span className="mono truncate text-[10px] text-zinc-500">{t.id}</span>
                )}
              </button>
            ))}
            {shown.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-zinc-500">No organization matches.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
