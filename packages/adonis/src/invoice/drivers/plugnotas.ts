import type { Invoice } from '../../types.js';
import type { InvoiceEmitInput, InvoiceProvider } from '../invoice_provider.js';

export interface PlugNotasInvoiceConfig {
  /** PlugNotas API key. Defaults to `env.get('PLUGNOTAS_API_KEY')`. */
  apiKey?: string;
  /** PlugNotas API URL. Defaults to the production endpoint. */
  baseUrl?: string;
}

interface PlugNotasInvoiceResponse {
  id?: string;
  numero?: string;
  status?: string;
  urlPdf?: string;
  urlXml?: string;
  valor?: number;
  dataEmissao?: string;
}

/**
 * PlugNotas invoice provider — NFS-e API. Uses `fetch` directly (no SDK dependency).
 * Exact field names follow the PlugNotas API; if a variant differs, extend this driver.
 */
export class PlugNotasInvoiceProvider implements InvoiceProvider {
  readonly provider = 'plugnotas';

  #apiKey: string;
  #baseUrl: string;

  constructor(_ctx: { config: () => unknown }, config: PlugNotasInvoiceConfig = {}) {
    const apiKey = config.apiKey ?? process.env.PLUGNOTAS_API_KEY;
    if (!apiKey) {
      throw new Error(
        '[payments] PlugNotas invoice provider requires an API key. Set `PLUGNOTAS_API_KEY` env or pass `apiKey` to `invoice.plugnotas()`.',
      );
    }
    this.#apiKey = apiKey;
    this.#baseUrl = config.baseUrl ?? 'https://api.plugnotas.com.br';
  }

  async emit(input: InvoiceEmitInput): Promise<Invoice> {
    const body = {
      tomador: {
        cpfCnpj: input.customer.taxId.replace(/\D/g, ''),
        razaoSocial: input.customer.name ?? 'Cliente',
        email: input.customer.email,
        endereco: input.customer.address ?? undefined,
      },
      servico: {
        descricao: input.service.description,
        codigoServico: input.service.code,
      },
      valor: input.amount / 100,
      ...(input.tax !== undefined ? { impostos: input.tax } : {}),
    };

    const response = await fetch(`${this.#baseUrl}/nfse`, {
      method: 'POST',
      headers: {
        'X-API-KEY': this.#apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[payments] PlugNotas invoice request failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as PlugNotasInvoiceResponse;
    return this.#mapInvoice(data);
  }

  async find(invoiceId: string): Promise<Invoice | null> {
    const response = await fetch(`${this.#baseUrl}/nfse/${encodeURIComponent(invoiceId)}`, {
      headers: { 'X-API-KEY': this.#apiKey },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[payments] PlugNotas invoice request failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as PlugNotasInvoiceResponse;
    return this.#mapInvoice(data);
  }

  #mapInvoice(data: PlugNotasInvoiceResponse): Invoice {
    const status = data.status ?? '';
    const normalized: Invoice['status'] =
      status === 'AUTORIZADO' || status === 'AUTORIZADA' || status === 'emitido'
        ? 'issued'
        : status === 'CANCELADO' || status === 'REJEITADO' || status === 'cancelado'
          ? 'canceled'
          : 'pending';
    return {
      id: data.id ?? data.numero ?? String(Math.random()),
      gatewayId: data.id ?? data.numero ?? '',
      provider: this.provider,
      ...(data.numero !== undefined ? { number: data.numero } : {}),
      ...(data.urlPdf !== undefined ? { url: data.urlPdf, hostedPdfUrl: data.urlPdf } : {}),
      status: normalized,
      ...(data.dataEmissao !== undefined ? { issuedAt: data.dataEmissao } : {}),
      amount: { amount: Math.round(Number(data.valor ?? 0) * 100), currency: 'brl' },
      createdAt: data.dataEmissao ?? new Date().toISOString(),
      payload: data as unknown as Record<string, unknown>,
    };
  }
}
