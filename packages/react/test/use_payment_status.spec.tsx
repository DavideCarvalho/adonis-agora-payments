import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePaymentStatus } from '../src/use_payment_status.js';

/**
 * The polling loop, against a fake `fetch` and fake timers.
 *
 * Everything asserted here is something a hand-written loop in a checkout page routinely
 * gets wrong: no backoff, no stop condition, no cleanup on unmount, and a `401` retried
 * until the tab is closed.
 */
describe('usePaymentStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** jsdom's `visibilityState` is a getter; override it and fire the event browsers fire. */
  function setVisibility(value: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
  }
  function emitVisibilityChange(): void {
    document.dispatchEvent(new Event('visibilitychange'));
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  /** A fetch that answers `pending` until `settleAfter` calls, then `paid`. */
  function fakeFetch(responses: Array<() => Response>) {
    const calls: string[] = [];
    const impl = vi.fn(async (input: string | URL | Request) => {
      calls.push(input.toString());
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      return next!();
    });
    return { impl: impl as unknown as typeof fetch, calls, spy: impl };
  }

  const pending = () => json({ status: 'pending', amount: 1000, currency: 'BRL', paidAt: null });
  const paid = () =>
    json({ status: 'paid', amount: 1000, currency: 'BRL', paidAt: '2026-08-27T12:00:00.000Z' });

  async function flush(ms = 0) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('reads once immediately, then backs off 2s, 3s, 4.5s', async () => {
    const fetchImpl = fakeFetch([pending]);
    renderHook(() => usePaymentStatus('pay_1', { fetchImpl: fetchImpl.impl }));

    await flush();
    expect(fetchImpl.spy).toHaveBeenCalledTimes(1);
    expect(fetchImpl.calls[0]).toBe('/payments/client/status?reference=pay_1');

    // The gap grows. A fixed 1s interval is what a hand-written loop does, and it is what
    // turns one abandoned checkout tab into 86 400 requests a day.
    await flush(1999);
    expect(fetchImpl.spy).toHaveBeenCalledTimes(1);
    await flush(1);
    expect(fetchImpl.spy).toHaveBeenCalledTimes(2);

    await flush(2999);
    expect(fetchImpl.spy).toHaveBeenCalledTimes(2);
    await flush(1);
    expect(fetchImpl.spy).toHaveBeenCalledTimes(3);

    await flush(4499);
    expect(fetchImpl.spy).toHaveBeenCalledTimes(3);
    await flush(1);
    expect(fetchImpl.spy).toHaveBeenCalledTimes(4);
  });

  it('caps the interval', async () => {
    const fetchImpl = fakeFetch([pending]);
    renderHook(() =>
      usePaymentStatus('pay_1', {
        fetchImpl: fetchImpl.impl,
        initialDelayMs: 1000,
        maxDelayMs: 2000,
        backoffFactor: 4,
      }),
    );

    await flush();
    await flush(1000);
    expect(fetchImpl.spy).toHaveBeenCalledTimes(2);
    // 1000 * 4 would be 4000; the cap holds it at 2000, and every gap after it too.
    await flush(2000);
    expect(fetchImpl.spy).toHaveBeenCalledTimes(3);
    await flush(2000);
    expect(fetchImpl.spy).toHaveBeenCalledTimes(4);
  });

  it('stops on a terminal status and reports the settled payment', async () => {
    const fetchImpl = fakeFetch([pending, paid]);
    const onSettled = vi.fn();
    const { result } = renderHook(() =>
      usePaymentStatus('pay_1', { fetchImpl: fetchImpl.impl, onSettled }),
    );

    await flush();
    expect(result.current.status).toBe('pending');
    expect(result.current.isSettled).toBe(false);
    expect(result.current.isPolling).toBe(true);

    await flush(2000);
    expect(result.current.status).toBe('paid');
    expect(result.current.isSettled).toBe(true);
    expect(result.current.isPolling).toBe(false);
    expect(result.current.amount).toBe(1000);
    expect(result.current.currency).toBe('BRL');
    expect(result.current.paidAt).toBe('2026-08-27T12:00:00.000Z');
    expect(onSettled).toHaveBeenCalledTimes(1);

    // Settled is settled. A Pix that will never be paid must not poll all night, and one
    // that was paid must not keep asking either.
    await flush(60_000);
    expect(fetchImpl.spy).toHaveBeenCalledTimes(2);
  });

  it('stops on every terminal status, not just paid', async () => {
    for (const status of ['failed', 'refunded', 'canceled', 'disputed'] as const) {
      const fetchImpl = fakeFetch([() => json({ status, amount: 1, currency: 'BRL', paidAt: null })]);
      const { result, unmount } = renderHook(() =>
        usePaymentStatus('pay_1', { fetchImpl: fetchImpl.impl }),
      );
      await flush();
      expect(result.current.isSettled, status).toBe(true);
      await flush(60_000);
      expect(fetchImpl.spy, status).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('stops on unmount', async () => {
    const fetchImpl = fakeFetch([pending]);
    const { unmount } = renderHook(() => usePaymentStatus('pay_1', { fetchImpl: fetchImpl.impl }));

    await flush();
    expect(fetchImpl.spy).toHaveBeenCalledTimes(1);

    unmount();
    await flush(120_000);
    expect(fetchImpl.spy).toHaveBeenCalledTimes(1);
  });

  it('treats 401 and 403 as terminal', async () => {
    for (const code of [401, 403]) {
      const fetchImpl = fakeFetch([() => json({ error: 'nope' }, code)]);
      const { result, unmount } = renderHook(() =>
        usePaymentStatus('pay_1', { fetchImpl: fetchImpl.impl }),
      );

      await flush();
      // Surfaced, not thrown.
      expect(result.current.error?.message, String(code)).toContain(String(code));
      expect(result.current.isPolling, String(code)).toBe(false);

      // Retrying an authorization failure is a loop with no exit.
      await flush(120_000);
      expect(fetchImpl.spy, String(code)).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('keeps polling on a 404, which is a charge whose webhook has not landed', async () => {
    const fetchImpl = fakeFetch([() => json({ error: 'unknown reference' }, 404), paid]);
    const { result } = renderHook(() => usePaymentStatus('pay_1', { fetchImpl: fetchImpl.impl }));

    await flush();
    expect(result.current.status).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.isPolling).toBe(true);

    await flush(2000);
    expect(result.current.status).toBe('paid');
  });

  it('surfaces a transient failure and keeps polling', async () => {
    const fetchImpl = fakeFetch([
      () => {
        throw new Error('network down');
      },
      paid,
    ]);
    const { result } = renderHook(() => usePaymentStatus('pay_1', { fetchImpl: fetchImpl.impl }));

    await flush();
    expect(result.current.error?.message).toBe('network down');
    expect(result.current.isPolling).toBe(true);

    await flush(2000);
    expect(result.current.status).toBe('paid');
    expect(result.current.error).toBeNull();
  });

  it('stops while the tab is hidden and resumes when it comes back', async () => {
    const fetchImpl = fakeFetch([pending]);
    renderHook(() => usePaymentStatus('pay_1', { fetchImpl: fetchImpl.impl }));

    await flush();
    expect(fetchImpl.spy).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    await act(async () => {
      emitVisibilityChange();
    });
    // A backgrounded checkout tab polling all night is a real cost, and nobody is looking.
    await flush(120_000);
    expect(fetchImpl.spy).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    await act(async () => {
      emitVisibilityChange();
    });
    await flush();
    expect(fetchImpl.spy).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a reference, or while disabled', async () => {
    const fetchImpl = fakeFetch([pending]);
    const { result, rerender } = renderHook(
      ({ reference, enabled }: { reference: string | null; enabled: boolean }) =>
        usePaymentStatus(reference, { fetchImpl: fetchImpl.impl, enabled }),
      { initialProps: { reference: null as string | null, enabled: true } },
    );

    await flush(60_000);
    expect(fetchImpl.spy).not.toHaveBeenCalled();
    expect(result.current.isPolling).toBe(false);

    rerender({ reference: 'pay_1', enabled: false });
    await flush(60_000);
    expect(fetchImpl.spy).not.toHaveBeenCalled();

    rerender({ reference: 'pay_1', enabled: true });
    await flush();
    expect(fetchImpl.spy).toHaveBeenCalledTimes(1);
  });

  it('reports a status it does not recognize instead of passing it through', async () => {
    // The union is what keeps a consumer's exhaustive switch honest; a custom store writing
    // its own status string must not slip past it silently.
    const fetchImpl = fakeFetch([() => json({ status: 'processing', amount: 1, currency: 'BRL' })]);
    const { result } = renderHook(() => usePaymentStatus('pay_1', { fetchImpl: fetchImpl.impl }));

    await flush();
    expect(result.current.status).toBeNull();
    expect(result.current.error?.message).toContain('processing');
    expect(result.current.isPolling).toBe(true);
  });

  it('builds the URL from baseUrl + path and escapes the reference', async () => {
    const fetchImpl = fakeFetch([pending]);
    renderHook(() =>
      usePaymentStatus('order 1/2', {
        fetchImpl: fetchImpl.impl,
        baseUrl: 'https://api.app',
        path: '/checkout',
      }),
    );

    await flush();
    expect(fetchImpl.calls[0]).toBe('https://api.app/checkout/status?reference=order%201%2F2');
  });
});
