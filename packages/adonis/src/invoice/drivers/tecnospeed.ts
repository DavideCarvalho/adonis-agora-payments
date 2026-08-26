import type { Invoice } from '../../types.js';
import type { InvoiceEmitInput, InvoiceProvider } from '../invoice_provider.js';

export interface TecnospeedInvoiceConfig {
  /** Tecnospeed API token. Defaults to `env.get('TECNOSPEED_TOKEN')`. */
  token?: string;
  /**
   * Tecnospeed API base URL. The NFS-e API is per-municipality (and the national layout
   * moved to an XML DPS at `https://tributario.speedgov.com.br/{municipio}/api/v1`), so
   * point this at your municipality/plan endpoint. Defaults to the generic v1 base.
   */
  baseUrl?: string;
}

interface TecnospeedInvoiceResponse {
  id?: string;
  numero?: string;
  status?: string;
  chave?: string;
  url?: string;
  valor?: number;
}

/**
 * Tecnospeed invoice provider — NFS-e across municipalities. Uses `fetch` directly (no
 * SDK dependency). The exact JSON layout varies per municipality and standard (Tecnospeed
 * also offers an XML DPS flow and steers toward PlugNotas for JSON NFS-e) — this adapter
 * sends the common JSON shape and normalizes the response; if your municipality differs,
 * extend this driver (see Custom providers).
 */
export class TecnospeedInvoiceProvider implements InvoiceProvider {
  readonly provider = 'tecnospeed';

  #token: string;
  #baseUrl: string;

  constructor(_ctx: { config: () => unknown }, config: TecnospeedInvoiceConfig = {}) {
    const token = config.token ?? process.env.TECNOSPEED_TOKEN;
    if (!token) {
      throw new Error(
        '[payments] Tecnospeed invoice provider requires a token. Set `TECNOSPEED_TOKEN` env or pass `token` to `invoice.tecnospeed()`.',
      );
    }
    this.#token = token;
    this.#baseUrl = config.baseUrl ?? 'https://api-tecnospeed.com.br/v1';
  }

  async emit(input: InvoiceEmitInput): Promise<Invoice> {
    const body = {
      tomador: {
        cpf_cnpj: input.customer.taxId.replace(/\D/g, ''),
        razao_social: input.customer.name ?? 'Cliente',
        ...(input.customer.email !== undefined ? { email: input.customer.email } : {}),
        ...(input.customer.address !== undefined ? { endereco: input.customer.address } : {}),
      },
      servico: {
        descricao: input.service.description,
        ...(input.service.code !== undefined ? { codigo_servico: input.service.code } : {}),
        ...(input.service.cityServiceCode !== undefined
          ? { codigo_servico_municipio: input.service.cityServiceCode }
          : {}),
      },
      valor: input.amount / 100,
      ...(input.tax !== undefined ? { impostos: input.tax } : {}),
    };

    const response = await fetch(`${this.#baseUrl}/nfse`, {
      method: 'POST',
      headers: {
        Authorization: this.#token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[payments] Tecnospeed invoice request failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as TecnospeedInvoiceResponse;
    return this.#mapInvoice(data);
  }

  async find(invoiceId: string): Promise<Invoice | null> {
    const response = await fetch(`${this.#baseUrl}/nfse/${encodeURIComponent(invoiceId)}`, {
      headers: { Authorization: this.#token },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[payments] Tecnospeed invoice request failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as TecnospeedInvoiceResponse;
    return this.#mapInvoice(data);
  }

  #mapInvoice(data: TecnospeedInvoiceResponse): Invoice {
    const status = data.status ?? '';
    const normalized: Invoice['status'] =
      status === 'autorizado' || status === 'AUTORIZADO' || status === 'emitido'
        ? 'issued'
        : status === 'cancelado' || status === 'CANCELADO' || status === 'rejeitado'
          ? 'canceled'
          : 'pending';
    return {
      id: data.id ?? data.chave ?? data.numero ?? String(Math.random()),
      gatewayId: data.id ?? data.chave ?? data.numero ?? '',
      provider: this.provider,
      ...(data.numero !== undefined ? { number: data.numero } : {}),
      ...(data.chave !== undefined ? { key: data.chave } : {}),
      ...(data.url !== undefined ? { url: data.url, hostedPdfUrl: data.url } : {}),
      status: normalized,
      amount: { amount: Math.round(Number(data.valor ?? 0) * 100), currency: 'brl' },
      createdAt: new Date().toISOString(),
      payload: data as unknown as Record<string, unknown>,
    };
  }
}
