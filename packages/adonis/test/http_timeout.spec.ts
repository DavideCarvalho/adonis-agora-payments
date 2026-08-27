import { describe, expect, it, vi } from 'vitest';
import { httpRequest } from '../src/http.js';

/**
 * `fetch` has no timeout of its own.
 *
 * Without one, a gateway that accepts the connection and then stops talking holds the call
 * open indefinitely — bad in a charge, worse inside the webhook route, where the gateway is
 * waiting to decide whether to redeliver and the hung request never releases its slot.
 */
describe('httpRequest timeouts', () => {
  /** A fetch that never settles until its signal aborts. */
  const hangingFetch = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
  );

  it('aborts a hung request and says so', async () => {
    await expect(
      httpRequest('/charges', {
        baseUrl: 'https://gateway.test',
        fetch: hangingFetch as unknown as typeof globalThis.fetch,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out after 20ms/);
  });

  it('names the URL in the timeout, so the failing call is identifiable', async () => {
    await expect(
      httpRequest('/v1/payments/pi_1', {
        baseUrl: 'https://gateway.test',
        fetch: hangingFetch as unknown as typeof globalThis.fetch,
        timeoutMs: 20,
      }),
    ).rejects.toThrow('https://gateway.test/v1/payments/pi_1');
  });

  it('does not abort a request that answers in time', async () => {
    const quick = vi.fn(async () => new Response(JSON.stringify({ id: 'pay_1' }), { status: 200 }));
    const body = await httpRequest<{ id: string }>('/charges', {
      baseUrl: 'https://gateway.test',
      fetch: quick as unknown as typeof globalThis.fetch,
      timeoutMs: 5_000,
    });
    expect(body).toEqual({ id: 'pay_1' });
  });

  it('passes an abort signal by default — a driver gets the timeout without asking', async () => {
    const capture = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal, 'no signal means no timeout, whatever the default says').toBeDefined();
      return new Response('{}', { status: 200 });
    });
    await httpRequest('/x', {
      baseUrl: 'https://gateway.test',
      fetch: capture as unknown as typeof globalThis.fetch,
    });
    expect(capture).toHaveBeenCalled();
  });

  it('honours timeoutMs: 0 as "no timeout" rather than "abort immediately"', async () => {
    const capture = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeUndefined();
      return new Response('{}', { status: 200 });
    });
    await httpRequest('/x', {
      baseUrl: 'https://gateway.test',
      fetch: capture as unknown as typeof globalThis.fetch,
      timeoutMs: 0,
    });
    expect(capture).toHaveBeenCalled();
  });

  it('lets a real network error through unchanged', async () => {
    const failing = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      httpRequest('/x', {
        baseUrl: 'https://gateway.test',
        fetch: failing as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow('ECONNREFUSED');
  });
});
