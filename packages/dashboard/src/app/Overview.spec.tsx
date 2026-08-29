import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OverviewMetric } from '../client/payments-client';
import { Overview } from './Overview';

/**
 * The two money tiles, rendered.
 *
 * `billingOverview` publishes revenue TWICE — `revenue` is gross, `net_revenue` subtracts what
 * was refunded — and everything asserted here is only wrong on screen. A tile labelled just
 * "Revenue" over the gross figure is the original bug in one word: a charge that was half
 * refunded shows at its full value and nothing says so. A net tile rendered as a plain COUNT is
 * the same money off by 100×, because `formatCents` is the only thing in this console that
 * shifts a decimal point and the metric list carries no unit of its own.
 */

const originalFetch = globalThis.fetch;

function metric(key: string, label: string, value: number): OverviewMetric {
  return { key, label, value };
}

/**
 * A R$100 charge with R$10 refunded, as the server would report it: gross 10000, net 9000.
 * Health answers empty — this screen renders it above the money and would otherwise hang.
 */
function stubApi(metrics: OverviewMetric[]): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/health')
      ? { healthy: true, checkedAt: new Date().toISOString(), checks: [], failures: [] }
      : {
          period: {
            from: '2026-07-30T00:00:00.000Z',
            to: '2026-08-29T00:00:00.000Z',
            preset: '30d',
          },
          currency: 'BRL',
          metrics,
        };
    return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response;
  }) as typeof globalThis.fetch;
}

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Overview onNavigate={() => {}} />
    </QueryClientProvider>,
  );
}

const REVENUE_METRICS = [
  metric('revenue', 'Revenue, gross (cents)', 10_000),
  metric('net_revenue', 'Revenue, net of refunds (cents)', 9_000),
  metric('active_subscriptions', 'Active subscriptions', 2),
];

beforeEach(() => {
  window.__PAYMENTS_API__ = '/pd/api';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(window, '__PAYMENTS_API__');
});

describe('the revenue tiles', () => {
  it('shows gross and net as two tiles, each saying which one it is', async () => {
    stubApi(REVENUE_METRICS);
    renderScreen();

    expect(await screen.findByText(/Revenue \(gross\)/i)).toBeTruthy();
    expect(await screen.findByText(/Revenue \(net\)/i)).toBeTruthy();
  });

  it('formats BOTH as money, never as a bare count', async () => {
    // 9000 rendered as "9,000" instead of "R$ 90,00" is the refunded money off by 100× — and it
    // is what happens the moment a new money metric is added without being declared as money.
    stubApi(REVENUE_METRICS);
    renderScreen();

    const gross = await screen.findByText(/R\$\s*100[.,]00/);
    const net = await screen.findByText(/R\$\s*90[.,]00/);
    expect(gross).toBeTruthy();
    expect(net).toBeTruthy();
  });

  it('says in words that gross excludes refunds and net subtracts them', async () => {
    // The label alone is a word; the sentence under it is what stops somebody reading the
    // bigger number as "what we made".
    stubApi(REVENUE_METRICS);
    renderScreen();

    expect(await screen.findByText(/Refunds NOT subtracted/i)).toBeTruthy();
    expect(await screen.findByText(/minus what was refunded/i)).toBeTruthy();
  });

  it('falls back to the server label for a metric it has no copy for', async () => {
    // The metric list is open-ended and the server owns it. An unknown key must still render
    // its own label rather than nothing at all.
    stubApi([metric('refunds_issued', 'Refunds issued', 4)]);
    renderScreen();

    expect(await screen.findByText('Refunds issued')).toBeTruthy();
  });
});
