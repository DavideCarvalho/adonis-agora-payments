import type { Invoice } from '../../types.js';
import type { InvoiceEmitInput, InvoiceProvider } from '../invoice_provider.js';

export interface ENotasInvoiceConfig {
  /** eNotas API key. Defaults to `env.get('ENOTAS_API_KEY')`. */
  apiKey?: string;
  /** eNotas API URL. Defaults to the production endpoint. */
  baseUrl?: string;
}

interface ENotasInvoiceResponse {
  id?: string;
  numero?: string;
  status?: string;
  urlNfce?: string;
  urlDanfe?: string;
  valor?: number;
  dataEmissao?: string;
}

/**
 * eNotas invoice provider — REST API for NFS-e/NF-e across Brazilian municipalities.
 * Uses `fetch` directly (no SDK dependency). Exact field names follow the eNotas API;
 * if a municipality/plan variant differs, extend this driver (see Custom providers).
 */
export class ENotasInvoiceProvider implements InvoiceProvider {
  readonly provider = 'enotas';

  #apiKey: string;
  #baseUrl: string;

  constructor(_ctx: { config: () => unknown }, config: ENotasInvoiceConfig = {}) {
    const apiKey = config.apiKey ?? process.env.ENOTAS_API_KEY;
    if (!apiKey) {
      throw new Error(
        '[payments] eNotas invoice provider requires an API key. Set `ENOTAS_API_KEY` env or pass `apiKey` to `invoice.enotas()`.',
      );
    }
    this.#apiKey = apiKey;
    this.#baseUrl = config.baseUrl ?? 'https://api.enotasgw.com.br/v1';
  }

  async emit(input: InvoiceEmitInput): Promise<Invoice> {
    const body = {
      cliente: {
        nome: input.customer.name ?? 'Cliente',
        email: input.customer.email,
        pessoaFisica: input.customer.taxId.length <= 11,
        cpf: input.customer.taxId.replace(/\D/g, ''),
        endereco: input.customer.address ?? undefined,
      },
      servico: {
        descricao: input.service.description,
        codigoServico: input.service.code,
        valor: input.amount / 100,
      },
      ...(input.tax !== undefined ? { impostos: input.tax } : {}),
    };

    const response = await fetch(`${this.#baseUrl}/empresas/nfes`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[payments] eNotas invoice request failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as ENotasInvoiceResponse;
    return this.#mapInvoice(data);
  }

  async find(invoiceId: string): Promise<Invoice | null> {
    const response = await fetch(`${this.#baseUrl}/nfes/${encodeURIComponent(invoiceId)}`, {
      headers: { Authorization: `Bearer ${this.#apiKey}` },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[payments] eNotas invoice request failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as ENotasInvoiceResponse;
    return this.#mapInvoice(data);
  }

  #mapInvoice(data: ENotasInvoiceResponse): Invoice {
    const status = data.status ?? '';
    const normalized: Invoice['status'] =
      status === 'AUTORIZADO' || status === 'AUTORIZADA'
        ? 'issued'
        : status === 'CANCELADO' || status === 'REJEITADO'
          ? 'canceled'
          : 'pending';
    return {
      id: data.id ?? data.numero ?? String(Math.random()),
      gatewayId: data.id ?? data.numero ?? '',
      provider: this.provider,
      ...(data.numero !== undefined ? { number: data.numero } : {}),
      ...(data.urlDanfe !== undefined ? { url: data.urlDanfe, hostedPdfUrl: data.urlDanfe } : {}),
      status: normalized,
      ...(data.dataEmissao !== undefined ? { issuedAt: data.dataEmissao } : {}),
      amount: { amount: Math.round(Number(data.valor ?? 0) * 100), currency: 'brl' },
      createdAt: data.dataEmissao ?? new Date().toISOString(),
      payload: data as unknown as Record<string, unknown>,
    };
  }
}
