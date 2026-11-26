import { createHmac } from 'node:crypto';
import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleWebhookDelivery } from '../providers/payments_provider.js';
import { WebhookDispatcher } from '../src/billing/webhook_dispatcher.js';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import type { PaymentsDriver } from '../src/driver.js';
import { MercadoPagoDriver } from '../src/drivers/mercadopago.js';
import { MollieDriver } from '../src/drivers/mollie.js';
import { PaymentsManager } from '../src/payments_manager.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

/**
 * A redelivery of an event the ledger has already taken must not cost a gateway call.
 *
 * Mercado Pago and Mollie both fetch the resource a notification names before they can return
 * an event, and the ledger is only consulted after that. Where the event's id can be read and
 * AUTHENTICATED locally — a configured signing secret — the mounted route answers the redelivery
 * from the ledger without the fetch. Without a secret the fetch is what vouches for the call, so
 * the delivery is parsed in full every time.
 */

const MP_SECRET = 'whsec-mercadopago';
const MP_REQUEST_ID = '2066ca19-c6f1-498a-be75-1923005edd06';
const MP_TS = String(Math.floor(Date.now() / 1000));

function mpSignature(dataId: string): string {
  return createHmac('sha256', MP_SECRET)
    .update(`id:${dataId};request-id:${MP_REQUEST_ID};ts:${MP_TS};`)
    .digest('hex');
}

function mpNotification(dataId: string, id: number | undefined = 12345): string {
  return JSON.stringify({
    ...(id !== undefined ? { id } : {}),
    type: 'payment',
    action: 'payment.updated',
    date_created: '2026-03-25T10:04:58.396-04:00',
    data: { id: dataId },
  });
}

function mpHeaders(dataId: string, signature = mpSignature(dataId)) {
  return { 'x-signature': `ts=${MP_TS},v1=${signature}`, 'x-request-id': MP_REQUEST_ID };
}

function mpDriver(webhookSecret?: string): MercadoPagoDriver {
  return new MercadoPagoDriver(
    { config: () => ({}) },
    {
      accessToken: 'TEST-token',
      currency: 'brl',
      ...(webhookSecret !== undefined ? { webhookSecret } : {}),
    },
  );
}

const MOLLIE_SECRET = 'mollie_secret';
const MOLLIE_EVENT_BODY =
  '{"resource":"event","id":"event_abc","type":"payment.paid","entityId":"tr_1","createdAt":"2026-08-27T10:00:00+00:00"}';
const MOLLIE_SIGNATURE = `sha256=${createHmac('sha256', MOLLIE_SECRET).update(MOLLIE_EVENT_BODY).digest('hex')}`;

function mollieDriver(webhookSecret?: string): MollieDriver {
  return new MollieDriver(
    { config: () => ({}) },
    {
      apiKey: 'test_key',
      currency: 'eur',
      ...(webhookSecret !== undefined ? { webhookSecret } : {}),
    },
  );
}

