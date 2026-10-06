import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsaasDriver } from '../src/drivers/asaas.js';
import { AsaasInvoiceProvider } from '../src/invoice/drivers/asaas.js';
import { emitInvoice } from '../src/invoice/emit_invoice.js';
import type { InvoiceEmitInput } from '../src/invoice/invoice_provider.js';

/** Shapes from Asaas' `InvoiceGetResponseDTO` (docs.asaas.com, "Agendar nota fiscal"). */
const SCHEDULED = {
  object: 'invoice',
  id: 'inv_000000000232',
  status: 'SCHEDULED',
  customer: 'cus_000000002750',
  payment: 'pay_123',
  type: 'NFS-e',
  statusDescription: null,
  serviceDescription: 'Consultoria patrimonial',
  pdfUrl: null,
  xmlUrl: null,
  number: null,
  validationCode: null,
  value: 1500.5,
  deductions: 0,
  effectiveDate: '2026-10-06',
  observations: 'Competência 09/2026',
  externalReference: 'fee-invoice-42',
};

const AUTHORIZED = {
  ...SCHEDULED,
  status: 'AUTHORIZED',
  number: '1234',
  pdfUrl: 'https://www.asaas.com/nfse/inv.pdf',
  xmlUrl: 'https://www.asaas.com/nfse/inv.xml',
};

const BASE: InvoiceEmitInput = {
  customer: { name: 'Jane Doe', taxId: '123.456.789-09', email: 'jane@example.com' },
  amount: 150050,
  currency: 'brl',
  service: { description: 'Consultoria patrimonial' },
  tax: { iss: 2 },
  payment: { gatewayId: 'pay_123', provider: 'asaas' },
};

type Route = { status: number; body: unknown };

