import { channel } from 'node:diagnostics_channel';
import { afterEach, describe, expect, it } from 'vitest';
import { isPaymentsDiagnosticClaimed, PAYMENTS_DIAGNOSTIC_EVENTS } from '../src/diagnostics.js';
import { PaymentsWatcher } from '../src/telescope/payments_watcher.js';
import type { WatcherContext } from '../src/telescope/telescope-sdk.js';

/** Publish a `DiagnosticEvent`-shaped envelope on `agora:payments:<event>`, as the diagnostics emit slot would. */
function publish(event: string, payload: Record<string, unknown>): void {
  channel(`agora:payments:${event}`).publish({ v: 1, ts: 111, lib: 'payments', event, payload });
}

function ctx() {
  const recorded: Array<{ type: string; content: unknown }> = [];
  return { recorded, record: (entry: { type: string; content: unknown }) => recorded.push(entry) };
}

let watcher: PaymentsWatcher | undefined;
afterEach(() => watcher?.dispose());

describe('PaymentsWatcher', () => {
  it('records a typed `payments` entry (event + flattened payload) per milestone', () => {
    watcher = new PaymentsWatcher();
    const c = ctx();
    watcher.register(c);

    publish('charge.created', {
      gatewayId: 'pay_1',
      provider: 'asaas',
      amount: 1990,
      currency: 'BRL',
    });

    expect(c.recorded).toEqual([
      {
        type: 'payments',
        content: {
          event: 'charge.created',
          ts: 111,
          gatewayId: 'pay_1',
          provider: 'asaas',
          amount: 1990,
          currency: 'BRL',
        },
      },
    ]);
  });

  it('records every milestone event type', () => {
    watcher = new PaymentsWatcher();
    const c = ctx();
    watcher.register(c);

    for (const event of PAYMENTS_DIAGNOSTIC_EVENTS) {
      publish(event, { id: 'x' });
    }
    expect(c.recorded).toHaveLength(PAYMENTS_DIAGNOSTIC_EVENTS.length);
    expect(c.recorded.map((entry) => (entry.content as { event: string }).event)).toEqual([
      ...PAYMENTS_DIAGNOSTIC_EVENTS,
    ]);
  });

  it('claims every recorded channel on register', () => {
    watcher = new PaymentsWatcher();
    watcher.register(ctx());

    for (const event of PAYMENTS_DIAGNOSTIC_EVENTS) {
      expect(isPaymentsDiagnosticClaimed(event)).toBe(true);
    }
  });

  it('releases every claim and stops recording after dispose', () => {
    const c = ctx();
    watcher = new PaymentsWatcher();
    watcher.register(c);
    watcher.dispose();
    watcher = undefined;

    for (const event of PAYMENTS_DIAGNOSTIC_EVENTS) {
      expect(isPaymentsDiagnosticClaimed(event)).toBe(false);
    }
    publish('charge.created', { gatewayId: 'pay_2' });
    expect(c.recorded).toHaveLength(0);
  });
});

describe('PaymentsWatcher entry shape', () => {
  it('leads with the fields a developer scans by, then the rest, then ts', () => {
    watcher = new PaymentsWatcher();
    const c = ctx();
    watcher.register(c);

    channel('agora:payments:gateway.request.failed').publish({
      v: 1,
      ts: 222,
      lib: 'payments',
      event: 'gateway.request.failed',
      payload: {
        requestBody: { value: 1990 },
        error: 'HTTP 422',
        durationMs: 143,
        path: '/v3/payments',
        method: 'POST',
        host: 'api.asaas.com',
        outcome: 'http_error',
        status: 422,
        provider: 'asaas',
        traceId: 'trace-1',
      },
    });

    expect(Object.keys(c.recorded[0]!.content as object)).toEqual([
      'event',
      'traceId',
      'provider',
      'method',
      'host',
      'path',
      'status',
      'outcome',
      'durationMs',
      'error',
      'requestBody',
      'ts',
    ]);
  });

  it('surfaces the payload traceId, so one delivery reads as one chain', () => {
    watcher = new PaymentsWatcher();
    const c = ctx();
    watcher.register(c);

    for (const event of ['webhook.received', 'webhook.verification', 'payment.succeeded']) {
      publish(event, { provider: 'asaas', traceId: 'trace-7' });
    }

    expect(c.recorded.map((e) => (e.content as { traceId?: string }).traceId)).toEqual([
      'trace-7',
      'trace-7',
      'trace-7',
    ]);
  });

  it('prefers the envelope traceId — the host request trace reaches other libraries too', () => {
    watcher = new PaymentsWatcher();
    const c = ctx();
    watcher.register(c);

    channel('agora:payments:webhook.received').publish({
      v: 1,
      ts: 1,
      lib: 'payments',
      event: 'webhook.received',
      traceId: 'request-trace',
      payload: { id: 'evt_1', provider: 'asaas', type: 'x', traceId: 'webhook-trace' },
    });

    expect((c.recorded[0]!.content as { traceId: string }).traceId).toBe('request-trace');
  });

  it('records the debug events too — a gateway call is a payments entry like any other', () => {
    watcher = new PaymentsWatcher();
    const c = ctx();
    watcher.register(c);

    publish('gateway.request', { provider: 'asaas', method: 'GET', status: 200, durationMs: 12 });
    publish('webhook.verification', { provider: 'asaas', outcome: 'unreported' });

    expect(c.recorded.map((e) => (e.content as { event: string }).event)).toEqual([
      'gateway.request',
      'webhook.verification',
    ]);
    expect(c.recorded[1]!.content).toMatchObject({ outcome: 'unreported' });
  });
});
