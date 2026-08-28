import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type PaymentStatus,
  isPaymentStatus,
  isTerminalPaymentStatus,
} from './statuses.js';

/** What one successful read of the endpoint said. */
export interface PaymentStatusSnapshot {
  status: PaymentStatus;
  /** Integer minor units, exactly as the gateway reported them. Format at the edge. */
  amount: number | null;
  currency: string | null;
  /** ISO 8601, or `null` while the payment has not settled. */
  paidAt: string | null;
}

export interface UsePaymentStatusOptions {
  /**
   * Where the endpoint is mounted. Defaults to `/payments/client` — the default `path` in
   * `config/payments_client.ts`. Point it at your own route to poll a hand-rolled endpoint.
   */
  path?: string;
  /** Origin to prefix the path with. Defaults to `''` (same origin as the page). */
  baseUrl?: string;
  /** Set `false` to hold off entirely — no request, no timer. Defaults to `true`. */
  enabled?: boolean;
  /** First interval after the immediate read. Defaults to `2000`. */
  initialDelayMs?: number;
  /** Ceiling the interval grows to. Defaults to `30000`. */
  maxDelayMs?: number;
  /** Growth per interval. Defaults to `1.5`. */
  backoffFactor?: number;
  /** Extra request headers (a CSRF token, a bearer token). */
  headers?: Record<string, string>;
  /** Defaults to `'same-origin'` — a session cookie goes along, a cross-site one does not. */
  credentials?: RequestCredentials;
  /** Injectable `fetch`, for tests and for non-browser hosts. */
  fetchImpl?: typeof fetch;
  /** Called once, when the payment reaches a terminal status. */
  onSettled?: (snapshot: PaymentStatusSnapshot) => void;
}

export interface UsePaymentStatusResult {
  /** `null` until the endpoint reports a status it recognizes. */
  status: PaymentStatus | null;
  /** The payment stopped moving — `paid`, `failed`, `refunded`, `canceled` or `disputed`. */
  isSettled: boolean;
  /** Whether a timer is still armed. `false` once settled, denied, or disabled. */
  isPolling: boolean;
  /** Surfaced, never thrown. A `401`/`403` sets this AND stops the loop. */
  error: Error | null;
  amount: number | null;
  currency: string | null;
  paidAt: string | null;
  /** Poll now and reset the backoff. A no-op while disabled or with no reference. */
  refresh: () => void;
}

interface HookState {
  status: PaymentStatus | null;
  amount: number | null;
  currency: string | null;
  paidAt: string | null;
  error: Error | null;
  isPolling: boolean;
}

const IDLE: HookState = {
  status: null,
  amount: null,
  currency: null,
  paidAt: null,
  error: null,
  isPolling: false,
};

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** The tab is in the background. Absent `document` (SSR, a test host) counts as visible. */
function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** Read the endpoint's four fields. `null` when the body is not the shape we expect. */
function readSnapshot(body: unknown): PaymentStatusSnapshot | { unrecognized: string } | null {
  const record = body as Record<string, unknown> | null | undefined;
  if (!record || typeof record.status !== 'string') return null;
  if (!isPaymentStatus(record.status)) return { unrecognized: record.status };
  return {
    status: record.status,
    amount: typeof record.amount === 'number' ? record.amount : null,
    currency: typeof record.currency === 'string' ? record.currency : null,
    paidAt: typeof record.paidAt === 'string' ? record.paidAt : null,
  };
}

/**
 * Poll a payment until it settles.
 *
 * ```tsx
 * const { status, isSettled, error } = usePaymentStatus(payment.id)
 * ```
 *
 * A Pix QR code (or a boleto) is not paid until the gateway's webhook confirms it, which
 * lands seconds to days later. This is the loop every app that takes Pix otherwise writes by
 * hand, with the four parts those hand-written ones usually miss:
 *
 * - **Backoff.** An immediate first read, then `2s`, `3s`, `4.5s` … capped at `30s`.
 * - **A stop condition.** A terminal status ends the loop. A Pix that will never be paid
 *   must not poll a customer's browser until they close the tab.
 * - **A background tab stops.** Polling pauses on `visibilitychange` and resumes on focus,
 *   because a checkout tab left open all night is a bill somebody pays.
 * - **`401`/`403` is terminal.** Retrying an authorization failure is a loop with no exit.
 *
 * A `404` is NOT an error and does not stop anything: `billing_payments` is written by the
 * webhook, so "no row yet" is the ordinary state of a charge nobody has paid.
 *
 * Options are read once per polling run. Changing `reference` or `enabled` restarts it;
 * changing a timing option mid-flight does not (call `refresh()` if you need that).
 */
