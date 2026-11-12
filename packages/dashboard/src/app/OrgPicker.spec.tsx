import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantPicker } from '../client/payments-client';
import { clearConfig, injectConfig } from '../client/test-config.test-helper';
import { App } from './App';

/**
 * The "Organization" control (tenancy): what each picker mode shows, that the pick travels on
 * every API call, and that views over every organization disappear inside one.
 */

const originalFetch = globalThis.fetch;
let calls: string[] = [];

function stubApi(picker: TenantPicker | null): void {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/tenants') && !url.includes('/select')) {
      if (picker === null) {
        return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => picker } as Response;
    }
    const body = url.includes('/health')
      ? { healthy: true, checkedAt: new Date().toISOString(), checks: [], failures: [] }
      : url.includes('/providers')
        ? { providers: [], eventTypes: [], capabilities: {} }
        : url.includes('/overview')
          ? { period: { from: '', to: '', preset: '30d' }, currency: 'BRL', metrics: [] }
          : {
              payments: [
                {
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
                  owner: { type: 'organization', id: 'a', name: null, email: null },
                  paidAt: null,
                  createdAt: '2026-11-01T12:00:00.000Z',
                  refundable: false,
                },
              ],
              meta: { page: 1, size: 50, count: 1, scanned: 1, truncated: false },
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

const PICK: TenantPicker = {
  mode: 'pick',
  all: true,
  selected: null,
  ownerTypes: ['organization'],
  tenants: [
    { id: 'a', label: 'Acme' },
    { id: 'b', label: 'Globex' },
  ],
};

beforeEach(() => {
  injectConfig({ api: '/pd/api' });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearConfig();
  window.history.replaceState(null, '', '/');
  window.location.hash = '';
});

describe('organization picker', () => {
  it('renders nothing with tenancy off', async () => {
    stubApi(null);
    renderApp();
    await waitFor(() => expect(calls.some((c) => c.endsWith('/tenants'))).toBe(true));
    expect(document.querySelector('[data-org-picker]')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Webhook events' })).toBeTruthy();
  });

  it('a viewer with no organization is asked to choose one', async () => {
    stubApi({ ...PICK, mode: 'none', all: false, tenants: [] });
    renderApp();
    expect(await screen.findByText('Choose an organization to see its data.')).toBeTruthy();
  });

  it('one organization is a fixed chip, and the views over every one are hidden', async () => {
    stubApi({ ...PICK, mode: 'fixed', all: false, tenants: [{ id: 'a', label: 'Acme' }] });
    renderApp();
    const chip = await waitFor(() => {
      const element = document.querySelector('[data-org-picker="fixed"]');
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    expect(chip.textContent).toContain('Acme');
    expect(screen.queryByRole('tab', { name: 'Webhook events' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Activity' })).toBeNull();
  });

  it('every organization: "All organizations" first, a pick goes on every call', async () => {
    stubApi(PICK);
    window.location.hash = '#/payments';
    renderApp();
    // All organizations: the payments list gains an Organization column.
    const cell = await waitFor(() => {
      const element = document.querySelector('[data-column="organization"]');
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    expect(cell.textContent).toBe('Acme');

    fireEvent.click(screen.getByRole('button', { name: 'Organization' }));
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['All organizations', 'Acmea', 'Globexb']);
    fireEvent.click(options[2] as HTMLElement);
    await waitFor(() => expect(window.location.search).toBe('?tenant=b'));
    await waitFor(() =>
      expect(calls.some((c) => c.includes('/payments?') && c.includes('tenant=b'))).toBe(true),
    );
    expect(calls.some((c) => c.includes('/tenants/b/select'))).toBe(true);
  });
});
