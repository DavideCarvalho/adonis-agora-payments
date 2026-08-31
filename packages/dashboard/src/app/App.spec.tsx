import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

/**
 * The shell, rendered: the URL hash picks the screen, the tabs write it, and Sign out exists only
 * where a logout route does.
 *
 * Everything asserted here was a thing the console got wrong on a real deployment. Every screen
 * used to live in React state alone, so a reload always landed on the overview and the back
 * button left the console; and the Sign out link was unconditional, so on a deployment without
 * `dashboardAuth` — which registers no `/logout` route — it was a 404 one click away.
 */

const originalFetch = globalThis.fetch;

/** Every endpoint answers empty: these tests are about the shell, not the rows. */
function stubApi(): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const detail = /\/api\/payments\/([^?]+)/.exec(url);
    const body = url.includes('/health')
      ? { healthy: true, checkedAt: new Date().toISOString(), checks: [], failures: [] }
      : detail !== null
        ? {
            payment: {
              id: '1',
              gatewayId: decodeURIComponent(detail[1] ?? ''),
              provider: 'stripe',
              status: 'paid',
              amount: 1000,
              currency: 'BRL',
              refundedAmount: null,
              externalReference: null,
              customerId: null,
              owner: null,
              paidAt: null,
              createdAt: '2026-08-20T12:00:00.000Z',
              refundable: false,
            },
            disputes: [],
            events: { rows: [], matchedBy: 'payload-substring' },
            audit: [],
            currency: 'BRL',
          }
        : url.includes('/providers')
          ? { providers: [], eventTypes: [] }
          : url.includes('/overview')
            ? { period: { from: '', to: '', preset: '30d' }, currency: 'BRL', metrics: [] }
            : {
                payments: [],
                customers: [],
                subscriptions: [],
                disputes: [],
                events: [],
                audit: [],
                counts: { past_due: 0 },
                page: { limit: 50, offset: 0, count: 0, scanned: 0, truncated: false },
              };
    return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response;
  }) as typeof globalThis.fetch;
}

function renderApp() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

function setHash(hash: string) {
  act(() => {
    window.location.hash = hash;
    // jsdom does fire `hashchange` on assignment, but asynchronously; dispatching it ourselves
    // keeps the test deterministic.
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

beforeEach(() => {
  window.__PAYMENTS_API__ = '/pd/api';
  stubApi();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(window, '__PAYMENTS_API__');
  Reflect.deleteProperty(window, '__PAYMENTS_AUTH__');
  window.location.hash = '';
});

describe('the hash route', () => {
  it('opens on the overview with no hash', async () => {
    renderApp();
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('opens the screen the hash names, so a reload comes back to it', async () => {
    window.location.hash = '#/subscriptions';
    renderApp();
    expect(screen.getByRole('tab', { name: 'Subscriptions' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(await screen.findByRole('heading', { name: 'Subscriptions' })).toBeTruthy();
  });

  it('writes the hash when a tab is pressed', async () => {
    renderApp();
    fireEvent.click(screen.getByRole('tab', { name: 'Webhook events' }));
    expect(window.location.hash).toBe('#/webhooks');
  });

  it('follows the hash when it changes underneath — the back button', async () => {
    renderApp();
    setHash('#/customers');
    expect(await screen.findByRole('heading', { name: 'Customers' })).toBeTruthy();
    setHash('#/activity');
    expect(await screen.findByRole('heading', { name: 'Activity' })).toBeTruthy();
  });

  it('opens a payment detail straight from `#/payments/<id>`', async () => {
    window.location.hash = '#/payments/pay_8f2';
    renderApp();
    const dialog = await screen.findByRole('dialog', { name: 'Payment detail' });
    expect(dialog.textContent).toContain('pay_8f2');
  });

  it('closes the detail by dropping the id from the hash, keeping the screen', async () => {
    window.location.hash = '#/payments/pay_8f2?status=paid';
    renderApp();
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(window.location.hash).toBe('#/payments?status=paid');
  });
});

describe('Sign out', () => {
  it('is absent when the deployment has no dashboardAuth — there is no /logout to point at', () => {
    window.__PAYMENTS_AUTH__ = null;
    renderApp();
    expect(screen.queryByRole('link', { name: 'Sign out' })).toBeNull();
  });

  it('is absent when the provider predates the global, erring towards no broken link', () => {
    renderApp();
    expect(screen.queryByRole('link', { name: 'Sign out' })).toBeNull();
  });

  it('is offered when a session mode is configured', () => {
    window.__PAYMENTS_AUTH__ = { modes: ['login'] };
    window.__PAYMENTS_BASE__ = '/pd';
    renderApp();
    expect(screen.getByRole('link', { name: 'Sign out' }).getAttribute('href')).toBe('/pd/logout');
    Reflect.deleteProperty(window, '__PAYMENTS_BASE__');
  });
});
