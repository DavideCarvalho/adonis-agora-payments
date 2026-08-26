import type { Invoice } from '../../types.js';
import type { InvoiceEmitInput, InvoiceProvider } from '../invoice_provider.js';

export interface FocusInvoiceConfig {
  /** Focus NFe API token. Defaults to `env.get('FOCUS_NFE_TOKEN')`. */
  token?: string;
  /** Focus NFe API URL. Defaults to the production endpoint. */
  baseUrl?: string;
}

interface FocusInvoiceResponse {
  ref?: string;
  numero?: string;
  status?: string;
  caminho_danfe?: string;
  chave?: string;
  valor?: string;
  data_emissao?: string;
}

/**
 * Focus NFe invoice provider — REST API for electronic invoices across hundreds of
 * municipalities. Uses `fetch` directly (no SDK dependency), so Focus is not a peer
 * dependency. (The `NFe`/`nfse` names below are Focus's own API identifiers.)
 */
export class FocusInvoiceProvider implements InvoiceProvider {
  readonly provider = 'focus';

  #token: string;
  #baseUrl: string;

  constructor(_ctx: { config: () => unknown }, config: FocusInvoiceConfig = {}) {
    const token = config.token ?? process.env.FOCUS_NFE_TOKEN;
    if (!token) {
      throw new Error(
        '[payments] Focus invoice provider requires a token. Set `FOCUS_NFE_TOKEN` env or pass `token` to `invoice.focus()`.',
      );
    }
    this.#token = token;
    this.#baseUrl = config.baseUrl ?? 'https://api.focusnfe.com.br';
  }

  async emit(input: InvoiceEmitInput): Promise<Invoice> {
    // Focus service-invoice endpoint.
    const body = {
      tomador: {
        cpf_cnpj: input.customer.taxId.replace(/\D/g, ''),
        nome: input.customer.name ?? 'Cliente',
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
      valor: (input.amount / 100).toFixed(2),
      ...(input.tax !== undefined ? { impostos: input.tax } : {}),
      ...(input.metadata !== undefined ? { metadados: input.metadata } : {}),
    };

    const response = await fetch(`${this.#baseUrl}/v2/nfse`, {
      method: 'POST',
      headers: {
        Authorization: this.#token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[payments] Focus NFe request failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as FocusInvoiceResponse;
    return this.#mapInvoice(data);
  }

  async find(invoiceId: string): Promise<Invoice | null> {
    const response = await fetch(`${this.#baseUrl}/v2/nfse/${encodeURIComponent(invoiceId)}`, {
      headers: { Authorization: this.#token },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[payments] Focus NFe request failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as FocusInvoiceResponse;
    return this.#mapInvoice(data);
  }

  #mapInvoice(data: FocusInvoiceResponse): Invoice {
    const status = data.status ?? 'pendente';
    const normalized: Invoice['status'] =
      status === 'autorizado'
        ? 'issued'
        : status === 'cancelado' || status === 'rejeitado'
          ? 'canceled'
          : 'pending';
    return {
      id: data.ref ?? data.numero ?? String(Math.random()),
      gatewayId: data.ref ?? data.numero ?? '',
      provider: this.provider,
      number: data.numero ?? '',
      ...(data.chave !== undefined ? { key: data.chave } : {}),
      ...(data.caminho_danfe !== undefined
        ? { url: data.caminho_danfe, hostedPdfUrl: data.caminho_danfe }
        : {}),
      status: normalized,
      ...(data.data_emissao !== undefined ? { issuedAt: data.data_emissao } : {}),
      amount: { amount: Math.round(Number(data.valor ?? 0) * 100), currency: 'brl' },
      createdAt: data.data_emissao ?? new Date().toISOString(),
      payload: data as unknown as Record<string, unknown>,
    };
  }
}
