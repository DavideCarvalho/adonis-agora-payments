import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DisputeRow } from '../client/payments-client';
import { Disputes } from './Disputes';

/**
 * The disputes screen, rendered.
 *
 * Everything asserted here is a thing that is only wrong on screen: the work list has to come
 * FIRST, a window that already shut has to still be visible and say so, a dispute with no deadline
 * has to say the gateway sent none instead of showing an empty cell, and the screen must offer no
 * way to act on a dispute at all.
 */

const originalFetch = globalThis.fetch;

/** The wire shape, with the nullable fields absent by default — the interesting cases set them. */
function dispute(overrides: Partial<DisputeRow> & Pick<DisputeRow, 'id'>): DisputeRow {
  return {
    gatewayId: `dp_${overrides.id}`,
    paymentGatewayId: `pi_${overrides.id}`,
    provider: 'stripe',
    status: 'open',
    reason: 'fraudulent',
    amount: 123456,
    currency: 'BRL',
    evidenceDueBy: null,
    outcome: null,
    openedAt: '2026-08-20T12:00:00.000Z',
    closedAt: null,
    createdAt: '2026-08-20T12:00:00.000Z',
    ...overrides,
  };
}

/** Hours from now as an ISO string — the deadline cell reads the real clock. */
function inHours(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

/**
 * Answer the two dispute reads separately: the work list (`?dueWithin=`) and the log. They are the
 * same route, and a screen that showed the same rows in both panels would look right and be wrong.
 */
function stubApi(options: {
  due?: DisputeRow[];
  total?: number;
  log?: DisputeRow[];
}): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('dueWithin')
      ? {
          disputes: options.due ?? [],
          dueWithin: { hours: 72, total: options.total ?? (options.due ?? []).length },
          page: { limit: 50, offset: 0, count: (options.due ?? []).length },
          statuses: [],
        }
      : url.includes('/disputes')
        ? {
            disputes: options.log ?? [],
            page: { limit: 50, offset: 0, count: (options.log ?? []).length },
            statuses: [],
          }
        : { providers: ['stripe', 'asaas'] };
    return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response;
  }) as typeof globalThis.fetch;
}

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Disputes />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.__PAYMENTS_API__ = '/pd/api';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(window, '__PAYMENTS_API__');
});

describe('what the screen leads with', () => {
  it('puts the closing windows above the log', async () => {
    // A chargeback is lost by default when its window shuts, so "which windows close soonest" is
    // the question the screen exists to answer. Opening on the log buries tonight's deadline.
    stubApi({
      due: [dispute({ id: '1', evidenceDueBy: inHours(5) })],
      log: [dispute({ id: '2' })],
    });
    renderScreen();

    const headings = await screen.findAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual([
      'Evidence windows closing',
      'All disputes',
    ]);
  });

  it('asks the API for the work list on the same 72h horizon the cron uses', async () => {
    stubApi({});
    renderScreen();
    await screen.findAllByRole('heading', { level: 2 });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String(call[0]),
    );
    expect(calls).toContain('/pd/api/disputes?dueWithin=72&limit=50&offset=0');
  });

  it('counts the windows with the server’s unbounded total, not the page it fit', async () => {
    stubApi({ due: [dispute({ id: '1', evidenceDueBy: inHours(5) })], total: 128 });
    renderScreen();
    expect(await screen.findByText(/128 evidence windows closing/)).toBeTruthy();
  });
});

describe('a window that already shut', () => {
  it('stays on the screen and says past due', async () => {
    // The store keeps it deliberately: still open, still unanswered. Going quiet the moment it
    // expires reads as resolved.
    stubApi({ due: [dispute({ id: 'late', evidenceDueBy: inHours(-30) })] });
    renderScreen();

    expect(await screen.findByText('past due')).toBeTruthy();
    expect(screen.getByText('30 hours ago')).toBeTruthy();
    expect(screen.getByText('dp_late')).toBeTruthy();
  });

  it('shows a live window as a countdown instead', async () => {
    // 5.5 h, not 5: the countdown rounds DOWN against the real clock, so a flat 5 would tick over
    // to "in 4 hours" the moment the test spends a millisecond rendering.
    stubApi({ due: [dispute({ id: 'soon', evidenceDueBy: inHours(5.5) })] });
    renderScreen();

    expect(await screen.findByText('in 5 hours')).toBeTruthy();
    expect(screen.queryByText('past due')).toBeNull();
  });
});

