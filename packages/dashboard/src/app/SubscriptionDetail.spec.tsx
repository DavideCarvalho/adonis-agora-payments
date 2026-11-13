// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubscriptionRow } from '../client/payments-client';
import { clearConfig, injectConfig } from '../client/test-config.test-helper';
import { SubscriptionDetail } from './SubscriptionDetail';
import { Subscriptions } from './Subscriptions';

const originalFetch = globalThis.fetch;

const row: SubscriptionRow = {
  id: 'local-1',
  gatewayId: 'sub_1',
  provider: 'stripe',
  status: 'active',
  planId: 'pro',
  customerId: 'cus_1',
  trialEndsAt: null,
  endsAt: null,
  createdAt: '2026-10-01T12:00:00.000Z',
  managed: false,
  amount: 4990,
  currency: 'BRL',
  cycle: 'MONTHLY',
  currentPeriodEnd: '2026-12-01T12:00:00.000Z',
  nextChargeAt: '2026-12-01T12:00:00.000Z',
  cancelAtPeriodEnd: true,
  lastRenewalError: null,
  lastRenewalAttemptAt: null,
  renewalFailureCount: 0,
};

const detail = {
  subscription: row,
  customer: {
    id: 'c1',
    gatewayId: 'cus_1',
    provider: 'stripe',
    ownerType: 'user',
    ownerId: '42',
    email: 'ana@example.com',
    name: 'Ana',
    taxId: null,
    createdAt: null,
  },
  payments: [
    {
      id: 'p1',
      gatewayId: 'pi_1',
      provider: 'stripe',
      status: 'paid',
      amount: 4990,
      currency: 'BRL',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      externalReference: null,
      refundedAmount: 0,
      owner: null,
      paidAt: '2026-11-01T12:00:00.000Z',
      createdAt: '2026-11-01T12:00:00.000Z',
      refundable: true,
    },
  ],
  events: { rows: [], matchedBy: 'payment-gateway-id' },
  audit: [
    {
      id: 'a1',
      action: 'subscription.canceled',
      actor: 'ana@example.com',
      provider: null,
      subjectType: 'subscription',
      subjectId: 'sub_1',
      amount: null,
      currency: null,
      message: null,
      metadata: null,
      createdAt: '2026-11-02T12:00:00.000Z',
    },
  ],
  currency: 'BRL',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  injectConfig({ base: '/payments', api: '/payments/api', currency: 'BRL' });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearConfig();
  // Unmount first: the detail is a portalled sheet, and React must remove it before the body goes.
  cleanup();
  document.body.innerHTML = '';
});

describe('SubscriptionDetail', () => {
  it('shows the state, the customer, its payments and the audit rows', async () => {
    const fetchMock = vi.fn(async () => json(detail));
    globalThis.fetch = fetchMock as never;
    const openPayment = vi.fn();
    const openCustomer = vi.fn();
    render(
      wrap(
        <SubscriptionDetail
          id="local-1"
          onClose={() => {}}
          onOpenPayment={openPayment}
          onOpenCustomer={openCustomer}
        />,
      ),
    );
    expect(await screen.findByText('cancels at period end')).toBeTruthy();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/payments/api/subscriptions/local-1');
    expect(screen.getByText('ana@example.com (user · 42)')).toBeTruthy();
    expect(screen.getByText('subscription.canceled')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'pi_1' }));
    expect(openPayment).toHaveBeenCalledWith('pi_1');
    fireEvent.click(screen.getByRole('button', { name: 'Their payments' }));
    expect(openCustomer).toHaveBeenCalledWith('cus_1');
  });

  it('says so when the subscription is not found (another organization’s reads the same)', async () => {
    globalThis.fetch = vi.fn(async () =>
      json({ error: 'No subscription "sub_x" is recorded locally.' }, 404),
    ) as never;
    render(wrap(<SubscriptionDetail id="sub_x" onClose={() => {}} />));
    expect(await screen.findByText(/No subscription "sub_x" is recorded locally/)).toBeTruthy();
  });
});

describe('Subscriptions for one customer', () => {
  it('describes that customer, never the install-wide past-due total', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/subscriptions')
        ? json({
            data: [],
            meta: { total: 0, perPage: 50, currentPage: 1, lastPage: 1, firstPage: 1 },
            statuses: [],
            counts: { past_due: 7, failing_renewals: 0 },
          })
        : json({ providers: [], eventTypes: [], capabilities: {} }),
    ) as never;
    render(wrap(<Subscriptions customerId="cus_1" />));
    expect(await screen.findByText('Customer cus_1 has no subscriptions.')).toBeTruthy();
    expect(screen.getByText('Subscriptions of customer cus_1, newest first.')).toBeTruthy();
    expect(screen.queryByText(/past due — payments failing/)).toBeNull();
  });
});

describe('Subscriptions links to the detail', () => {
  it('opens a row, and narrows to one customer when asked', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/subscriptions/')
        ? json(detail)
        : json({
            data: [row],
            meta: { total: 1, perPage: 50, currentPage: 1, lastPage: 1, firstPage: 1 },
            statuses: [],
            counts: { past_due: 0, failing_renewals: 0 },
          }),
    );
    globalThis.fetch = fetchMock as never;
    const onOpen = vi.fn();
    render(wrap(<Subscriptions customerId="cus_1" openedId={null} onOpen={onOpen} />));
    fireEvent.click(await screen.findByRole('button', { name: 'sub_1' }));
    expect(onOpen).toHaveBeenCalledWith('local-1');
    const url = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((u) => u.includes('/subscriptions?')) as string;
    expect(url).toContain('filter%5BcustomerId%5D=cus_1');
    // One customer's subscriptions open on every status, not on past-due.
    expect(url).not.toContain('status=');
  });
});
