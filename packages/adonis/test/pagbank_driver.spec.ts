import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PagBankDriver } from '../src/drivers/pagbank.js';

const TOKEN = 'test-token';

function makeDriver(config: Record<string, unknown> = {}) {
  return new PagBankDriver({ config: () => ({}) }, { token: TOKEN, sandbox: true, ...config });
}

/** The `x-authenticity-token` PagBank would send for this body: sha256(`token-body`). */
function authenticityToken(rawBody: string, token = TOKEN): string {
  return createHash('sha256').update(`${token}-${rawBody}`, 'utf8').digest('hex');
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const PAID_ORDER = {
  id: 'ORDE_1',
  reference_id: 'pay_local_1',
  created_at: '2026-08-01T10:00:00.000-03:00',
  charges: [
    {
      id: 'CHAR_1',
      status: 'PAID',
      paid_at: '2026-08-01T10:01:00.000-03:00',
      amount: { value: 1990, currency: 'BRL', summary: { total: 1990, paid: 1990, refunded: 0 } },
      payment_method: { type: 'CREDIT_CARD', installments: 1 },
    },
  ],
};

describe('PagBankDriver webhooks', () => {
  it('accepts a webhook whose authenticity token matches and maps a PAID charge', () => {
    const driver = makeDriver();
    const raw = JSON.stringify(PAID_ORDER);
    const event = driver.parseWebhook(raw, { 'x-authenticity-token': authenticityToken(raw) });

    expect(event.type).toBe('payment.succeeded');
    // The ORDER id is the gatewayId — the same id `charge()` returned for this order.
    const data = event.data as { gatewayId: string; amount: number; externalReference?: string };
    expect(data.gatewayId).toBe('ORDE_1');
    // Centavos straight through: 1990 must not become 19.9 anywhere.
    expect(data.amount).toBe(1990);
    expect(data.externalReference).toBe('pay_local_1');
    // Deterministic event id, so a redelivery of the same transition dedupes in the ledger.
    expect(event.id).toBe('ORDE_1:CHAR_1:PAID:0');
  });

  it('rejects a webhook with a wrong authenticity token', () => {
    const driver = makeDriver();
    const raw = JSON.stringify(PAID_ORDER);
    expect(() =>
      driver.parseWebhook(raw, { 'x-authenticity-token': authenticityToken(raw, 'other-token') }),
    ).toThrow(/authenticity token/);
  });

  it('rejects a webhook with no authenticity token at all', () => {
    const driver = makeDriver();
    expect(() => driver.parseWebhook(JSON.stringify(PAID_ORDER), {})).toThrow(/authenticity token/);
  });

  it('rejects a body whose bytes were altered after signing', () => {
    const driver = makeDriver();
    const raw = JSON.stringify(PAID_ORDER);
    const token = authenticityToken(raw);
    const tampered = raw.replace('1990', '9990');
    expect(() => driver.parseWebhook(tampered, { 'x-authenticity-token': token })).toThrow(
      /authenticity token/,
    );
  });

  it('verifies against a separately configured webhookToken when the account uses one', () => {
    const driver = makeDriver({ webhookToken: 'hook-token' });
    const raw = JSON.stringify(PAID_ORDER);
    const event = driver.parseWebhook(raw, {
      'x-authenticity-token': authenticityToken(raw, 'hook-token'),
    });
    expect(event.type).toBe('payment.succeeded');
  });

  it('skips verification only when explicitly disabled', () => {
    const driver = makeDriver({ verifyWebhooks: false });
    const event = driver.parseWebhook(JSON.stringify(PAID_ORDER), {});
    expect(event.type).toBe('payment.succeeded');
  });

  it('maps a refunded charge to payment.refunded even while the charge reads PAID', () => {
    const driver = makeDriver({ verifyWebhooks: false });
    const raw = JSON.stringify({
      ...PAID_ORDER,
      charges: [
        {
          ...PAID_ORDER.charges[0],
          amount: { value: 1990, summary: { total: 1990, paid: 1990, refunded: 500 } },
        },
      ],
    });
    const event = driver.parseWebhook(raw, {});
    expect(event.type).toBe('payment.refunded');
    expect(event.id).toBe('ORDE_1:CHAR_1:PAID:500');
  });

  it('maps DECLINED to payment.failed and a pending Pix order to payment.updated', () => {
    const driver = makeDriver({ verifyWebhooks: false });
    const declined = driver.parseWebhook(
      JSON.stringify({
        id: 'ORDE_2',
        charges: [{ id: 'CHAR_2', status: 'DECLINED', amount: { value: 100 } }],
      }),
      {},
    );
    expect(declined.type).toBe('payment.failed');

    const pending = driver.parseWebhook(
      JSON.stringify({ id: 'ORDE_3', qr_codes: [{ amount: { value: 100 }, text: 'BRCODE' }] }),
      {},
    );
    expect(pending.type).toBe('payment.updated');
  });

  it('refuses the legacy form-encoded notification instead of half-parsing it', () => {
    const driver = makeDriver({ verifyWebhooks: false });
    expect(() =>
      driver.parseWebhook('notificationCode=ABC&notificationType=transaction', {}),
    ).toThrow(/not JSON/);
  });
});

describe('PagBankDriver charges', () => {
  it('creates a Pix charge (v2 flow), in centavos, on the sandbox host', async () => {
    // Shaped after the response in PagBank's "Criar pedido com QR Code PIX" reference:
    // Pix is a charge with `payment_method.type: 'PIX'`, and the BR Code comes back on
    // `charges[].qr_code.text` — not on an order-level `qr_codes` entry.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'ORDE_1',
        created_at: '2026-08-01T10:00:00.000-03:00',
        charges: [
          {
            id: 'CHAR_1',
            status: 'WAITING',
            amount: {
              value: 1990,
              currency: 'BRL',
              summary: { total: 1990, paid: 0, refunded: 0 },
            },
            payment_method: { type: 'PIX', pix: { expiration_date: '2026-08-01T11:00:00Z' } },
            qr_code: { id: 'QRCO_1', text: '00020101BR.GOV.BCB.PIX' },
            links: [{ rel: 'QRCODE.PNG', href: 'https://…/png', media: 'image/png', type: 'GET' }],
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const driver = makeDriver();
      const payment = await driver.charge({
        amount: 1990,
        method: 'pix',
        description: 'Plano Pro',
        externalReference: 'pay_local_1',
        customer: { name: 'Ana', email: 'ana@example.com', taxId: '123.456.789-09' },
      });

      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(String(url)).toBe('https://sandbox.api.pagseguro.com/orders');
      const body = JSON.parse(String(init.body));
      expect(body.charges[0].payment_method.type).toBe('PIX');
      expect(body.charges[0].payment_method.pix.expiration_date).toBeTypeOf('string');
      // Centavos on the wire, exactly as given.
      expect(body.charges[0].amount).toEqual({ value: 1990, currency: 'BRL' });
      expect(body.items[0].unit_amount).toBe(1990);
      expect(body.qr_codes).toBeUndefined();
      expect(body.reference_id).toBe('pay_local_1');
      expect(body.customer.tax_id).toBe('12345678909');
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);

      // The ORDER id, not CHAR_1 — the webhook will carry the order.
      expect(payment.gatewayId).toBe('ORDE_1');
      expect(payment.amount).toEqual({ amount: 1990, currency: 'brl' });
      expect(payment.status).toBe('pending');
      expect(payment.method).toBe('pix');
      expect(payment.pixCode).toBe('00020101BR.GOV.BCB.PIX');
      // PagBank returns links to the QR image, never base64 content.
      expect(payment.pixQrCodeImage).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still reads the older order-level qr_codes shape when one arrives', () => {
    const payment = makeDriver({ verifyWebhooks: false }).parseWebhook(
      JSON.stringify({
        id: 'ORDE_5',
        qr_codes: [{ id: 'QRCO_5', amount: { value: 500 }, text: 'LEGACY_BRCODE' }],
      }),
      {},
    );
    expect((payment.data as { gatewayId: string; amount: number }).amount).toBe(500);
  });

  it('creates a card charge with the encrypted card and sends the idempotency key as a header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(PAID_ORDER));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const driver = makeDriver();
      const payment = await driver.charge({
        amount: 1990,
        method: 'credit_card',
        idempotencyKey: 'idem_1',
        card: {
          token: 'ENCRYPTED_BLOB',
          holder: {
            name: 'Ana',
            email: 'ana@example.com',
            cpfCnpj: '12345678909',
            postalCode: '01001000',
            addressNumber: '1',
            phone: '11999999999',
          },
        },
      });
      const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      const body = JSON.parse(String(init.body));
      expect(body.charges[0].payment_method.type).toBe('CREDIT_CARD');
      expect(body.charges[0].payment_method.card).toEqual({
        encrypted: 'ENCRYPTED_BLOB',
        holder: { name: 'Ana' },
      });
      expect(body.charges[0].amount).toEqual({ value: 1990, currency: 'BRL' });
      expect((init.headers as Record<string, string>)['x-idempotency-key']).toBe('idem_1');
      expect(payment.status).toBe('paid');
      expect(payment.method).toBe('card');
      expect(payment.paidAt).toBe('2026-08-01T10:01:00.000-03:00');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends a stored card by id rather than as an encrypted blob', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(PAID_ORDER));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await makeDriver().charge({
        amount: 100,
        method: 'credit_card',
        paymentMethodId: 'CARD_abc',
        customer: { name: 'Ana', email: 'ana@example.com', taxId: '12345678909' },
      });
      const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(JSON.parse(String(init.body)).charges[0].payment_method.card).toEqual({
        id: 'CARD_abc',
        holder: { name: 'Ana' },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses a charge with no payer instead of letting PagBank reject it', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(makeDriver().charge({ amount: 1990, method: 'pix' })).rejects.toThrow(
        /requires the payer/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('PagBankDriver refunds', () => {
  it('resolves the order id to its charge and cancels with the paid amount', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(PAID_ORDER))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'CHAR_1',
          status: 'CANCELED',
          amount: { value: 1990, summary: { total: 1990, paid: 1990, refunded: 1990 } },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const refund = await makeDriver().refund('ORDE_1');
      const [lookupUrl] = fetchMock.mock.calls[0]! as [string];
      const [cancelUrl, cancelInit] = fetchMock.mock.calls[1]! as [string, RequestInit];
      expect(String(lookupUrl)).toContain('/orders/ORDE_1');
      expect(String(cancelUrl)).toContain('/charges/CHAR_1/cancel');
      expect(JSON.parse(String(cancelInit.body))).toEqual({ amount: { value: 1990 } });
      expect(refund.status).toBe('succeeded');
      expect(refund.amount).toEqual({ amount: 1990, currency: 'brl' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refunds a partial amount against a charge id directly', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(PAID_ORDER.charges[0]))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'CHAR_1',
          status: 'PAID',
          amount: { value: 1990, summary: { total: 1990, paid: 1990, refunded: 500 } },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const refund = await makeDriver().refund('CHAR_1', 500);
      const [, cancelInit] = fetchMock.mock.calls[1]! as [string, RequestInit];
      expect(JSON.parse(String(cancelInit.body))).toEqual({ amount: { value: 500 } });
      expect(refund.status).toBe('succeeded');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('forwards an idempotencyKey as the x-idempotency-key header on the cancel', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(PAID_ORDER))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'CHAR_1',
          status: 'CANCELED',
          amount: { value: 1990, summary: { total: 1990, paid: 1990, refunded: 1990 } },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await makeDriver().refund('ORDE_1', undefined, { idempotencyKey: 'idem-refund-1' });
      const [, cancelInit] = fetchMock.mock.calls[1]! as [string, RequestInit];
      const headers = cancelInit.headers as Record<string, string>;
      // The same 48-hour key the charge uses — without it a retried cancel takes the
      // money out twice.
      expect(headers['x-idempotency-key']).toBe('idem-refund-1');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends no idempotency header when the caller gave no key', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(PAID_ORDER))
      .mockResolvedValueOnce(
        jsonResponse({ id: 'CHAR_1', status: 'CANCELED', amount: { value: 1990 } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await makeDriver().refund('ORDE_1');
      const [, cancelInit] = fetchMock.mock.calls[1]! as [string, RequestInit];
      expect((cancelInit.headers as Record<string, string>)['x-idempotency-key']).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says why an unpaid Pix order cannot be refunded', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: 'ORDE_9', qr_codes: [{ amount: { value: 100 } }] }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(makeDriver().refund('ORDE_9')).rejects.toThrow(/no charge to refund/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('PagBankDriver capabilities', () => {
  it('boots only with a token', () => {
    const saved = process.env.PAGBANK_TOKEN;
    process.env.PAGBANK_TOKEN = undefined;
    // biome-ignore lint/performance/noDelete: env var must be absent, not "undefined".
    delete process.env.PAGBANK_TOKEN;
    try {
      expect(() => new PagBankDriver({ config: () => ({}) }, {})).toThrow(
        /requires token.*PAGBANK_TOKEN.*payments\.pagbank/s,
      );
    } finally {
      if (saved !== undefined) process.env.PAGBANK_TOKEN = saved;
    }
  });

  it('refuses subscriptions instead of faking them', async () => {
    const driver = makeDriver();
    expect(driver.capabilities.subscriptions).toBe(false);
    await expect(driver.createSubscription({ customerId: 'c', planId: 'p' })).rejects.toThrow(
      /Assinaturas API/,
    );
    await expect(driver.findSubscription('sub_1')).rejects.toThrow(/Assinaturas API/);
  });

  it('refuses customer operations the Orders API does not have', async () => {
    const driver = makeDriver();
    await expect(driver.createCustomer({ name: 'Ana' })).rejects.toThrow(/no customer resource/);
    await expect(driver.findCustomer('cus_1')).rejects.toThrow(/no customer resource/);
  });

  it('reports an AUTHORIZED charge as authorized — money held, nothing captured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'ORDE_2',
        charges: [
          {
            id: 'CHAR_2',
            status: 'AUTHORIZED',
            amount: { value: 1990, currency: 'BRL', summary: { total: 1990, paid: 0 } },
            payment_method: { type: 'CREDIT_CARD' },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      // PagBank's own word for it is "pré-autorizada"; it becomes PAID through
      // `POST /charges/{id}/capture`. `pending` understated a hold the acquirer granted.
      expect((await makeDriver().findPayment('ORDE_2'))?.status).toBe('authorized');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not report an authorization as a completed payment on the webhook', () => {
    const driver = makeDriver();
    const raw = JSON.stringify({
      id: 'ORDE_2',
      charges: [
        {
          id: 'CHAR_2',
          status: 'AUTHORIZED',
          amount: { value: 1990, summary: { total: 1990, paid: 0, refunded: 0 } },
          payment_method: { type: 'CREDIT_CARD' },
        },
      ],
    });
    const event = driver.parseWebhook(raw, { 'x-authenticity-token': authenticityToken(raw) });
    // There is no canonical authorization event, and it is certainly not a success.
    expect(event.type).toBe('payment.updated');
  });

  it('refuses to list invoices rather than answering with an empty array', async () => {
    const driver = makeDriver();
    expect(driver.capabilities.invoices).toBe(false);
    // `[]` is indistinguishable from "this customer has no invoices", which is not
    // something PagBank told us — the Orders API has no invoice resource at all.
    await expect(driver.listInvoices('cus_1')).rejects.toThrow(/PagBank has no invoices to list/);
  });

  it('has no dispute event to map: a chargeback is not an Orders API notification', () => {
    // PagBank's chargeback arrives as the legacy form-encoded
    // `notificationType=transaction` post-transaction notification (status 9, "Retenção
    // temporária"), resolved against the v3 XML API with legacy credentials. It is not
    // JSON, it carries no authenticity token, and this driver refuses it rather than
    // half-parsing it — so no PagBank webhook maps to `payment.disputed`.
    const legacy = 'notificationCode=ABC&notificationType=transaction';
    // With verification on it does not even get as far as the parser: the legacy
    // notification carries no `x-authenticity-token`.
    expect(() => makeDriver().parseWebhook(legacy, {})).toThrow(/authenticity token/);
    expect(() => makeDriver({ verifyWebhooks: false }).parseWebhook(legacy, {})).toThrow(
      /not JSON/,
    );
  });

  it('does not advertise a payment method it cannot create', () => {
    expect([...makeDriver().supportedMethods]).toEqual([
      'pix',
      'credit_card',
      'debit_card',
      'boleto',
    ]);
  });
});

describe('PagBankDriver checkout', () => {
  it('round-trips externalReference: in on the session, out of the webhook', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'ORDE_7',
        reference_id: 'chk_local_1',
        charges: [
          {
            id: 'CHAR_7',
            status: 'WAITING',
            amount: { value: 5000 },
            payment_method: { type: 'PIX' },
            qr_code: { text: 'BRCODE' },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const driver = makeDriver();
      const session = await driver.createCheckout({
        amount: 5000,
        successUrl: 'https://app.test/ok',
        externalReference: 'chk_local_1',
        customer: { name: 'Ana', email: 'ana@example.com', taxId: '12345678909' },
      });
      const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      // In: PagBank's `reference_id` is the field that comes back on notifications.
      expect(JSON.parse(String(init.body)).reference_id).toBe('chk_local_1');
      expect(session.gatewayId).toBe('ORDE_7');
      expect(session.pixCode).toBe('BRCODE');
      // PagBank hosts no redirect page for an Orders API order.
      expect(session.url).toBe('');

      // Out: the same reference on the webhook that settles it.
      const raw = JSON.stringify({
        id: 'ORDE_7',
        reference_id: 'chk_local_1',
        charges: [
          { id: 'CHAR_7', status: 'PAID', amount: { value: 5000, summary: { paid: 5000 } } },
        ],
      });
      const event = driver.parseWebhook(raw, { 'x-authenticity-token': authenticityToken(raw) });
      expect((event.data as { externalReference?: string }).externalReference).toBe('chk_local_1');
      expect((event.data as { gatewayId: string }).gatewayId).toBe(session.gatewayId);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
