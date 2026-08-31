import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimPaymentsDiagnostics,
  configurePaymentsDiagnostics,
  currentPaymentsTrace,
  isPaymentsDiagnosticClaimed,
  PAYMENTS_DIAGNOSTIC_EVENTS,
  paymentsDiagnosticsOptions,
  publishPayments,
  REDACTED,
  redactBody,
  redactQueryString,
  redactText,
  reportWebhookVerification,
  resetPaymentsDiagnosticsOptions,
  runWithPaymentsTrace,
  webhookVerificationOutcome,
} from '../src/diagnostics.js';
import { httpRequest } from '../src/http.js';
import { verifyHmacSignature } from '../src/webhook_security.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');

/** Seed the structural emit slot for the duration of `fn`, as a loaded diagnostics would. */
function withEmitSlot(
  emit: (lib: string, event: string, payload: unknown) => void,
  fn: () => void,
): void {
  const previous = (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
  (globalThis as Record<symbol, unknown>)[EMIT_SLOT] = emit;
  try {
    fn();
  } finally {
    if (previous === undefined) delete (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
    else (globalThis as Record<symbol, unknown>)[EMIT_SLOT] = previous;
  }
}

describe('payments diagnostics', () => {
  it('emits on the structural slot when installed (no-op otherwise)', () => {
    const events: [string, string, unknown][] = [];
    const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
    (globalThis as Record<symbol, unknown>)[EMIT_SLOT] = (
      lib: string,
      event: string,
      payload: unknown,
    ) => {
      events.push([lib, event, payload]);
    };
    try {
      publishPayments('charge.created', {
        gatewayId: 'pay_1',
        provider: 'asaas',
        amount: 1990,
        currency: 'brl',
      });
      expect(events).toHaveLength(1);
      expect(events[0]![0]).toBe('payments');
      expect(events[0]![1]).toBe('charge.created');
    } finally {
      delete (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
    }
  });

  it('is a no-op when diagnostics is not installed', () => {
    const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
    delete (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
    expect(() =>
      publishPayments('charge.created', {
        gatewayId: 'x',
        provider: 'asaas',
        amount: 1,
        currency: 'brl',
      }),
    ).not.toThrow();
  });

  it('claims and releases channels (reference-counted)', () => {
    const CLAIMS_SLOT = Symbol.for('@agora/diagnostics:claims');
    delete (globalThis as Record<symbol, unknown>)[CLAIMS_SLOT];
    expect(isPaymentsDiagnosticClaimed('charge.created')).toBe(false);
    const release = claimPaymentsDiagnostics(['charge.created']);
    expect(isPaymentsDiagnosticClaimed('charge.created')).toBe(true);
    const release2 = claimPaymentsDiagnostics(['charge.created']);
    expect(isPaymentsDiagnosticClaimed('charge.created')).toBe(true);
    release2();
    expect(isPaymentsDiagnosticClaimed('charge.created')).toBe(true);
    release();
    expect(isPaymentsDiagnosticClaimed('charge.created')).toBe(false);
  });

  it('exposes the runtime event catalog for watchers', () => {
    expect(PAYMENTS_DIAGNOSTIC_EVENTS).toContain('charge.created');
    expect(PAYMENTS_DIAGNOSTIC_EVENTS).toContain('webhook.processed');
  });
});

// ─── redaction ────────────────────────────────────────────────────────────────

describe('diagnostics redaction', () => {
  it('redacts credential-bearing query parameters, keeping the parameter names', () => {
    expect(redactQueryString('?limit=10&access_token=sk_live_abc&status=PAID')).toBe(
      `?limit=10&access_token=${REDACTED}&status=PAID`,
    );
  });

  it('redacts an api key however it is spelled', () => {
    for (const name of ['api_key', 'apiKey', 'X-Api-Key', 'authorization', 'signature']) {
      expect(redactQueryString(`?${name}=zzz`)).toBe(`?${name}=${REDACTED}`);
    }
  });

  it('leaves a query string with nothing sensitive alone', () => {
    expect(redactQueryString('?limit=10&offset=20')).toBe('?limit=10&offset=20');
  });

  it('redacts credentials embedded in a free-text error message', () => {
    const text = 'connect ECONNREFUSED https://api.test/v1/charges?access_token=sk_live_abc';
    expect(redactText(text)).not.toContain('sk_live_abc');
    expect(redactText(text)).toContain('ECONNREFUSED');
  });

  it('redacts card and tax-document fields anywhere in a body', () => {
    const body = redactBody({
      value: 1990,
      customer: { name: 'Ada', cpfCnpj: '123.456.789-00' },
      creditCard: { number: '4111111111111111', ccv: '123', holderName: 'ADA L' },
      apiKey: 'sk_live_abc',
    }) as Record<string, unknown>;

    expect(JSON.stringify(body)).not.toContain('4111111111111111');
    expect(JSON.stringify(body)).not.toContain('123.456.789-00');
    expect(JSON.stringify(body)).not.toContain('sk_live_abc');
    // ...while the fields that make the call debuggable survive.
    expect(body.value).toBe(1990);
    expect((body.customer as { name: string }).name).toBe('Ada');
  });

  it('truncates a long string rather than storing the whole thing', () => {
    const body = redactBody({ description: 'x'.repeat(5_000) }, 100) as { description: string };
    expect(body.description.length).toBeLessThan(200);
    expect(body.description).toContain('[truncated]');
  });
});

// ─── opt-in switches ──────────────────────────────────────────────────────────

describe('configurePaymentsDiagnostics', () => {
  afterEach(() => resetPaymentsDiagnosticsOptions());

  it('keeps HTTP bodies off by default', () => {
    expect(paymentsDiagnosticsOptions().recordHttpBodies).toBe(false);
  });

  it('turns bodies on only when asked', () => {
    configurePaymentsDiagnostics({ recordHttpBodies: true });
    expect(paymentsDiagnosticsOptions().recordHttpBodies).toBe(true);
  });
});

// ─── correlation ──────────────────────────────────────────────────────────────

describe('payments trace frame', () => {
  it('stamps the ambient traceId onto every payload published inside it', () => {
    const seen: unknown[] = [];
    withEmitSlot(
      (_lib, _event, payload) => seen.push(payload),
      () => {
        runWithPaymentsTrace({ traceId: 'trace-1', provider: 'asaas' }, () => {
          publishPayments('webhook.received', { id: 'evt_1', provider: 'asaas', type: 'x' });
          publishPayments('payment.succeeded', {
            gatewayId: 'pay_1',
            provider: 'asaas',
            amount: 100,
            currency: 'brl',
          });
        });
      },
    );
    expect(seen.map((p) => (p as { traceId?: string }).traceId)).toEqual(['trace-1', 'trace-1']);
  });

  it('adds nothing outside a frame', () => {
    const seen: unknown[] = [];
    withEmitSlot(
      (_lib, _event, payload) => seen.push(payload),
      () => {
        publishPayments('webhook.received', { id: 'evt_1', provider: 'asaas', type: 'x' });
      },
    );
    expect(seen[0]).not.toHaveProperty('traceId');
  });

  it('lets a passing verification report win over a failing one', () => {
    runWithPaymentsTrace({ traceId: 't' }, () => {
      reportWebhookVerification('hmac-sha1', false);
      reportWebhookVerification('rsa-sha256', true);
      reportWebhookVerification('hmac-sha1', false);
      expect(currentPaymentsTrace()?.verification).toEqual({ scheme: 'rsa-sha256', ok: true });
    });
  });

  it('is a silent no-op when nothing established a frame', () => {
    expect(() => reportWebhookVerification('hmac-sha256', true)).not.toThrow();
    expect(currentPaymentsTrace()).toBeUndefined();
  });
});

// ─── gateway HTTP calls ───────────────────────────────────────────────────────

/** Collect every `agora:payments:*` publish made while `fn` runs. */
async function captureEvents(
  fn: () => Promise<unknown>,
): Promise<Array<{ event: string; payload: Record<string, unknown> }>> {
  const seen: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const previous = (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
  (globalThis as Record<symbol, unknown>)[EMIT_SLOT] = (
    _lib: string,
    event: string,
    payload: unknown,
  ) => {
    seen.push({ event, payload: payload as Record<string, unknown> });
  };
  try {
    await fn().catch(() => undefined);
  } finally {
    if (previous === undefined) delete (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
    else (globalThis as Record<symbol, unknown>)[EMIT_SLOT] = previous;
  }
  return seen;
}

const jsonFetch = (status: number, body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;

describe('gateway.request diagnostics', () => {
  afterEach(() => resetPaymentsDiagnosticsOptions());

  it('records a successful gateway call with method, host, path, status and duration', async () => {
    const seen = await captureEvents(() =>
      httpRequest('/v3/payments', {
        baseUrl: 'https://api.asaas.com',
        method: 'POST',
        provider: 'asaas',
        body: { value: 1990 },
        fetch: jsonFetch(200, { id: 'pay_1' }),
      }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.event).toBe('gateway.request');
    expect(seen[0]!.payload).toMatchObject({
      provider: 'asaas',
      method: 'POST',
      host: 'api.asaas.com',
      path: '/v3/payments',
      status: 200,
    });
    expect(typeof seen[0]!.payload.durationMs).toBe('number');
  });

  it('records a 422 — the outcome that has no other trace anywhere', async () => {
    const seen = await captureEvents(() =>
      httpRequest('/v3/payments', {
        baseUrl: 'https://api.asaas.com',
        method: 'POST',
        fetch: jsonFetch(422, { errors: [{ description: 'invalid CPF' }] }),
      }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.event).toBe('gateway.request.failed');
    expect(seen[0]!.payload).toMatchObject({
      outcome: 'http_error',
      status: 422,
      error: 'HTTP 422',
      path: '/v3/payments',
    });
  });

  it('records a timeout, and never puts the URL in the recorded error', async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as unknown as typeof globalThis.fetch;

    const seen = await captureEvents(() =>
      httpRequest('/v3/payments?access_token=sk_live_abc', {
        baseUrl: 'https://api.asaas.com',
        fetch: hanging,
        timeoutMs: 10,
      }),
    );

    expect(seen[0]!.event).toBe('gateway.request.failed');
    expect(seen[0]!.payload.outcome).toBe('timeout');
    expect(seen[0]!.payload.error).toBe('timed out after 10ms');
    expect(String(seen[0]!.payload.error)).not.toContain('api.asaas.com');
  });

  it('records a transport failure', async () => {
    const failing = (async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:443');
    }) as unknown as typeof globalThis.fetch;

    const seen = await captureEvents(() =>
      httpRequest('/x', { baseUrl: 'https://api.asaas.com', fetch: failing }),
    );

    expect(seen[0]!.event).toBe('gateway.request.failed');
    expect(seen[0]!.payload).toMatchObject({
      outcome: 'network_error',
      error: 'connect ECONNREFUSED 10.0.0.1:443',
    });
  });

  it('never records a credential — not the bearer token, not one in the query', async () => {
    const seen = await captureEvents(() =>
      httpRequest('/v3/payments?access_token=sk_live_SECRET&limit=10', {
        baseUrl: 'https://api.asaas.com',
        method: 'POST',
        bearerToken: 'bearer_SECRET',
        authHeader: { name: 'access_token', value: 'header_SECRET' },
        headers: { 'X-Api-Key': 'apikey_SECRET' },
        body: { creditCard: { number: '4111111111111111' } },
        fetch: jsonFetch(200, { id: 'pay_1' }),
      }),
    );

    const dumped = JSON.stringify(seen);
    expect(dumped).not.toContain('SECRET');
    expect(dumped).not.toContain('4111111111111111');
    // The parameter NAME survives — that is what makes the call identifiable.
    expect(seen[0]!.payload.query).toBe(`?access_token=${REDACTED}&limit=10`);
  });

  it('omits bodies unless they are explicitly turned on', async () => {
    const seen = await captureEvents(() =>
      httpRequest('/v3/payments', {
        baseUrl: 'https://api.asaas.com',
        method: 'POST',
        body: { value: 1990 },
        fetch: jsonFetch(200, { id: 'pay_1' }),
      }),
    );
    expect(seen[0]!.payload).not.toHaveProperty('requestBody');
    expect(seen[0]!.payload).not.toHaveProperty('responseBody');
  });

  it('includes redacted bodies once they are turned on', async () => {
    configurePaymentsDiagnostics({ recordHttpBodies: true });
    const seen = await captureEvents(() =>
      httpRequest('/v3/payments', {
        baseUrl: 'https://api.asaas.com',
        method: 'POST',
        body: { value: 1990, creditCard: { number: '4111111111111111' } },
        fetch: jsonFetch(200, { id: 'pay_1' }),
      }),
    );
    expect(seen[0]!.payload.requestBody).toEqual({ value: 1990, creditCard: REDACTED });
    expect(seen[0]!.payload.responseBody).toEqual({ id: 'pay_1' });
  });

  it('carries the ambient traceId so a call made inside a webhook correlates to it', async () => {
    const seen = await new Promise<Array<{ payload: Record<string, unknown> }>>((resolve) => {
      runWithPaymentsTrace({ traceId: 'trace-9', provider: 'asaas' }, () => {
        captureEvents(() =>
          httpRequest('/v3/payments/pay_1', {
            baseUrl: 'https://api.asaas.com',
            fetch: jsonFetch(200, { id: 'pay_1' }),
          }),
        ).then(resolve);
      });
    });
    expect(seen[0]!.payload.traceId).toBe('trace-9');
  });

  it('publishes nothing at all when diagnostics is not installed', async () => {
    delete (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
    const published: string[] = [];
    const { channel } = await import('node:diagnostics_channel');
    const handler = () => published.push('x');
    channel('agora:payments:gateway.request').subscribe(handler);
    try {
      const body = await httpRequest<{ id: string }>('/v3/payments', {
        baseUrl: 'https://api.asaas.com',
        fetch: jsonFetch(200, { id: 'pay_1' }),
      });
      expect(body).toEqual({ id: 'pay_1' });
      expect(published).toHaveLength(0);
    } finally {
      channel('agora:payments:gateway.request').unsubscribe(handler);
    }
  });
});

// ─── webhook verification outcome ─────────────────────────────────────────────

describe('webhook verification outcome', () => {
  it('is `verified`, named by scheme, when a shared helper matched', () => {
    const frame = { traceId: 't', verification: { scheme: 'hmac-sha256', ok: true } };
    expect(webhookVerificationOutcome(frame)).toEqual({
      outcome: 'verified',
      scheme: 'hmac-sha256',
    });
  });

  it('is `failed` with the reason when parseWebhook rejected the delivery', () => {
    const frame = { traceId: 't', verification: { scheme: 'standard-webhooks', ok: false } };
    expect(webhookVerificationOutcome(frame, 'Invalid signature')).toEqual({
      outcome: 'failed',
      scheme: 'standard-webhooks',
      reason: 'Invalid signature',
    });
  });

  it('is `failed` even when the throw came before any scheme ran', () => {
    expect(webhookVerificationOutcome({ traceId: 't' }, 'Missing webhook token')).toEqual({
      outcome: 'failed',
      reason: 'Missing webhook token',
    });
  });

  it('is `unreported` when nothing verified through the shared helpers', () => {
    // The case that was invisible: an unset webhook credential means the driver never
    // reaches a verifier at all, and the delivery is accepted unauthenticated.
    expect(webhookVerificationOutcome({ traceId: 't' })).toEqual({ outcome: 'unreported' });
    expect(webhookVerificationOutcome(undefined)).toEqual({ outcome: 'unreported' });
  });

  it('is fed by the shared verification helpers, end to end', () => {
    const secret = 's3cret';
    const body = '{"event":"PAYMENT_RECEIVED"}';
    const good = createHmac('sha256', secret).update(body, 'utf8').digest('base64');

    runWithPaymentsTrace({ traceId: 't', provider: 'abacatepay' }, () => {
      expect(verifyHmacSignature(body, good, secret, 'sha256')).toBe(true);
      expect(webhookVerificationOutcome(currentPaymentsTrace())).toEqual({
        outcome: 'verified',
        scheme: 'hmac-sha256',
      });
    });

    runWithPaymentsTrace({ traceId: 't2', provider: 'abacatepay' }, () => {
      expect(verifyHmacSignature(body, 'nope', secret, 'sha256')).toBe(false);
      expect(webhookVerificationOutcome(currentPaymentsTrace())).toEqual({
        outcome: 'failed',
        scheme: 'hmac-sha256',
      });
    });
  });
});
