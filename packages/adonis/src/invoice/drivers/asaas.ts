import type { Invoice } from '../../types.js';
import type { InvoiceEmitInput, InvoiceProvider } from '../invoice_provider.js';

export interface AsaasInvoiceConfig {
  /** Asaas API key. Defaults to `env.get('ASAAS_API_KEY')`. */
  apiKey?: string;
  /** Use the Asaas sandbox environment. Defaults to `NODE_ENV !== 'production'`. */
  sandbox?: boolean;
}

interface AsaasInvoiceResponse {
  id: string;
  status?: string;
  nfseNumber?: string;
  nfseAccessKey?: string;
  invoiceUrl?: string;
  pdfUrl?: string;
  value?: number;
  payment?: string | null;
}

/**
 * Asaas native NFS-e invoice provider — emits the fiscal note through Asaas's own
 * invoice API (`/v3/invoices`), so a charge through Asaas with `invoice: true` uses the
 * same gateway that took the payment. Uses `fetch` directly (no SDK dependency).
 */
export class AsaasInvoiceProvider implements InvoiceProvider {
  readonly provider = 'asaas';

  #apiKey: string;
  #baseUrl: string;

  constructor(_ctx: { config: () => unknown }, config: AsaasInvoiceConfig = {}) {
    const apiKey = config.apiKey ?? process.env.ASAAS_API_KEY;
    if (!apiKey) {
      throw new Error(
        '[payments] Asaas invoice provider requires an API key. Set `ASAAS_API_KEY` env or pass `apiKey` to `invoice.asaas()`.',
      );
    }
    const sandbox = config.sandbox ?? process.env.NODE_ENV !== 'production';
    this.#baseUrl = sandbox ? 'https://api-sandbox.asaas.com/v3' : 'https://api.asaas.com/v3';
    this.#apiKey = apiKey;
  }

  async emit(input: InvoiceEmitInput): Promise<Invoice> {
    const body: Record<string, unknown> = {
      customer: input.customer.taxId.replace(/\D/g, ''),
      value: input.amount / 100,
      serviceDescription: input.service.description,
      ...(input.service.code !== undefined ? { serviceCode: input.service.code } : {}),
      ...(input.service.cityServiceCode !== undefined
        ? { municipalServiceCode: input.service.cityServiceCode }
        : {}),
      ...(input.customer.name !== undefined ? { description: input.customer.name } : {}),
      ...(input.customer.email !== undefined ? { notes: input.customer.email } : {}),
      ...(input.tax !== undefined ? { taxes: input.tax } : {}),
      ...(input.metadata !== undefined ? { observations: JSON.stringify(input.metadata) } : {}),
    };

    const response = await fetch(`${this.#baseUrl}/invoices`, {
      method: 'POST',
      headers: {
        access_token: this.#apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[payments] Asaas invoice request failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as AsaasInvoiceResponse;
    return this.#mapInvoice(data);
  }

  async find(invoiceId: string): Promise<Invoice | null> {
    const response = await fetch(`${this.#baseUrl}/invoices/${encodeURIComponent(invoiceId)}`, {
      headers: { access_token: this.#apiKey },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[payments] Asaas invoice request failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as AsaasInvoiceResponse;
    return this.#mapInvoice(data);
  }

  #mapInvoice(data: AsaasInvoiceResponse): Invoice {
    const status = data.status ?? 'PENDING';
    const normalized: Invoice['status'] =
      status === 'AUTHORIZED' || status === 'PAID'
        ? 'issued'
        : status === 'CANCELED' || status === 'REJECTED'
          ? 'canceled'
          : 'pending';
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      ...(data.nfseNumber !== undefined ? { number: data.nfseNumber } : {}),
      ...(data.nfseAccessKey !== undefined ? { key: data.nfseAccessKey } : {}),
      ...(data.invoiceUrl !== undefined
        ? { url: data.invoiceUrl, hostedPdfUrl: data.invoiceUrl }
        : {}),
      status: normalized,
      ...(data.pdfUrl !== undefined ? { hostedPdfUrl: data.pdfUrl } : {}),
      amount: { amount: Math.round(Number(data.value ?? 0) * 100), currency: 'brl' },
      createdAt: new Date().toISOString(),
      payload: data as unknown as Record<string, unknown>,
    };
  }
}