function stubFetch(...routes: Route[]) {
  const queue = [...routes];
  const fetchMock = vi.fn().mockImplementation(async () => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected fetch');
    return {
      ok: next.status < 400,
      status: next.status,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function call(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  const [url, init] = fetchMock.mock.calls[index]! as [string, RequestInit];
  return {
    url: String(url),
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body !== undefined ? JSON.parse(String(init.body)) : undefined,
  };
}

function provider() {
  return new AsaasInvoiceProvider({ config: () => ({}) }, { apiKey: 'test', sandbox: true });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('AsaasInvoiceProvider.emit', () => {
  it('sends the Asaas charge as `payment`, never the CPF/CNPJ as `customer`', async () => {
    const fetchMock = stubFetch({ status: 200, body: SCHEDULED });

    await provider().emit(BASE);

    const { url, method, headers, body } = call(fetchMock, 0);
    expect(url).toBe('https://api-sandbox.asaas.com/v3/invoices');
    expect(method).toBe('POST');
    expect(headers.access_token).toBe('test');
    expect(body.payment).toBe('pay_123');
    expect(body).not.toHaveProperty('customer');
    expect(JSON.stringify(body)).not.toContain('12345678909');
  });

  it('sends `customer` only as the Asaas customer id', async () => {
    const fetchMock = stubFetch({ status: 200, body: SCHEDULED });
    const { payment: _payment, ...rest } = BASE;

    await provider().emit({ ...rest, customer: { ...BASE.customer, gatewayId: 'cus_9' } });

    const { body } = call(fetchMock, 0);
    expect(body.customer).toBe('cus_9');
    expect(body).not.toHaveProperty('payment');
  });

  it('ignores a charge taken by another gateway and refuses with no Asaas id at all', async () => {
    const fetchMock = stubFetch();
    await expect(
      provider().emit({ ...BASE, payment: { gatewayId: 'ch_stripe', provider: 'stripe' } }),
    ).rejects.toThrow(/Asaas charge .* or the Asaas customer id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends every required field of InvoiceSaveRequestDTO', async () => {
    const fetchMock = stubFetch({ status: 200, body: SCHEDULED });

    await provider().emit({
      ...BASE,
      effectiveDate: '2026-10-15',
      deductions: 10000,
      observations: 'Competência 09/2026',
      service: {
        description: 'Consultoria patrimonial',
        cityServiceCode: '17.01',
        municipalServiceId: '1234',
        municipalServiceName: 'Assessoria ou consultoria de qualquer natureza',
      },
      tax: {
        retainIss: true,
        iss: 2,
        pis: 0.65,
        cofins: 3,
        csll: 1,
        inss: 0,
        ir: 1.5,
        nbsCode: '1.1301.10.00',
      },
    });

    const { body } = call(fetchMock, 0);
    expect(body).toEqual({
      payment: 'pay_123',
      serviceDescription: 'Consultoria patrimonial',
      observations: 'Competência 09/2026',
      value: 1500.5,
      deductions: 100,
      effectiveDate: '2026-10-15',
      municipalServiceId: '1234',
      municipalServiceCode: '17.01',
      municipalServiceName: 'Assessoria ou consultoria de qualquer natureza',
      taxes: {
        retainIss: true,
        iss: 2,
        pis: 0.65,
        cofins: 3,
        csll: 1,
        inss: 0,
        ir: 1.5,
        nbsCode: '1.1301.10.00',
      },
    });
  });

  it('defaults the retentions to none, deductions to 0 and the date to today in Brasília', async () => {
    // 01:30 UTC on Oct 7 is still Oct 6 in Brasília.
    vi.useFakeTimers({ now: new Date('2026-10-07T01:30:00Z'), toFake: ['Date'] });
    const fetchMock = stubFetch({ status: 200, body: SCHEDULED });

    await provider().emit({ ...BASE, service: { description: 'X', code: '17.01' } });

    const { body } = call(fetchMock, 0);
    expect(body.effectiveDate).toBe('2026-10-06');
    expect(body.deductions).toBe(0);
    expect(body.observations).toBe('');
    // `service.code` is the municipal code when `cityServiceCode` is absent; Asaas has no
    // `serviceCode` field.
    expect(body.municipalServiceCode).toBe('17.01');
    expect(body).not.toHaveProperty('serviceCode');
    expect(body).not.toHaveProperty('municipalServiceName');
    expect(body.taxes).toEqual({
      retainIss: false,
      iss: 2,
      pis: 0,
      cofins: 0,
      csll: 0,
      inss: 0,
      ir: 0,
    });
  });

  it('refuses to guess the ISS rate', async () => {
    const fetchMock = stubFetch();
    const { tax: _tax, ...rest } = BASE;
    await expect(provider().emit(rest)).rejects.toThrow(/ISS rate/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('carries what the caller passed, not the customer name and e-mail', async () => {
    const fetchMock = stubFetch({ status: 200, body: SCHEDULED });

    await provider().emit({ ...BASE, observations: 'Obs', metadata: { orderId: 7 } });

    const { body } = call(fetchMock, 0);
    expect(body.serviceDescription).toBe('Consultoria patrimonial');
    expect(body.observations).toBe('Obs');
    expect(body).not.toHaveProperty('description');
    expect(body).not.toHaveProperty('notes');
    expect(JSON.stringify(body)).not.toContain('Jane Doe');
    expect(JSON.stringify(body)).not.toContain('jane@example.com');
    expect(JSON.stringify(body)).not.toContain('orderId');
  });

  it('maps the scheduled response as pending', async () => {
    stubFetch({ status: 200, body: SCHEDULED });

    const invoice = await provider().emit(BASE);

    expect(invoice).toMatchObject({
      id: 'inv_000000000232',
      gatewayId: 'inv_000000000232',
      provider: 'asaas',
      customerId: 'cus_000000002750',
      status: 'pending',
      amount: { amount: 150050, currency: 'brl' },
    });
    expect(invoice.number).toBeUndefined();
    expect(invoice.issuedAt).toBeUndefined();
  });

  it('throws with the Asaas error body when the request is refused', async () => {
    stubFetch({ status: 400, body: { errors: [{ code: 'invalid', description: 'x' }] } });
    await expect(provider().emit(BASE)).rejects.toThrow(/Asaas invoice request failed \(400\)/);
  });
});

describe('AsaasInvoiceProvider idempotency (externalReference)', () => {
  it('sends the reference and creates when none exists', async () => {
    const fetchMock = stubFetch(
      { status: 200, body: { data: [] } },
      { status: 200, body: SCHEDULED },
    );

    await provider().emit({ ...BASE, externalReference: 'fee-invoice-42' });

    expect(call(fetchMock, 0).url).toBe(
      'https://api-sandbox.asaas.com/v3/invoices?externalReference=fee-invoice-42&limit=100',
    );
    expect(call(fetchMock, 0).method).toBe('GET');
    expect(call(fetchMock, 1).body.externalReference).toBe('fee-invoice-42');
  });

  it('returns the live invoice already recorded under the reference instead of a second one', async () => {
    const fetchMock = stubFetch({ status: 200, body: { data: [AUTHORIZED] } });

    const invoice = await provider().emit({ ...BASE, externalReference: 'fee-invoice-42' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(invoice.gatewayId).toBe('inv_000000000232');
    expect(invoice.status).toBe('issued');
  });

  it('emits again when the only invoice under the reference was cancelled', async () => {
    const fetchMock = stubFetch(
      { status: 200, body: { data: [{ ...AUTHORIZED, status: 'CANCELED' }] } },
      { status: 200, body: { ...SCHEDULED, id: 'inv_new' } },
    );

    const invoice = await provider().emit({ ...BASE, externalReference: 'fee-invoice-42' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(invoice.gatewayId).toBe('inv_new');
  });
});

describe('AsaasInvoiceProvider.find / cancel', () => {
  it('maps an authorized invoice', async () => {
    stubFetch({ status: 200, body: AUTHORIZED });

    const invoice = await provider().find('inv_000000000232');

    expect(invoice).toMatchObject({
      status: 'issued',
      number: '1234',
      hostedPdfUrl: 'https://www.asaas.com/nfse/inv.pdf',
      issuedAt: '2026-10-06',
    });
  });

  it('maps every documented status', async () => {
    const cases: [string, string][] = [
      ['SCHEDULED', 'pending'],
      ['SYNCHRONIZED', 'pending'],
      ['AUTHORIZED', 'issued'],
      ['PROCESSING_CANCELLATION', 'issued'],
      ['CANCELLATION_DENIED', 'issued'],
      ['CANCELED', 'canceled'],
      ['ERROR', 'failed'],
    ];
    for (const [status, expected] of cases) {
      stubFetch({ status: 200, body: { ...SCHEDULED, status } });
      expect((await provider().find('inv_1'))?.status, status).toBe(expected);
    }
  });

  it('returns null on 404', async () => {
    stubFetch({ status: 404, body: { errors: [] } });
    expect(await provider().find('inv_x')).toBeNull();
  });

  it('cancels through POST /invoices/{id}/cancel', async () => {
    const fetchMock = stubFetch({
      status: 200,
      body: { ...AUTHORIZED, status: 'PROCESSING_CANCELLATION' },
    });

    const invoice = await provider().cancel('inv_000000000232');

    const { url, method, body } = call(fetchMock, 0);
    expect(url).toBe('https://api-sandbox.asaas.com/v3/invoices/inv_000000000232/cancel');
    expect(method).toBe('POST');
    expect(body).toEqual({});
    // Still valid at the city hall until INVOICE_CANCELED.
    expect(invoice.status).toBe('issued');
  });

  it('cancels only at Asaas when asked', async () => {
    const fetchMock = stubFetch({ status: 200, body: { ...AUTHORIZED, status: 'CANCELED' } });

    const invoice = await provider().cancel('inv_1', { providerOnly: true });

    expect(call(fetchMock, 0).body).toEqual({ cancelOnlyOnAsaas: true });
    expect(invoice.status).toBe('canceled');
  });
});

describe('emitInvoice through the Asaas provider', () => {
  it('passes the new invoice options through to the provider', async () => {
    const fetchMock = stubFetch(
      { status: 200, body: { data: [] } },
      { status: 200, body: SCHEDULED },
    );

    await emitInvoice(
      { invoice: () => provider() },
      {
        service: { description: 'Honorários', cityServiceCode: '17.01' },
        tax: { iss: 5 },
        effectiveDate: '2026-10-10',
        deductions: 500,
        observations: 'Obs',
        externalReference: 'ref-1',
      },
      {
        customer: { taxId: '12345678909' },
        amount: 10000,
        currency: 'brl',
        payment: { gatewayId: 'pay_9', provider: 'asaas' },
      },
    );

    expect(call(fetchMock, 1).body).toMatchObject({
      payment: 'pay_9',
      serviceDescription: 'Honorários',
      observations: 'Obs',
      externalReference: 'ref-1',
      value: 100,
      deductions: 5,
      effectiveDate: '2026-10-10',
      municipalServiceCode: '17.01',
      taxes: { iss: 5 },
    });
  });
});

describe('AsaasDriver webhooks for NFS-e', () => {
  function parse(event: string, invoice: Record<string, unknown>) {
    const driver = new AsaasDriver({ config: () => ({}) }, { apiKey: 'test', sandbox: true });
    return driver.parseWebhook(
      JSON.stringify({ id: `evt_${event}`, event, dateCreated: '2026-10-06 10:00:00', invoice }),
      {},
    );
  }

  it('maps the eight documented INVOICE_* events to nfse.*', () => {
    const cases: [string, string][] = [
      ['INVOICE_CREATED', 'nfse.created'],
      ['INVOICE_UPDATED', 'nfse.updated'],
      ['INVOICE_SYNCHRONIZED', 'nfse.synchronized'],
      ['INVOICE_AUTHORIZED', 'nfse.authorized'],
      ['INVOICE_ERROR', 'nfse.failed'],
      ['INVOICE_PROCESSING_CANCELLATION', 'nfse.cancellation_processing'],
      ['INVOICE_CANCELED', 'nfse.canceled'],
      ['INVOICE_CANCELLATION_DENIED', 'nfse.cancellation_denied'],
    ];
    for (const [event, type] of cases) {
      expect(parse(event, SCHEDULED).type, event).toBe(type);
    }
  });

  it('carries the note on the event data', () => {
    const event = parse('INVOICE_AUTHORIZED', AUTHORIZED);
    expect(event.id).toBe('evt_INVOICE_AUTHORIZED');
    expect(event.data).toEqual({
      gatewayId: 'inv_000000000232',
      status: 'issued',
      providerStatus: 'AUTHORIZED',
      amount: 150050,
      currency: 'brl',
      number: '1234',
      pdfUrl: 'https://www.asaas.com/nfse/inv.pdf',
      xmlUrl: 'https://www.asaas.com/nfse/inv.xml',
      paymentId: 'pay_123',
      customerId: 'cus_000000002750',
      externalReference: 'fee-invoice-42',
      effectiveDate: '2026-10-06',
    });
  });

  it('carries why the note failed', () => {
    const event = parse('INVOICE_ERROR', {
      ...SCHEDULED,
      status: 'ERROR',
      statusDescription: 'Inscrição municipal inválida',
    });
    expect(event.data).toMatchObject({
      status: 'failed',
      statusDescription: 'Inscrição municipal inválida',
    });
  });
});