describe('the rows the work list cannot show', () => {
  it('says the gateway sends no deadline rather than leaving the cell empty', async () => {
    // `evidenceDueBy: null` is "we were told nothing", not "no hurry" — and an empty cell would
    // read as a bug in the console rather than a fact about the gateway.
    stubApi({ log: [dispute({ id: 'nodate', provider: 'woovi', evidenceDueBy: null })] });
    renderScreen();

    expect(await screen.findByText('gateway sends no deadline')).toBeTruthy();
  });

  it('says a dispute with no amount has none, rather than rendering it as zero', async () => {
    // Stripe's early fraud warning carries no money at all.
    stubApi({ log: [dispute({ id: 'efw', status: 'warning', amount: null, currency: null })] });
    renderScreen();

    expect(await screen.findByText('no amount')).toBeTruthy();
    expect(screen.queryByText(/0,00/)).toBeNull();
  });

  it('marks a warning as money that has not moved', async () => {
    stubApi({ log: [dispute({ id: 'warn', status: 'warning' })] });
    renderScreen();

    expect(await screen.findByText('no money moved')).toBeTruthy();
  });

  it('does not mark an open chargeback that way — the money is already gone', async () => {
    stubApi({ log: [dispute({ id: 'cb', status: 'open' })] });
    renderScreen();

    await screen.findByText('open');
    expect(screen.queryByText('no money moved')).toBeNull();
  });
});

describe('empty states', () => {
  it('says nothing is due AND nothing is past due, so silence is not read as either', async () => {
    stubApi({ due: [], log: [dispute({ id: '1' })] });
    renderScreen();

    expect(
      await screen.findByText(
        'No evidence window closes within 3 days, and nothing is past due and unanswered.',
      ),
    ).toBeTruthy();
  });

  it('says the log is empty because nothing was charged back', async () => {
    stubApi({ due: [], log: [] });
    renderScreen();

    expect(await screen.findByText(/Nothing has been charged back/)).toBeTruthy();
  });
});

/**
 * The product decision, asserted.
 *
 * Whether a dispute is worth contesting or cheaper to refund turns on margin, customer value and
 * fraud history — a business rule that stays in the app's code. A button here invites someone to
 * press it without any of that, so the ONLY controls this screen may grow are filters and paging.
 */
describe('read-only', () => {
  const CONTROLS = new Set([
    '24h',
    '3 days',
    '7 days',
    '30 days',
    'All',
    'Warning',
    'Open',
    'Under review',
    'Lost',
    'Expired',
    'Canceled',
    'Won',
    'Previous',
    'Next',
  ]);

  it('offers filters and paging, and nothing that acts on a dispute', async () => {
    stubApi({
      due: [dispute({ id: '1', evidenceDueBy: inHours(5) })],
      log: [dispute({ id: '2', status: 'warning' })],
    });
    const { container } = renderScreen();
    await screen.findByText('dp_1');
    await screen.findByText('pi_2');

    // Every `<button>`, not `getAllByRole('button')`: the filter pills carry `role="tab"`, and a
    // role query would walk straight past an action button that did the same.
    const names = [...container.querySelectorAll('button')].map(
      (button) => button.textContent ?? '',
    );
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => !CONTROLS.has(name))).toEqual([]);
  });

  it('puts no control at all in a dispute row', async () => {
    stubApi({ due: [dispute({ id: '1', evidenceDueBy: inHours(5) })] });
    renderScreen();

    const row = (await screen.findByText('dp_1')).closest('tr');
    expect(row).not.toBeNull();
    expect((row as HTMLElement).querySelectorAll('button, a, input, select').length).toBe(0);
  });
});
