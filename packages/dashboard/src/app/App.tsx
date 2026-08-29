import { useState } from 'react';
import { uiBase } from '../client/payments-client';
import { Activity } from './Activity';
import { Customers } from './Customers';
import { Disputes } from './Disputes';
import { Overview } from './Overview';
import { PaymentsList } from './PaymentsList';
import { Subscriptions } from './Subscriptions';
import { WebhookEvents } from './WebhookEvents';
import { Segmented } from './ui/segmented';

type Screen =
  | 'overview'
  | 'payments'
  | 'customers'
  | 'subscriptions'
  | 'disputes'
  | 'webhooks'
  | 'activity';

const SCREENS: ReadonlyArray<{ value: Screen; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'payments', label: 'Payments' },
  { value: 'customers', label: 'Customers' },
  { value: 'subscriptions', label: 'Subscriptions' },
  { value: 'disputes', label: 'Disputes' },
  { value: 'webhooks', label: 'Webhook events' },
  { value: 'activity', label: 'Activity' },
];

/**
 * The console shell: a header and one of seven screens.
 *
 * Deliberately no router. The whole console is seven panels, and a router would add a dependency
 * plus a base-path problem (the SPA can be mounted at ANY prefix — see `spa.ts`'s
 * `BASE_PLACEHOLDER`) to buy back-button support for a switch between a handful of tabs.
 *
 * The one thing that needs cross-screen state is the health panel: "12 events the dispatcher gave
 * up on" has to be able to land on those twelve rows, or the number is decoration. `focus` carries
 * the status filter across, and bumping `visit` remounts the target screen so the seeded filter
 * actually takes — a screen already showing `paid` must not keep showing it when the operator was
 * sent to `pending`.
 */
export function App() {
  const [screen, setScreen] = useState<Screen>('overview');
  const [focus, setFocus] = useState<string | undefined>(undefined);
  /** The gateway customer id a "Payments" jump from the customers screen carries across. */
  const [customerFocus, setCustomerFocus] = useState<string | undefined>(undefined);
  const [visit, setVisit] = useState(0);

  /** Switching tabs by hand: no seeded filter — each screen opens on its own sensible default. */
  const openScreen = (next: Screen) => {
    setScreen(next);
    setFocus(undefined);
    setCustomerFocus(undefined);
    setVisit((n) => n + 1);
  };

  /**
   * Following a health check: seed the filter that isolates exactly the rows it counted.
   *
   * `status` is optional because one check has no filter to seed: the disputes screen already
   * opens on the closing windows the check counted, so there is nothing to narrow.
   */
  const focusRows = (next: 'payments' | 'webhooks' | 'disputes' | 'activity', status?: string) => {
    setScreen(next);
    setFocus(status);
    setCustomerFocus(undefined);
    setVisit((n) => n + 1);
  };

  /** "Which of these charges are this user's" — the jump the console could not make at all
   *  before, because a payment row carried the gateway's customer id and nothing else. */
  const openCustomerPayments = (customerId: string) => {
    setScreen('payments');
    setFocus(undefined);
    setCustomerFocus(customerId);
    setVisit((n) => n + 1);
  };

  return (
    <div className="relative min-h-full">
      <div className="app-bg" />
      <div className="relative z-10 mx-auto max-w-6xl px-4 py-6">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg text-zinc-100">
              payments <span className="text-brand">·</span> billing console
            </h1>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              Reads the billing store directly. Refunds and retries are the only calls that leave
              this app.
            </p>
          </div>
          <a
            href={`${uiBase()}/logout`}
            className="rounded border border-line px-2 py-1 text-xs text-zinc-400 hover:bg-panel-2 hover:text-zinc-200"
          >
            Sign out
          </a>
        </header>

        <Segmented
          aria-label="Screen"
          className="mb-4"
          options={SCREENS}
          value={screen}
          onChange={openScreen}
        />

        {screen === 'overview' && <Overview onNavigate={focusRows} />}
        {screen === 'payments' && (
          <PaymentsList
            key={`payments-${visit}`}
            initialStatus={focus}
            initialCustomerId={customerFocus}
          />
        )}
        {screen === 'customers' && (
          <Customers key={`customers-${visit}`} onOpenPayments={openCustomerPayments} />
        )}
        {screen === 'subscriptions' && (
          <Subscriptions key={`subscriptions-${visit}`} initialStatus={focus} />
        )}
        {screen === 'disputes' && <Disputes key={`disputes-${visit}`} initialStatus={focus} />}
        {screen === 'webhooks' && <WebhookEvents key={`webhooks-${visit}`} initialStatus={focus} />}
        {screen === 'activity' && <Activity key={`activity-${visit}`} initialAction={focus} />}
      </div>
    </div>
  );
}
