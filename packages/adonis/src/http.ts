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
  let response: Response;
  try {
    response = await doFetch(`${options.baseUrl}${path}`, requestInit);
  } catch (error) {
    // An abort is indistinguishable from a network error to the caller unless it is named.
    // A driver that reports "fetch failed" for a timeout sends whoever is debugging it
    // looking for a connectivity problem that is not there.
    if (controller?.signal.aborted) {
      throw new Error(
        `[payments] HTTP request to ${options.baseUrl}${path} timed out after ${timeoutMs}ms.`,
      );
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text();
    const status = response.status;
    throw Object.assign(new Error(`[payments] HTTP request failed (${status}): ${text}`), {
      status,
    });
  }
  return (await response.json()) as T;
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
