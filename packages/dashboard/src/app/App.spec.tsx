// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearConfig, injectConfig } from '../client/test-config.test-helper';
import { App } from './App';

/**
 * The shell, rendered: the URL hash picks the screen and the sidebar writes it. Sign-out is offered
 * only when the provider put one in the data block (the host's option, or authkit's).
 *
 * Every screen used to live in React state alone, so a reload always landed on the overview and
 * the back button left the console.
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
            events: { rows: [], matchedBy: 'payment-gateway-id' },
            audit: [],
            currency: 'BRL',
          }
        : url.includes('/providers')
          ? { providers: [], eventTypes: [] }
          : url.includes('/overview')
            ? { period: { from: '', to: '', preset: '30d' }, currency: 'BRL', metrics: [] }
            : {
                data: [],
                counts: { past_due: 0 },
                meta: { total: 0, perPage: 50, currentPage: 1, lastPage: 1, firstPage: 1 },
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
  injectConfig({ api: '/pd/api' });
  stubApi();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearConfig();
  window.location.hash = '';
});

describe('the hash route', () => {
  it('opens on the overview with no hash', async () => {
    renderApp();
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('opens the screen the hash names, so a reload comes back to it', async () => {
    window.location.hash = '#/subscriptions';
    renderApp();
    expect(screen.getByRole('link', { name: 'Subscriptions' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(await screen.findByRole('heading', { name: 'Subscriptions' })).toBeTruthy();
  });

  it('writes the hash when a sidebar entry is pressed', async () => {
    renderApp();
    fireEvent.click(screen.getByRole('link', { name: 'Webhook events' }));
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

describe('session control', () => {
  it('is not offered when the data block carries no sign-out', () => {
    injectConfig({ base: '/pd' });
    renderApp();
    expect(screen.queryByLabelText('Sign out')).toBeNull();
  });

  it('shows the viewer and a sign-out link the data block names', async () => {
    injectConfig({
      base: '/pd',
      viewer: { label: 'Ann Lee', role: 'admin' },
      signOut: { href: '/logout' },
    });
    renderApp();
    expect(await screen.findByText('Ann Lee')).toBeTruthy();
    expect(screen.getByLabelText('Sign out').getAttribute('href')).toBe('/logout');
  });
});

describe('the sidebar', () => {
  it('groups the screens under MONITOR, BILLING and INTEGRATIONS', () => {
    renderApp();
    const nav = screen.getByRole('navigation', { name: 'Console' });
    expect(nav.textContent).toMatch(
      /Monitor.*Overview.*Activity.*Billing.*Payments.*Subscriptions.*Customers.*Disputes.*Integrations.*Webhook events/,
    );
  });
});
