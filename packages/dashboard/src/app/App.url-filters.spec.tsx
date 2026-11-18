// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearConfig, injectConfig } from '../client/test-config.test-helper';
import { App } from './App';
import { readStatus, writeStatus } from './url-state';

const originalFetch = globalThis.fetch;
let urls: string[] = [];

/**
 * Lists answer three pages (cursor pages when asked by cursor: `c1` → page 2, `c2` → page 3);
 * a payment's detail answers one payment.
 */
function stubApi(): void {
  urls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = decodeURIComponent(String(input));
    urls.push(url);
    const detail = /\/api\/payments\/([^?]+)/.exec(url);
    const page = Number(/page\]?=(\d+)/.exec(url)?.[1] ?? '1');
    const after = /[?&]after=c(\d+)/.exec(url)?.[1];
    const cursorPage = Number(after ?? '0') + 1;
    const body = url.includes('/health')
      ? { healthy: true, checkedAt: new Date().toISOString(), checks: [], failures: [] }
      : detail !== null
        ? {
            payment: {
              id: '1',
              gatewayId: detail[1],
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
          ? { providers: ['stripe', 'asaas'], eventTypes: ['payment.paid', 'payment.refunded'] }
          : url.includes('/overview')
            ? { period: { from: '', to: '', preset: '30d' }, currency: 'BRL', metrics: [] }
            : url.includes('first=')
              ? {
                  data: [],
                  counts: { past_due: 0 },
                  meta: {
                    nextCursor: cursorPage < 3 ? `c${cursorPage}` : null,
                    prevCursor: null,
                    hasNext: cursorPage < 3,
                    hasPrev: cursorPage > 1,
                  },
                }
              : {
                  data: [],
                  counts: { past_due: 0 },
                  meta: { total: 150, perPage: 50, currentPage: page, lastPage: 3, firstPage: 1 },
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

/** The last list request to `path` the screen made. */
const lastList = (path: string) => urls.filter((u) => u.includes(`/api${path}?`)).at(-1) ?? '';

const tab = (list: string, name: string) =>
  [...screen.getByRole('tablist', { name: list }).querySelectorAll('[role="tab"]')].find((t) =>
    t.textContent?.startsWith(name),
  );

beforeEach(() => {
  injectConfig({ api: '/pd/api' });
  stubApi();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearConfig();
});

describe('payments: filters in the URL', () => {
  it('opens filtered from a shared link', async () => {
    window.history.replaceState(null, '', '/pd#/payments?status=failed&provider=asaas&after=c1');
    renderApp();
    await waitFor(() => expect(lastList('/payments')).toContain('failed'));
    expect(lastList('/payments')).toContain('asaas');
    expect(lastList('/payments')).toContain('after=c1');
    expect(lastList('/payments')).not.toMatch(/page/);
    expect(tab('Payment status', 'Failed')?.getAttribute('aria-selected')).toBe('true');
  });

  it('a status pick pushes and goes back to the first page; back undoes it', async () => {
    window.history.replaceState(null, '', '/pd?tenant=acme#/payments?after=c1');
    renderApp();
    await waitFor(() => expect(lastList('/payments')).toContain('after=c1'));
    fireEvent.click(tab('Payment status', 'Failed') as HTMLElement);
    await waitFor(() => expect(window.location.hash).toBe('#/payments?status=failed'));
    expect(window.location.search).toBe('?tenant=acme');
    await waitFor(() => expect(lastList('/payments')).toContain('failed'));

    act(() => window.history.back());
    await waitFor(() => expect(window.location.hash).toBe('#/payments?after=c1'));
    await waitFor(() =>
      expect(tab('Payment status', 'All')?.getAttribute('aria-selected')).toBe('true'),
    );
  });

  it('next pushes the cursor, previous pops it', async () => {
    window.history.replaceState(null, '', '/pd#/payments');
    renderApp();
    await waitFor(() => expect(lastList('/payments')).toContain('first=50'));
    fireEvent.click(await screen.findByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(window.location.hash).toBe('#/payments?after=c1'));
    await waitFor(() => expect(lastList('/payments')).toContain('after=c1'));
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(window.location.hash).toBe('#/payments?after=c1,c2'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', true),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => expect(window.location.hash).toBe('#/payments?after=c1'));
  });

  it('the lookup is in the URL once submitted', async () => {
    window.history.replaceState(null, '', '/pd#/payments');
    renderApp();
    const box = await screen.findByLabelText('Reference or gateway id');
    fireEvent.change(box, { target: { value: 'order-4102' } });
    fireEvent.submit(box.closest('form') as HTMLFormElement);
    await waitFor(() => expect(window.location.hash).toBe('#/payments?find=order-4102'));
    await waitFor(() => expect(lastList('/payments')).toContain('order-4102'));
  });

  it('opening and closing a payment keeps the filters', async () => {
    window.history.replaceState(
      null,
      '',
      '/pd#/payments/pay_8f2?status=paid&provider=asaas&after=c1',
    );
    renderApp();
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(window.location.hash).toBe('#/payments?status=paid&provider=asaas&after=c1'),
    );
  });
});

describe('webhook events: a screen whose default is one status', () => {
  it('opens on failed; every status is `?status=all`, and failed again leaves the URL', async () => {
    window.history.replaceState(null, '', '/pd#/webhooks');
    renderApp();
    await waitFor(() => expect(lastList('/webhook-events')).toContain('failed'));
    fireEvent.click(tab('Event status', 'All') as HTMLElement);
    await waitFor(() => expect(window.location.hash).toBe('#/webhooks?status=all'));
    await waitFor(() => expect(lastList('/webhook-events')).not.toContain('failed'));
    fireEvent.click(tab('Event status', 'Failed') as HTMLElement);
    await waitFor(() => expect(window.location.hash).toBe('#/webhooks'));
  });
});

describe('webhook events: the event type filter', () => {
  it('autocompletes the types the ledger has seen and writes the pick to the URL', async () => {
    window.history.replaceState(null, '', '/pd#/webhooks');
    renderApp();
    const input = await screen.findByRole('combobox', { name: 'Event type' });
    await act(async () => {
      input.focus();
      // Base UI opens the popup on ArrowDown, not on input events.
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.change(input, { target: { value: 'refund' } });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByRole('option', { name: 'payment.paid' })).toBeNull();
    const option = await screen.findByRole('option', { name: 'payment.refunded' });
    await act(async () => {
      fireEvent.click(option);
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(window.location.hash).toBe('#/webhooks?type=payment.refunded'));
    await waitFor(() => expect(lastList('/webhook-events')).toContain('payment.refunded'));
  });

  it('shows the type from a shared link', async () => {
    window.history.replaceState(null, '', '/pd#/webhooks?type=payment.paid');
    renderApp();
    const input = (await screen.findByRole('combobox', {
      name: 'Event type',
    })) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('payment.paid'));
    await waitFor(() => expect(lastList('/webhook-events')).toContain('payment.paid'));
  });
});

describe('readStatus / writeStatus', () => {
  it('round-trips a pick against the screen default', () => {
    expect(readStatus(null, 'failed')).toBe('failed');
    expect(readStatus('all', 'failed')).toBeUndefined();
    expect(readStatus('paid', undefined)).toBe('paid');
    expect(writeStatus(undefined, 'failed')).toBe('all');
    expect(writeStatus('failed', 'failed')).toBeNull();
    expect(writeStatus(undefined, undefined)).toBeNull();
  });
});
