// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppsPicker } from '../client/payments-client';
import { clearConfig, injectConfig } from '../client/test-config.test-helper';
import { App } from './App';

/**
 * The federated console in the SPA: the App picker (this app + the federated apps), `?app=` on
 * every call, the federated badge and notice, a read-only app's actions disabled, and an
 * idempotency key on every action.
 */

const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; init?: RequestInit | undefined }> = [];

const APPS: AppsPicker = {
  local: { label: 'Hub' },
  topology: 'standalone',
  tenants: [],
  apps: [
    { id: 'et', label: 'Entre Textos', mode: 'federated', actions: 'app' },
    { id: 'el', label: 'EduLiberta', mode: 'federated', actions: 'none' },
  ],
  selected: null,
};

const PAYMENT = {
  id: '1',
  gatewayId: 'pay_a',
  provider: 'stripe',
  status: 'paid',
  amount: 1000,
  currency: 'BRL',
  refundedAmount: null,
  externalReference: null,
  customerId: 'cus_a',
  subscriptionId: null,
  owner: null,
  paidAt: null,
  createdAt: '2026-11-01T12:00:00.000Z',
  refundable: true,
};

function stubApi(apps: AppsPicker): void {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const json = (body: unknown) =>
      ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as Response;
    if (url.endsWith('/apps')) return json(apps);
    if (url.includes('/tenants')) {
      return json({ mode: 'off', all: false, selected: null, ownerTypes: [], tenants: [] });
    }
    if (url.includes('/refund')) {
      return json({
        refund: { gatewayId: 're_1', amount: 1000, currency: 'BRL', status: 'pending' },
        payment: { gatewayId: 'pay_a', provider: 'stripe', amount: 1000, currency: 'BRL' },
        audit: null,
        note: '',
      });
    }
    if (url.includes('/health')) {
      return json({ healthy: true, checkedAt: new Date().toISOString(), checks: [], failures: [] });
    }
    if (url.includes('/providers'))
      return json({ providers: [], eventTypes: [], capabilities: {} });
    if (url.includes('/overview')) {
      return json({ period: { from: '', to: '', preset: '30d' }, currency: 'BRL', metrics: [] });
    }
    return json({
      data: [PAYMENT],
      meta: { total: 1, perPage: 50, currentPage: 1, lastPage: 1, firstPage: 1 },
    });
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

beforeEach(() => {
  injectConfig({ api: '/pd/api' });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearConfig();
  window.history.replaceState(null, '', '/');
  window.location.hash = '';
});

describe('federated console', () => {
  it('no federated apps: no App picker', async () => {
    stubApi({ ...APPS, apps: [] });
    renderApp();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/apps'))).toBe(true));
    expect(screen.queryByRole('button', { name: /^App/ })).toBeNull();
  });

  it('lists this app then the federated apps, and a pick goes on every call', async () => {
    stubApi(APPS);
    window.location.hash = '#/payments';
    renderApp();
    const button = await screen.findByRole('button', { name: /^App/ });
    expect(button.getAttribute('aria-label')).toBe('App: Hub');
    fireEvent.click(button);
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'Hubthis app',
      'Entre Textosfederated',
      'EduLibertafederated',
    ]);
    fireEvent.mouseDown(options[1] as HTMLElement);
    await waitFor(() => expect(window.location.search).toBe('?app=et'));
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/payments') && c.url.includes('app=et'))).toBe(true),
    );
    expect(document.querySelector('[data-app-mode="federated"]')).not.toBeNull();
    expect(document.querySelector('[data-federated-notice]')?.textContent).toContain(
      'Actions are sent to Entre Textos',
    );
  });

  it('a refund on a federated app carries ?app= and an idempotency key', async () => {
    window.history.replaceState(null, '', '/?app=et#/payments');
    stubApi(APPS);
    renderApp();
    const refund = await screen.findByRole('button', { name: 'Refund' });
    await waitFor(() => expect(refund.hasAttribute('disabled')).toBe(false));
    fireEvent.click(refund);
    const confirm = await screen.findAllByRole('button', { name: /Refund/ });
    fireEvent.click(confirm[confirm.length - 1] as HTMLElement);
    const sent = await waitFor(() => {
      const call = calls.find((c) => c.url.includes('/refund'));
      expect(call).toBeDefined();
      return call!;
    });
    expect(sent.url).toContain('app=et');
    const headers = sent.init?.headers as Record<string, string>;
    expect(headers['idempotency-key']).toMatch(/^console-[A-Za-z0-9-]{8,}$/);
  });

  it('a read-only federated app disables the actions', async () => {
    window.history.replaceState(null, '', '/?app=el#/payments');
    stubApi(APPS);
    renderApp();
    const refund = await screen.findByRole('button', { name: 'Refund' });
    await waitFor(() => expect(refund.hasAttribute('disabled')).toBe(true));
    expect(refund.getAttribute('title')).toContain('read-only');
    expect(document.querySelector('[data-federated-notice]')?.textContent).toContain(
      'Read-only here',
    );
  });
});
