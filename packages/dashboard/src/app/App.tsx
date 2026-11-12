import { useCallback, useEffect, useState } from 'react';
import { readSwitcherConfig } from '../client/console-switcher';
import { CONFIG_ELEMENT_ID, isScopedView } from '../client/payments-client';
import { Activity } from './Activity';
import { ConsoleSwitcher } from './ConsoleSwitcher';
import { Customers } from './Customers';
import { Disputes } from './Disputes';
import { OrgPicker, useTenantPicker } from './OrgPicker';
import { Overview } from './Overview';
import { PaymentsList } from './PaymentsList';
import { formatRoute, parseRoute, type Route, SCREENS, screenKey } from './routes';
import { Subscriptions } from './Subscriptions';
import { Segmented } from './ui/segmented';
import { WebhookEvents } from './WebhookEvents';

/**
 * The console shell: a header and one of seven screens, chosen by the URL hash.
 *
 * The route lives in `window.location.hash` (see `routes.ts` for the grammar) rather than in
 * React state alone, so the back button works, a reload comes back to the same screen, and
 * `#/payments/pay_8f2…` can be pasted into a support ticket. Still no router library: the whole
 * console is seven panels and one dialog, and `hashchange` plus a twenty-line parser covers it
 * without a dependency or a base-path to configure — the SPA can be mounted at ANY prefix (see
 * `spa.ts`'s `BASE_PLACEHOLDER`) and the fragment does not care.
 *
 * The one thing that needs cross-screen state is the health panel: "12 events the dispatcher gave
 * up on" has to be able to land on those twelve rows, or the number is decoration. The seed
 * (`status`, `customer`) travels IN the hash, and the target screen is keyed on it so a new seed
 * remounts it — a screen already showing `paid` must not keep showing it when the operator was
 * sent to `pending`.
 */
function useHashRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  // Follow back/forward and hand-edited hashes. Our own navigations also arrive here, so the
  // hash is the single source of truth rather than something state has to be kept in step with.
  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const navigate = useCallback((next: Route) => {
    const hash = formatRoute(next);
    // Assigning an identical hash fires no `hashchange`, so the same tab pressed twice is a no-op
    // rather than a history entry.
    if (window.location.hash !== hash) window.location.hash = hash;
  }, []);

  return [route, navigate];
}

/** The console switcher config the provider put in the page (absent when this console is alone). */
const switcherConfig = readSwitcherConfig(CONFIG_ELEMENT_ID);

/** Screens that read across every organization: not offered when the view is one organization. */
const EVERY_ORGANIZATION_SCREENS = new Set<Route['screen']>(['webhooks', 'activity']);

export function App() {
  const [route, navigate] = useHashRoute();
  const key = screenKey(route);
  const picker = useTenantPicker();
  // Re-read on a switch of organization (the pick lives in the page URL, not in state).
  const [, setPickVersion] = useState(0);
  const scoped = isScopedView(picker);
  const screens = scoped
    ? SCREENS.filter((screen) => !EVERY_ORGANIZATION_SCREENS.has(screen.value))
    : SCREENS;
  const noOrganization = picker?.mode === 'none';

  useEffect(() => {
    if (scoped && EVERY_ORGANIZATION_SCREENS.has(route.screen)) navigate({ screen: 'overview' });
  }, [scoped, route.screen, navigate]);

  /** Switching tabs by hand: no seed — each screen opens on its own sensible default. */
  const openScreen = (screen: Route['screen']) => navigate({ screen });

  /**
   * Following a health check: seed the filter that isolates exactly the rows it counted.
   *
   * `status` is optional because one check has no filter to seed: the disputes screen already
   * opens on the closing windows the check counted, so there is nothing to narrow.
   */
  const focusRows = (
    screen: 'payments' | 'webhooks' | 'disputes' | 'activity' | 'subscriptions',
    status?: string,
  ) => navigate({ screen, status });

  /** "Which of these charges are this user's" — the jump the console could not make at all
   *  before, because a payment row carried the gateway's customer id and nothing else. */
  const openCustomerPayments = (customerId: string) => navigate({ screen: 'payments', customerId });

  /** Open (or close, with `null`) one payment's detail on top of the CURRENT list, seed intact. */
  const openPayment = (paymentId: string | null) =>
    navigate({ ...route, screen: 'payments', paymentId: paymentId ?? undefined });

  return (
    <div className="relative min-h-full">
      <div className="app-bg" />
      <div className="relative z-10 mx-auto max-w-6xl px-3 py-4 sm:px-4 sm:py-6">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <ConsoleSwitcher
              config={switcherConfig}
              current={{ title: 'Payments', package: '@adonis-agora/payments' }}
              brandClassName="text-lg text-zinc-100"
              brand={
                <>
                  payments <span className="text-brand">·</span> billing console
                </>
              }
            />
            <p className="mt-0.5 text-[11px] text-zinc-500">
              Reads the billing store directly. Refunds and retries are the only calls that leave
              this app.
            </p>
          </div>
          <OrgPicker onChange={() => setPickVersion((version) => version + 1)} />
        </header>

        {noOrganization ? (
          <p
            className="rounded-sm border border-line bg-panel p-4 text-sm text-zinc-400"
            data-org-empty
          >
            Choose an organization to see its data.
          </p>
        ) : (
          renderScreens()
        )}
      </div>
    </div>
  );

  function renderScreens() {
    return (
      <>
        <Segmented
          aria-label="Screen"
          className="mb-4"
          options={screens}
          value={route.screen}
          onChange={openScreen}
        />

        {route.screen === 'overview' && <Overview onNavigate={focusRows} showHealth={!scoped} />}
        {route.screen === 'payments' && (
          <PaymentsList
            key={key}
            initialStatus={route.status}
            initialCustomerId={route.customerId}
            openedGatewayId={route.paymentId ?? null}
            onOpen={openPayment}
            organizations={
              picker !== undefined && picker.mode !== 'off' && !scoped ? picker : undefined
            }
          />
        )}
        {route.screen === 'customers' && (
          <Customers key={key} onOpenPayments={openCustomerPayments} />
        )}
        {route.screen === 'subscriptions' && (
          <Subscriptions key={key} initialStatus={route.status} />
        )}
        {route.screen === 'disputes' && <Disputes key={key} initialStatus={route.status} />}
        {route.screen === 'webhooks' && <WebhookEvents key={key} initialStatus={route.status} />}
        {route.screen === 'activity' && <Activity key={key} initialAction={route.status} />}
      </>
    );
  }
}