export function usePaymentStatus(
  reference: string | null | undefined,
  options: UsePaymentStatusOptions = {},
): UsePaymentStatusResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [state, setState] = useState<HookState>(IDLE);
  const [runId, setRunId] = useState(0);

  const enabled = options.enabled ?? true;
  const active = enabled && typeof reference === 'string' && reference !== '';

  const refresh = useCallback(() => {
    setRunId((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!active) {
      setState(IDLE);
      return;
    }

    const opts = optionsRef.current;
    const doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const headers = { accept: 'application/json', ...(opts.headers ?? {}) };
    const credentials = opts.credentials ?? 'same-origin';
    const base = opts.baseUrl ?? '';
    const path = opts.path ?? '/payments/client';
    const url = `${base}${path}/status?reference=${encodeURIComponent(reference as string)}`;

    let delay = Math.max(100, opts.initialDelayMs ?? 2000);
    const maxDelay = Math.max(delay, opts.maxDelayMs ?? 30_000);
    const factor = Math.max(1, opts.backoffFactor ?? 1.5);

    /** The effect was torn down (unmount, or `reference` changed). Nothing may set state. */
    let disposed = false;
    /** The payment settled, or the caller is not allowed to ask. Nothing may re-arm. */
    let finished = false;
    /** A poll was due while the tab was hidden; run it as soon as the tab comes back. */
    let deferred = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const finish = () => {
      finished = true;
      clearTimer();
    };

    const schedule = () => {
      clearTimer();
      if (disposed || finished) return;
      // A hidden tab arms nothing at all — `visibilitychange` restarts the loop.
      if (isHidden()) {
        deferred = true;
        return;
      }
      const wait = delay;
      delay = Math.min(Math.round(delay * factor), maxDelay);
      timer = setTimeout(() => {
        timer = null;
        void poll();
      }, wait);
    };

    const fail = (error: Error, keepPolling: boolean) => {
      if (disposed) return;
      setState((previous) => ({ ...previous, error, isPolling: keepPolling }));
    };

    const poll = async (): Promise<void> => {
      if (disposed || finished) return;

      let response: Response;
      try {
        response = await doFetch(url, { method: 'GET', headers, credentials });
      } catch (cause) {
        // The network, not the server. Transient by nature — keep asking, slower.
        fail(toError(cause), true);
        schedule();
        return;
      }
      if (disposed || finished) return;

      if (response.status === 401 || response.status === 403) {
        // Terminal. Nothing about asking again makes the caller more entitled.
        finish();
        fail(
          new Error(
            `[payments] Not allowed to read the status of "${reference}" (HTTP ${response.status}).`,
          ),
          false,
        );
        return;
      }

      if (response.status === 404) {
        // No payment row yet — the webhook has not landed. This is the waiting state, not
        // an error, so any earlier transient error is cleared along with it.
        if (!disposed) {
          setState((previous) =>
            previous.error === null && previous.isPolling ? previous : { ...previous, error: null, isPolling: true },
          );
        }
        schedule();
        return;
      }

      if (!response.ok) {
        fail(new Error(`[payments] Payment status request failed (HTTP ${response.status}).`), true);
        schedule();
        return;
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (cause) {
        fail(toError(cause), true);
        schedule();
        return;
      }
      if (disposed || finished) return;

      const snapshot = readSnapshot(body);
      if (snapshot === null) {
        fail(new Error('[payments] Payment status response was not the expected shape.'), true);
        schedule();
        return;
      }
      if ('unrecognized' in snapshot) {
        // A status outside the union would break a consumer's exhaustive switch, so it is
        // reported rather than passed through. Not fatal: the next read may recognize it.
        fail(
          new Error(
            `[payments] Unrecognized payment status "${snapshot.unrecognized}" from the status endpoint.`,
          ),
          true,
        );
        schedule();
        return;
      }

      const settled = isTerminalPaymentStatus(snapshot.status);
      if (settled) finish();
      if (!disposed) {
        setState({
          status: snapshot.status,
          amount: snapshot.amount,
          currency: snapshot.currency,
          paidAt: snapshot.paidAt,
          error: null,
          isPolling: !settled,
        });
      }
      if (settled) {
        optionsRef.current.onSettled?.(snapshot);
        return;
      }
      schedule();
    };

    const onVisibilityChange = () => {
      if (disposed || finished) return;
      if (isHidden()) {
        clearTimer();
        deferred = true;
        return;
      }
      if (deferred) {
        deferred = false;
        void poll();
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    setState((previous) => ({ ...previous, isPolling: true }));
    if (isHidden()) {
      deferred = true;
    } else {
      void poll();
    }

    return () => {
      disposed = true;
      clearTimer();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [active, reference, runId]);

  return {
    status: state.status,
    isSettled: state.status !== null && isTerminalPaymentStatus(state.status),
    isPolling: state.isPolling,
    error: state.error,
    amount: state.amount,
    currency: state.currency,
    paidAt: state.paidAt,
    refresh,
  };
}
