import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsaasInvoiceProvider } from '../src/invoice/drivers/asaas.js';
import { ENotasInvoiceProvider } from '../src/invoice/drivers/enotas.js';
import { PlugNotasInvoiceProvider } from '../src/invoice/drivers/plugnotas.js';
import type { InvoiceEmitInput } from '../src/invoice/invoice_provider.js';

const INPUT: InvoiceEmitInput = {
  customer: { name: 'Jane Doe', taxId: '123.456.789-00', email: 'jane@example.com' },
  amount: 1990,
  currency: 'brl',
  service: { description: 'Software license', code: '1.01' },
};

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: Record<string, unknown>) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('invoice providers', () => {
  it('Asaas emits a native NFS-e via /invoices and maps the response', async () => {
    const fetchMock = stubFetch(200, {
      id: 'inv_1',
      status: 'AUTHORIZED',
      nfseNumber: '12345',
      nfseAccessKey: 'NFeKey',
      invoiceUrl: 'https://asaas.com/inv.pdf',
      value: 19.9,
    });
    const provider = new AsaasInvoiceProvider(
      { config: () => ({}) },
      { apiKey: 'test', sandbox: true },
    );

    const invoice = await provider.emit(INPUT);

    expect(invoice.provider).toBe('asaas');
    expect(invoice.gatewayId).toBe('inv_1');
    expect(invoice.number).toBe('12345');
    expect(invoice.key).toBe('NFeKey');
    expect(invoice.status).toBe('issued');
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toContain('api-sandbox.asaas.com/v3/invoices');
    expect(JSON.parse(String(init.body))).toMatchObject({
      value: 19.9,
      serviceDescription: 'Software license',
      serviceCode: '1.01',
    });
  });

  it('eNotas emits via /empresas/nfes', async () => {
    const fetchMock = stubFetch(200, {
      id: 'nfe_1',
      numero: '999',
      status: 'AUTORIZADO',
      valor: 19.9,
    });
    const provider = new ENotasInvoiceProvider({ config: () => ({}) }, { apiKey: 'test' });

    const invoice = await provider.emit(INPUT);

    expect(invoice.provider).toBe('enotas');
    expect(invoice.gatewayId).toBe('nfe_1');
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toContain('/empresas/nfes');
    const body = JSON.parse(String(init.body));
    expect(body.cliente.cpf).toBe('12345678900');
    expect(body.servico.valor).toBe(19.9);
  });

  it('PlugNotas emits via /nfse with X-API-KEY', async () => {
    const fetchMock = stubFetch(200, { id: 'pn_1', status: 'emitido', valor: 19.9 });
    const provider = new PlugNotasInvoiceProvider({ config: () => ({}) }, { apiKey: 'test' });

    const invoice = await provider.emit(INPUT);

    expect(invoice.provider).toBe('plugnotas');
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toContain('/nfse');
    expect((init.headers as Record<string, string>)['X-API-KEY']).toBe('test');
    expect(JSON.parse(String(init.body)).valor).toBe(19.9);
  });

  it('throws with a clear error when the provider rejects', async () => {
    stubFetch(422, { message: 'invalid' });
    const provider = new ENotasInvoiceProvider({ config: () => ({}) }, { apiKey: 'test' });
    await expect(provider.emit(INPUT)).rejects.toThrow(/eNotas invoice request failed \(422\)/);
  });

  it('requires a credential at construction', () => {
    expect(() => new AsaasInvoiceProvider({ config: () => ({}) }, {})).toThrow(
      /requires an API key/,
    );
    expect(() => new ENotasInvoiceProvider({ config: () => ({}) }, {})).toThrow(
      /requires an API key/,
    );
    expect(() => new PlugNotasInvoiceProvider({ config: () => ({}) }, {})).toThrow(
      /requires an API key/,
    );
  });
});
