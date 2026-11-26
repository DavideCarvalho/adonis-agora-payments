import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { AppModeBadge, actionsUnavailableReason } from '../agora-kit/blocks/app-mode';
import { ScopeMenu } from '../agora-kit/blocks/scope-menu';
import {
  type AppsPicker,
  type FederatedAppInfo,
  paymentsClient,
  selectedApp,
  viewerMayRun,
} from '../client/payments-client';

/** The picker's id for this console's own app (never a valid federated key: `~` is refused). */
const LOCAL = '~local';

/** Put the picked app in the page URL (`?app=`, absent = this app), keeping the hash. */
function writeAppToUrl(app: string | undefined): void {
  const url = new URL(window.location.href);
  if (app === undefined) url.searchParams.delete('app');
  else url.searchParams.set('app', app);
  // Another app's organizations are not this console's: the organization pick does not carry.
  url.searchParams.delete('tenant');
  window.history.pushState(null, '', url.toString());
  window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
}

/** `?app=` as the page URL has it now, following a pick and back/forward. */
export function usePageApp(): string | undefined {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener('popstate', onChange);
      return () => window.removeEventListener('popstate', onChange);
    },
    selectedApp,
    () => undefined,
  );
}

/** The App picker's data (`GET /api/apps`). */
export function useAppsPicker(): AppsPicker | undefined {
  const { data } = useQuery({
    queryKey: ['apps'],
    queryFn: () => paymentsClient.apps(),
    staleTime: 60_000,
    refetchInterval: false,
  });
  return data;
}

/** The federated app picked in the URL, when the server lists it. */
export function useFederatedApp(): FederatedAppInfo | undefined {
  const picker = useAppsPicker();
  const app = usePageApp();
  if (app === undefined) return undefined;
  return picker?.apps.find((a) => a.id === app);
}

/**
 * Why the console's action `action` is off: the viewer's access does not include it (this
 * console's `authorize`), or the picked app is read-only here. `undefined` when it can run.
 */
export function useActionsBlocked(action?: string): string | undefined {
  const federated = useFederatedApp();
  if (action !== undefined && !viewerMayRun(action)) {
    return 'Your access to this console does not include this action.';
  }
  if (!federated) return undefined;
  return actionsUnavailableReason(federated.label, federated);
}

const TEXT = {
  noun: 'App',
  all: 'This app',
  some: 'This app',
  search: 'Search apps',
  empty: 'No apps.',
};

/**
 * The topbar's "App" control of a federated console: this app first, then the other apps of
 * `apps` this viewer may see, each tagged `federated`. Nothing without federated apps. A pick
 * goes to the page URL (`?app=`, a history entry); the console re-reads whenever it moves.
 */
export function AppPicker() {
  const picker = useAppsPicker();
  const current = usePageApp();
  if (!picker || picker.apps.length === 0) return null;
  const federated = picker.apps.find((a) => a.id === current);
  const labelOf = (id: string) =>
    id === LOCAL ? picker.local.label : (picker.apps.find((a) => a.id === id)?.label ?? id);
  return (
    <>
      <ScopeMenu
        items={[
          { id: LOCAL, label: picker.local.label, hint: 'this app' },
          ...picker.apps.map((app) => ({
            id: app.id,
            label: app.label,
            ...(app.mode === 'federated' ? { hint: 'federated' } : {}),
          })),
        ]}
        all={false}
        current={federated ? federated.id : LOCAL}
        text={{ ...TEXT, some: picker.local.label }}
        labelOf={labelOf}
        onChoose={(next) => writeAppToUrl(next === undefined || next === LOCAL ? undefined : next)}
      />
      {federated ? (
        <AppModeBadge
          appLabel={federated.label}
          mode={federated.mode}
          actions={federated.actions}
        />
      ) : null}
    </>
  );
}