/** A gateway that answers every fetch with `body` and counts the calls. */
function gateway(body: unknown) {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const MP_PAYMENT = {
  id: 999999999,
  status: 'approved',
  transaction_amount: 19.9,
  currency_id: 'BRL',
  payment_method_id: 'pix',
  payment_type_id: 'bank_transfer',
  payer: { id: 'cus_1' },
};

const MOLLIE_PAYMENT = {
  id: 'tr_1',
  status: 'paid',
  amount: { currency: 'EUR', value: '19.90' },
  createdAt: '2026-08-27T10:00:00+00:00',
  paidAt: '2026-08-27T10:01:00+00:00',
};

/** The mounted route over one driver, an in-memory ledger and an in-process dispatcher. */
function route(driver: PaymentsDriver, handlers: Record<string, () => void> = {}) {
  const store = new InMemoryBillingStore();
  const processor = new WebhookProcessor({ store, handlers });
  const dispatcher = new WebhookDispatcher({ processor, mode: 'in-process', retries: { max: 1 } });
  const manager = new PaymentsManager({ drivers: new Map([[driver.provider, driver]]) });
  const deliver = async (rawBody: string, headers: Record<string, string>) => {
    const sent = { statusCode: 0 };
    const response = {
      status(code: number) {
        sent.statusCode = code;
        return response;
      },
      json: (body: unknown) => body,
    };
    const ctx = {
      params: { provider: driver.provider },
      request: { raw: () => rawBody, headers: () => headers },
      response,
    } as unknown as HttpContext;
    await handleWebhookDelivery(ctx, { manager, dispatcher, store });
    return sent.statusCode;
  };
  return { store, deliver };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Mercado Pago redeliveries', () => {
  // The signature covers only `data.id`, the request id and `ts`, so the ledger id is built from
  // the signed id and the FETCHED state: no id is known before the fetch, and a redelivery is
  // fetched again. The ledger still runs it once.
  const LEDGER_ID = 'mercadopago:payment:999999999:approved:';

  it('run a signed redelivery once (fetched again, deduped by the ledger)', async () => {
    const fetchMock = gateway(MP_PAYMENT);
    let runs = 0;
    const { store, deliver } = route(mpDriver(MP_SECRET), {
      'payment.succeeded': () => {
        runs += 1;
      },
    });

    expect(await deliver(mpNotification('999999999'), mpHeaders('999999999'))).toBe(200);
    expect(await deliver(mpNotification('999999999'), mpHeaders('999999999'))).toBe(200);
    // A new notification about the same, unchanged payment is the same ledger row too.
    expect(await deliver(mpNotification('999999999', 2), mpHeaders('999999999'))).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(runs).toBe(1);
    expect((await store.findWebhookEventByGatewayEventId(LEDGER_ID))?.status).toBe('processed');
  });

  it('re-fetch and re-run an event whose previous attempt failed', async () => {
    const fetchMock = gateway(MP_PAYMENT);
    let attempts = 0;
    const { store, deliver } = route(mpDriver(MP_SECRET), {
      'payment.succeeded': () => {
        attempts += 1;
        if (attempts === 1) throw new Error('downstream unavailable');
      },
    });

    expect(await deliver(mpNotification('999999999'), mpHeaders('999999999'))).toBe(500);
    expect(await deliver(mpNotification('999999999'), mpHeaders('999999999'))).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(attempts).toBe(2);
    expect((await store.findWebhookEventByGatewayEventId(LEDGER_ID))?.status).toBe('processed');
  });

  it('fetch every time when no webhook secret vouches for the body', async () => {
    const fetchMock = gateway(MP_PAYMENT);
    const { deliver } = route(mpDriver());

    await deliver(mpNotification('999999999'), {});
    await deliver(mpNotification('999999999'), {});

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still refuse a forged signature', async () => {
    gateway(MP_PAYMENT);
    const { deliver } = route(mpDriver(MP_SECRET));
    await deliver(mpNotification('999999999'), mpHeaders('999999999'));

    expect(await deliver(mpNotification('999999999'), mpHeaders('999999999', 'f'.repeat(64)))).toBe(
      400,
    );
  });

  it('acknowledge a topic it does not look up with 200 and no ledger row', async () => {
    const fetchMock = gateway(MP_PAYMENT);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { store, deliver } = route(mpDriver(MP_SECRET));
    const body = JSON.stringify({
      ...JSON.parse(mpNotification('999999999')),
      type: 'merchant_order',
    });
    expect(await deliver(body, mpHeaders('999999999'))).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await store.listWebhookEvents({})).toEqual([]);
    debug.mockRestore();
  });

  it('name no id before the fetch', () => {
    const driver = mpDriver(MP_SECRET) as PaymentsDriver;
    expect(driver.webhookEventIds).toBeUndefined();
  });
});

describe('Mollie redeliveries', () => {
  it('answer a signed next-gen redelivery from the ledger without fetching the payment again', async () => {
    const fetchMock = gateway(MOLLIE_PAYMENT);
    const { store, deliver } = route(mollieDriver(MOLLIE_SECRET));
    const headers = { 'x-mollie-signature': MOLLIE_SIGNATURE };

    expect(await deliver(MOLLIE_EVENT_BODY, headers)).toBe(200);
    expect(await deliver(MOLLIE_EVENT_BODY, headers)).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await store.findWebhookEventByGatewayEventId('event_abc'))?.status).toBe('processed');
  });

  it('fetch every time on the classic flow, whose event id comes from the fetched payment', async () => {
    const fetchMock = gateway(MOLLIE_PAYMENT);
    const { deliver } = route(mollieDriver());

    await deliver('id=tr_1', {});
    await deliver('id=tr_1', {});

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('name nothing for a body that does not verify', () => {
    const driver = mollieDriver(MOLLIE_SECRET);
    expect(
      driver.webhookEventIds(MOLLIE_EVENT_BODY, { 'x-mollie-signature': 'sha256=00' }),
    ).toBeUndefined();
    expect(driver.webhookEventIds(MOLLIE_EVENT_BODY, {})).toBeUndefined();
  });
});
