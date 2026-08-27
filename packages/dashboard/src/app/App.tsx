import { useState } from 'react';
import { uiBase } from '../client/payments-client';
import { Overview } from './Overview';
import { PaymentsList } from './PaymentsList';
import { WebhookEvents } from './WebhookEvents';
import { Segmented } from './ui/segmented';

type Screen = 'overview' | 'payments' | 'webhooks';

const SCREENS: ReadonlyArray<{ value: Screen; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'payments', label: 'Payments' },
  { value: 'webhooks', label: 'Webhook events' },
];

/**
 * The console shell: a header and one of three screens.
 *
 * Deliberately no router. The whole console is three read-only panels, and a router would add a
 * dependency plus a base-path problem (the SPA can be mounted at ANY prefix — see `spa.ts`'s
 * `BASE_PLACEHOLDER`) to buy back-button support for a switch between three tabs.
 */
export function App() {
  const [screen, setScreen] = useState<Screen>('overview');

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
              Reads the billing store directly. No gateway calls are made from this page.
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
          onChange={setScreen}
        />

        {screen === 'overview' && <Overview />}
        {screen === 'payments' && <PaymentsList />}
        {screen === 'webhooks' && <WebhookEvents />}
      </div>
    </div>
  );
}
