export interface HttpRequestOptions {
  method?: string;
  body?: Record<string, unknown>;
  /** Auth header sent as `Authorization: Bearer <token>`. */
  bearerToken?: string;
  /** Auth header sent as a raw header name/value (e.g. Asaas `access_token`). */
  authHeader?: { name: string; value: string };
  /** Base URL the path is resolved against. */
  baseUrl: string;
}

/**
 * Thin `fetch` wrapper shared by the fetch-based drivers (Asaas, AbacatePay, Woovi).
 * Normalizes errors into an `Error` with a `status` property so `isNotFound` can check
 * it uniformly.
 */
export async function httpRequest<T>(path: string, options: HttpRequestOptions): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.bearerToken !== undefined) {
    headers.Authorization = `Bearer ${options.bearerToken}`;
  }
  if (options.authHeader !== undefined) {
    headers[options.authHeader.name] = options.authHeader.value;
  }

  const requestInit: RequestInit = {
    method: options.method ?? 'GET',
    headers,
  };
  if (options.body !== undefined) {
    requestInit.body = JSON.stringify(options.body);
  }

  const response = await fetch(`${options.baseUrl}${path}`, requestInit);

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
