import {
  type GatewayOutcome,
  paymentsDiagnosticsEnabled,
  publishGatewayRequest,
  redactText,
} from './diagnostics.js';

export interface HttpRequestOptions {
  method?: string;
  body?: Record<string, unknown>;
  /** Auth header sent as `Authorization: Bearer <token>`. */
  bearerToken?: string;
  /** Auth header sent as a raw header name/value (e.g. Asaas `access_token`). */
  authHeader?: { name: string; value: string };
  /**
   * Extra request headers (e.g. PagBank's `x-idempotency-key`). Merged last, so a driver
   * can also override `Content-Type` when a gateway wants something else.
   */
  headers?: Record<string, string>;
  /**
   * The `fetch` implementation to call. Defaults to the global one.
   *
   * This is the seam a gateway that requires **mutual TLS** needs: a client certificate
   * cannot be expressed as a header, only as the connection's TLS identity, which in Node
   * means a custom undici dispatcher. Rather than teach this helper about undici (a
   * dependency it does not have), the driver that needs mTLS — Efí's Pix API — builds its
   * own certificate-bearing `fetch` and passes it here, so it still gets the shared error
   * normalization every other driver relies on.
   */
  fetch?: typeof globalThis.fetch;
  /** Base URL the path is resolved against. */
  baseUrl: string;
  /**
   * The driver's provider name (`'asaas'`, `'woovi'`, …), recorded on the
   * `gateway.request` diagnostic so a Telescope entry names the gateway it belongs to.
   *
   * Optional, because the host of {@link baseUrl} already identifies the gateway and no
   * driver is obliged to pass it. Drivers that pass it get the friendlier label.
   */
  provider?: string;
  /**
   * Milliseconds before the request is aborted. Defaults to 30s; pass `0` to disable.
   *
   * `fetch` has no timeout of its own, so without this a gateway that accepts the
   * connection and then stops talking holds the call open indefinitely. That is bad in a
   * charge and worse inside the webhook route, where the gateway on the other side is
   * waiting to decide whether to redeliver — and where the request that never returns also
   * never releases its slot.
   */
  timeoutMs?: number;
}

/** 30 seconds: long enough for a slow gateway, short enough that a hung one is not forever. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Thin `fetch` wrapper shared by the fetch-based drivers (Asaas, AbacatePay, Woovi,
 * PagBank, Efí). Normalizes errors into an `Error` with a `status` property so
 * `isNotFound` can check it uniformly.
 */
export async function httpRequest<T>(path: string, options: HttpRequestOptions): Promise<T> {
  // Built once, used by every publish below. Cheap: `paymentsDiagnosticsEnabled()` is a
  // symbol lookup, and when nothing listens the whole diagnostics path costs that alone.
  const observed = paymentsDiagnosticsEnabled();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.bearerToken !== undefined) {
    headers.Authorization = `Bearer ${options.bearerToken}`;
  }
  if (options.authHeader !== undefined) {
    headers[options.authHeader.name] = options.authHeader.value;
  }
  if (options.headers !== undefined) {
    Object.assign(headers, options.headers);
  }

  const requestInit: RequestInit = {
    method: options.method ?? 'GET',
    headers,
  };
  if (options.body !== undefined) {
    requestInit.body = JSON.stringify(options.body);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = timeoutMs > 0 ? new AbortController() : undefined;
  const timer =
    controller !== undefined ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  if (controller !== undefined) requestInit.signal = controller.signal;

  const doFetch = options.fetch ?? globalThis.fetch;
  const call = {
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    method: requestInit.method ?? 'GET',
    baseUrl: options.baseUrl,
    path,
    startedAt: Date.now(),
    ...(options.body !== undefined ? { requestBody: options.body } : {}),
  };
  /** Record the call, then let the original error through untouched. */
  const record = (outcome: GatewayOutcome) => {
    if (observed) publishGatewayRequest(call, outcome);
  };

  let response: Response;
  try {
    response = await doFetch(`${options.baseUrl}${path}`, requestInit);
  } catch (error) {
    // An abort is indistinguishable from a network error to the caller unless it is named.
    // A driver that reports "fetch failed" for a timeout sends whoever is debugging it
    // looking for a connectivity problem that is not there.
    if (controller?.signal.aborted) {
      // The diagnostic's message is built here rather than reused from the thrown Error:
      // that one names the full URL, query string included, and this entry is meant to be
      // pasted into a bug report.
      record({ ok: false, outcome: 'timeout', error: `timed out after ${timeoutMs}ms` });
      throw new Error(
        `[payments] HTTP request to ${options.baseUrl}${path} timed out after ${timeoutMs}ms.`,
      );
    }
    record({
      ok: false,
      outcome: 'network_error',
      error: redactText(error instanceof Error ? error.message : String(error)),
    });
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text();
    const status = response.status;
    // `error` stays a bare status line; the gateway's own explanation of a 422 lives in
    // `responseBody`, which is opt-in because the echoed request is in there too.
    record({
      ok: false,
      outcome: 'http_error',
      status,
      error: `HTTP ${status}`,
      responseBody: text,
    });
    throw Object.assign(new Error(`[payments] HTTP request failed (${status}): ${text}`), {
      status,
    });
  }
  const parsed = (await response.json()) as T;
  record({ ok: true, status: response.status, responseBody: parsed });
  return parsed;
}

/** Read a header value (handles arrays, case variants and multiple spellings). */
export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return Array.isArray(direct) ? direct[0] : direct;
  // Case-insensitive fallback: scan the actual keys.
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

/** Whether an error is an HTTP 404 (resource not found). */
export function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: number }).status === 404
  );
}
