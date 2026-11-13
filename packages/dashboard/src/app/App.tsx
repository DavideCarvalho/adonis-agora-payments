import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { ErrorBoundary } from '../agora-kit/blocks/error-boundary';
import { UsersIcon } from '../agora-kit/icons';
import { AppShell, type NavSection, PageBody } from '../agora-kit/shell/app-shell';
import { readShellConfig } from '../agora-kit/shell-config';
import { CONFIG_ELEMENT_ID, isScopedView } from '../client/payments-client';
import { Activity } from './Activity';
import { Customers } from './Customers';
import { Disputes } from './Disputes';
import {
  BuildingIcon,
  CardIcon,
  GaugeIcon,
  LogIcon,
  PaymentsMark,
  PlugIcon,
  RepeatIcon,
  ShieldIcon,
} from './icons';
import { OrgPicker, useTenantPicker } from './OrgPicker';
import { Overview } from './Overview';
import { PaymentsList } from './PaymentsList';
import { formatRoute, parseRoute, type Route, SCREENS, type Screen, screenKey } from './routes';
import { Subscriptions } from './Subscriptions';
import { WebhookEvents } from './WebhookEvents';

/**
 * The console: the Agora shell (kit) around seven screens — MONITOR (Overview, Activity), BILLING
 * (Payments, Subscriptions, Customers, Disputes), INTEGRATIONS (Webhook events) — chosen by the
 * URL hash. Every screen renders inside its own error boundary.
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

/** Payments' accent (cyan): passed to the kit's ThemeProvider in `main.tsx`. Cyan-teal sits far from
 *  `--agora-good` green so a MONEY figure never reads as a health signal, and — unlike a green or
 *  gold accent — it does not quietly imply "paid" next to a FAILED row. */
export const PAYMENTS_ACCENT = '#22d3ee';

/** Screens that read across every organization: not offered when the view is one organization. */
const EVERY_ORGANIZATION_SCREENS = new Set<Route['screen']>(['webhooks', 'activity']);

const TITLES: Record<Screen, string> = Object.fromEntries(
  SCREENS.map((screen) => [screen.value, screen.label]),
) as Record<Screen, string>;

/** Sidebar sections (CONSOLE-SHELL-SPEC): MONITOR · BILLING · INTEGRATIONS. */
const NAV: ReadonlyArray<{ section: string; items: ReadonlyArray<[Screen, ReactNode]> }> = [
  {
    section: 'Monitor',
    items: [
      ['overview', <GaugeIcon key="i" />],
      ['activity', <LogIcon key="i" />],
    ],
  },
  {
    section: 'Billing',
    items: [
      ['payments', <CardIcon key="i" />],
      ['subscriptions', <RepeatIcon key="i" />],
      ['customers', <UsersIcon key="i" />],
      ['disputes', <ShieldIcon key="i" />],
    ],
  },
  { section: 'Integrations', items: [['webhooks', <PlugIcon key="i" />]] },
];

export function App() {
  // What the provider put in the page: switcher, ⌘K search, viewer, sign-out (all optional).
  const shell = useMemo(() => readShellConfig(CONFIG_ELEMENT_ID), []);
  const [route, navigate] = useHashRoute();
  const key = screenKey(route);
  const picker = useTenantPicker();
  // Re-read on a switch of organization (the pick lives in the page URL, not in state).
  const [, setPickVersion] = useState(0);
  const scoped = isScopedView(picker);
  const noOrganization = picker?.mode === 'none';

  useEffect(() => {
    if (scoped && EVERY_ORGANIZATION_SCREENS.has(route.screen)) navigate({ screen: 'overview' });
  }, [scoped, route.screen, navigate]);

  const nav = useMemo<NavSection[]>(
    () =>
      NAV.map(({ section, items }) => ({
        section,
        items: items
          .filter(([screen]) => !(scoped && EVERY_ORGANIZATION_SCREENS.has(screen)))
          .map(([screen, icon]) => ({
            id: screen,
            label: TITLES[screen],
            icon,
            href: formatRoute({ screen }),
            // Switching screens by hand: no seed — each screen opens on its own default.
            onSelect: () => navigate({ screen }),
          })),
      })),
    [scoped, navigate],
  );

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
  /** Every subscription of one gateway customer. */
  const openCustomerSubscriptions = (customerId: string) =>
    navigate({ screen: 'subscriptions', customerId });

  /** Open (or close, with `null`) one subscription's detail on top of the CURRENT list. */
  const openSubscription = (subscriptionId: string | null) =>
    navigate({ ...route, screen: 'subscriptions', subscriptionId: subscriptionId ?? undefined });

  /** A payment named in a subscription's detail: the payments screen with its detail open. */
  const openPaymentDetail = (paymentId: string) => navigate({ screen: 'payments', paymentId });

  /** Open (or close, with `null`) one payment's detail on top of the CURRENT list, seed intact. */
  const openPayment = (paymentId: string | null) =>
    navigate({ ...route, screen: 'payments', paymentId: paymentId ?? undefined });

  return (
    <AppShell
      brand={{
        name: 'payments',
        subtitle: 'billing console',
        mark: <PaymentsMark />,
        current: { title: 'Payments', package: '@adonis-agora/payments', icon: 'payments' },
      }}
      nav={nav}
      activeId={route.screen}
      shell={shell}
      title={TITLES[route.screen]}
      searchPlaceholder="Search payments, subscriptions, customers…"
      actions={<OrgPicker onChange={() => setPickVersion((version) => version + 1)} />}
    >
      <ErrorBoundary label={TITLES[route.screen]} resetKeys={[key]}>
        {noOrganization ? (
          <PageBody>
            <EmptyState
              icon={<BuildingIcon />}
              title="No organization selected"
              description={<span data-org-empty>Choose an organization to see its data.</span>}
              className="agora-surface rounded-lg border border-border"
            />
          </PageBody>
        ) : (
          renderScreen()
        )}
      </ErrorBoundary>
    </AppShell>
  );

  function renderScreen() {
    switch (route.screen) {
      case 'overview':
        return <Overview onNavigate={focusRows} showHealth={!scoped} />;
      case 'payments':
        return (
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
        );
      case 'customers':
        return (
          <Customers
            key={key}
            onOpenPayments={openCustomerPayments}
            onOpenSubscriptions={openCustomerSubscriptions}
          />
        );
      case 'subscriptions':
        return (
          <Subscriptions
            key={key}
            initialStatus={route.status}
            customerId={route.customerId}
            openedId={route.subscriptionId ?? null}
            onOpen={openSubscription}
            onOpenPayment={openPaymentDetail}
            onOpenCustomer={openCustomerPayments}
          />
        );
      case 'disputes':
        return <Disputes key={key} initialStatus={route.status} />;
      case 'webhooks':
        return <WebhookEvents key={key} initialStatus={route.status} />;
      case 'activity':
        return <Activity key={key} initialAction={route.status} />;
    }
  }
}
