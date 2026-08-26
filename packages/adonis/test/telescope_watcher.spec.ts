import { channel } from 'node:diagnostics_channel';
import { afterEach, describe, expect, it } from 'vitest';
import { PAYMENTS_DIAGNOSTIC_EVENTS, isPaymentsDiagnosticClaimed } from '../src/diagnostics.js';
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
