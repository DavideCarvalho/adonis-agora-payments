// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NuqsHashAdapter } from '../agora-kit/url-state/nuqs-hash-adapter';
import type {
  CustomerRow,
  DisputeRow,
  PaymentRow,
  SubscriptionRow,
} from '../client/payments-client';
import { clearConfig, injectConfig } from '../client/test-config.test-helper';
import { Customers } from './Customers';
import { Disputes } from './Disputes';
import { formatWhen } from './money';
import { PaymentDetail } from './PaymentDetail';
import { SubscriptionDetail } from './SubscriptionDetail';
import { Subscriptions } from './Subscriptions';

/** Every entity list shows when a row was created (or last updated); every detail shows both. */

const originalFetch = globalThis.fetch;
const CREATED = '2026-10-01T12:00:00.000Z';
const UPDATED = '2026-11-02T08:30:00.000Z';

const meta = { total: 1, perPage: 50, currentPage: 1, lastPage: 1, firstPage: 1 };

const customer: CustomerRow = {
  id: 'c1',
  gatewayId: 'cus_1',
  provider: 'stripe',
  ownerType: 'user',
  ownerId: '42',
  email: 'ana@example.com',
  name: 'Ana',
  taxId: null,
  createdAt: CREATED,
  updatedAt: UPDATED,
};

const subscription: SubscriptionRow = {
  id: 'local-1',
  gatewayId: 'sub_1',
  provider: 'stripe',
  status: 'active',
  planId: 'pro',
  customerId: 'cus_1',
  trialEndsAt: null,
  endsAt: null,
  createdAt: CREATED,
  updatedAt: UPDATED,
  managed: false,
  amount: 4990,
  currency: 'BRL',
  cycle: 'MONTHLY',
  currentPeriodEnd: null,
  nextChargeAt: null,
  cancelAtPeriodEnd: false,
  lastRenewalError: null,
  lastRenewalAttemptAt: null,
  renewalFailureCount: 0,
};

const payment: PaymentRow = {
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
  paidAt: UPDATED,
  createdAt: CREATED,
  updatedAt: UPDATED,
  refundable: true,
};

const dispute: DisputeRow = {
  id: 'd1',
  gatewayId: 'dp_1',
  paymentGatewayId: 'pi_1',
  provider: 'stripe',
  status: 'lost',
  reason: 'fraudulent',
  amount: 4990,
  currency: 'BRL',
  evidenceDueBy: null,
  outcome: 'lost',
  openedAt: CREATED,
  closedAt: UPDATED,
  createdAt: CREATED,
  updatedAt: UPDATED,
};

function stub(route: (url: string) => unknown) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const body = route(String(input));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as never;
}

function wrap(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return (
    <NuqsHashAdapter>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </NuqsHashAdapter>
  );
}

/** The `<dd>` right after the `<dt>` with this label. */
function field(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: 'dt' });
  return term.nextElementSibling as HTMLElement;
}

beforeEach(() => {
  injectConfig({ base: '/payments', api: '/payments/api', currency: 'BRL' });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearConfig();
  cleanup();
  document.body.innerHTML = '';
});

describe('detail views show Created and Updated', () => {
  it('payment detail', async () => {
    stub(() => ({
      payment,
      disputes: [],
      events: { rows: [], matchedBy: 'payment-gateway-id' },
      audit: [],
      currency: 'BRL',
    }));
    render(wrap(<PaymentDetail gatewayId="pi_1" onClose={() => {}} />));
    await screen.findByText('Created', { selector: 'dt' });
    expect(field('Created').textContent).toBe(formatWhen(CREATED));
    expect(field('Created').getAttribute('title')).toBe(CREATED);
    expect(field('Updated').textContent).toBe(formatWhen(UPDATED));
  });

  it('subscription detail, with — for a row older than the column', async () => {
    stub(() => ({
      subscription: { ...subscription, updatedAt: null },
      customer: null,
      payments: [],
      events: { rows: [], matchedBy: 'payment-gateway-id' },
      audit: [],
      currency: 'BRL',
    }));
    render(wrap(<SubscriptionDetail id="local-1" onClose={() => {}} />));
    await screen.findByText('Created', { selector: 'dt' });
    expect(field('Created').textContent).toBe(formatWhen(CREATED));
    expect(field('Updated').textContent).toBe('—');
  });
});

describe('lists show a Created (or Updated) column', () => {
  it('customers: Created, the full instant on hover', async () => {
    stub((url) =>
      url.includes('/customers')
        ? { data: [customer], meta }
        : { providers: [], eventTypes: [], capabilities: {} },
    );
    render(wrap(<Customers />));
    expect(await screen.findByRole('columnheader', { name: 'Created' })).toBeTruthy();
    const cell = await screen.findByTitle(CREATED);
    expect(cell.textContent).toBe(formatWhen(CREATED));
  });

  it('subscriptions: Created', async () => {
    stub((url) =>
      url.includes('/subscriptions')
        ? { data: [subscription], meta, statuses: [], counts: { past_due: 0, failing_renewals: 0 } }
        : { providers: [], eventTypes: [], capabilities: {} },
    );
    render(wrap(<Subscriptions />));
    expect(await screen.findByRole('columnheader', { name: 'Created' })).toBeTruthy();
    expect((await screen.findByTitle(CREATED)).textContent).toBe(formatWhen(CREATED));
  });

  it('disputes log: Updated', async () => {
    stub((url) =>
      url.includes('dueWithin')
        ? { data: [], dueWithin: { hours: 72 }, meta: { ...meta, total: 0 }, statuses: [] }
        : url.includes('/disputes')
          ? { data: [dispute], meta, statuses: [] }
          : { providers: ['stripe'] },
    );
    render(wrap(<Disputes />));
    await screen.findByRole('columnheader', { name: 'Updated' });
    expect((await screen.findByTitle(UPDATED)).textContent).toBe(formatWhen(UPDATED));
  });
});
