import { fromDecimal, toDecimal } from '../../money.js';
import type { Invoice } from '../../types.js';
import type {
  InvoiceCancelOptions,
  InvoiceEmitInput,
  InvoiceProvider,
} from '../invoice_provider.js';

export interface AsaasInvoiceConfig {
  /** Asaas API key. Defaults to `env.get('ASAAS_API_KEY')`. */
  apiKey?: string;
  /** Use the Asaas sandbox environment. Defaults to `NODE_ENV !== 'production'`. */
  sandbox?: boolean;
}

/** `InvoiceGetResponseInvoiceStatus` in Asaas' reference. */
type AsaasInvoiceStatus =
  | 'SCHEDULED'
  | 'SYNCHRONIZED'
  | 'AUTHORIZED'
  | 'PROCESSING_CANCELLATION'
  | 'CANCELED'
  | 'CANCELLATION_DENIED'
  | 'ERROR';

/** `InvoiceGetResponseDTO` — the fields this driver reads. The whole object is kept in `payload`. */
export interface AsaasInvoiceResponse {
  id: string;
  status?: AsaasInvoiceStatus | string;
  customer?: string | null;
  payment?: string | null;
  installment?: string | null;
  statusDescription?: string | null;
  serviceDescription?: string | null;
  pdfUrl?: string | null;
  xmlUrl?: string | null;
  number?: string | null;
  validationCode?: string | null;
  value?: number;
  deductions?: number;
  /** `YYYY-MM-DD`. */
  effectiveDate?: string | null;
  observations?: string | null;
  externalReference?: string | null;
}

interface AsaasListResponse<T> {
  data?: T[];
}

/** Today in Brasília, `YYYY-MM-DD` — the date Asaas' fiscal calendar runs on, not the process's. */
function todayInBrasilia(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * The normalized status of an Asaas NFS-e.
 *
 * `PROCESSING_CANCELLATION` and `CANCELLATION_DENIED` stay `issued`: the note is still valid
 * at the city hall until `CANCELED` says otherwise. `ERROR` is `failed` — the note was not
 * authorized and `statusDescription` says why.
 */
export function mapAsaasInvoiceStatus(status: string | undefined): Invoice['status'] {
  switch (status) {
    case 'AUTHORIZED':
    case 'PROCESSING_CANCELLATION':
    case 'CANCELLATION_DENIED':
      return 'issued';
    case 'CANCELED':
      return 'canceled';
    case 'ERROR':
      return 'failed';
    default:
      // SCHEDULED, SYNCHRONIZED, or a status this driver does not know yet.
      return 'pending';
  }
}

/**
 * Asaas native NFS-e invoice provider — emits the fiscal note through Asaas's own
 * invoice API (`/v3/invoices`), so a charge through Asaas with `invoice: true` uses the
 * same gateway that took the payment. Uses `fetch` directly (no SDK dependency).
 *
 * `POST /v3/invoices` SCHEDULES the note for `effectiveDate`; it does not mean the city hall
 * authorized it. The returned invoice is `pending` until the `INVOICE_AUTHORIZED` webhook
 * (`nfse.authorized` through the Asaas payments driver) or a later {@link find} says
 * `issued`.
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
    const body = this.#buildBody(input);

    // Idempotency. Asaas has no idempotency key on `POST /invoices`, but it stores and
    // filters by `externalReference`; a retry of an emit that reached Asaas (timeout,
    // crash after the response) would otherwise schedule a SECOND legal document. A
    // cancelled or failed (`ERROR`) note does not count — re-emitting after one is the point.
    if (input.externalReference !== undefined) {
      const existing = await this.#findLiveByReference(input.externalReference);
      if (existing) return this.#mapInvoice(existing);
    }

    const data = await this.#request<AsaasInvoiceResponse>('/invoices', {
      method: 'POST',
      body,
    });
    return this.#mapInvoice(data);
  }

  async find(invoiceId: string): Promise<Invoice | null> {
    const data = await this.#request<AsaasInvoiceResponse>(
      `/invoices/${encodeURIComponent(invoiceId)}`,
      { allowNotFound: true },
    );
    return data === null ? null : this.#mapInvoice(data);
  }

  /**
   * `POST /v3/invoices/{id}/cancel`. The cancellation goes through the city hall unless
   * `providerOnly` (Asaas' `cancelOnlyOnAsaas`); follow `nfse.canceled` /
   * `nfse.cancellation_denied` for the outcome. `reason` is not sent: Asaas' cancel endpoint
   * takes no justification.
   */
  async cancel(invoiceId: string, options: InvoiceCancelOptions = {}): Promise<Invoice> {
    const data = await this.#request<AsaasInvoiceResponse>(
      `/invoices/${encodeURIComponent(invoiceId)}/cancel`,
      {
        method: 'POST',
        body: options.providerOnly !== undefined ? { cancelOnlyOnAsaas: options.providerOnly } : {},
      },
    );
    return this.#mapInvoice(data);
  }

  /**
   * The `InvoiceSaveRequestDTO` body.
   *
   * Asaas identifies the recipient by the CHARGE (`payment`) or by ITS OWN customer id
   * (`customer`, `cus_…`) — the CPF/CNPJ is not accepted there. The charge only counts when
   * it was taken by Asaas: an id from another gateway means nothing to Asaas.
   */
  #buildBody(input: InvoiceEmitInput): Record<string, unknown> {
    const paymentId =
      input.payment !== undefined && input.payment.provider === this.provider
        ? input.payment.gatewayId
        : undefined;
    const customerId = input.customer.gatewayId;
    if (paymentId === undefined && customerId === undefined) {
      throw new Error(
        '[payments] Asaas invoices need the Asaas charge (`payment` from an Asaas charge) or the Asaas customer id (`customer.gatewayId`, `cus_…`). Asaas does not accept the CPF/CNPJ as the customer.',
      );
    }

    const municipalServiceCode = input.service.cityServiceCode ?? input.service.code;
    return {
      ...(paymentId !== undefined ? { payment: paymentId } : {}),
      ...(customerId !== undefined ? { customer: customerId } : {}),
      serviceDescription: input.service.description,
      // Required by Asaas; an empty string when the caller has nothing to add.
      observations: input.observations ?? '',
      ...(input.externalReference !== undefined
        ? { externalReference: input.externalReference }
        : {}),
      value: toDecimal(input.amount, input.currency),
      deductions: toDecimal(input.deductions ?? 0, input.currency),
      effectiveDate: input.effectiveDate ?? todayInBrasilia(),
      ...(input.service.municipalServiceId !== undefined
        ? { municipalServiceId: input.service.municipalServiceId }
        : {}),
      ...(municipalServiceCode !== undefined ? { municipalServiceCode } : {}),
      // Listed as required in the request schema, while its description says Asaas falls back
      // to the code. Sending the code ourselves makes that fallback explicit.
      ...(input.service.municipalServiceName !== undefined
        ? { municipalServiceName: input.service.municipalServiceName }
        : municipalServiceCode !== undefined
          ? { municipalServiceName: municipalServiceCode }
          : {}),
      taxes: this.#buildTaxes(input),
    };
  }

  /**
   * `InvoiceTaxesRequestDTO`. Asaas requires `retainIss`, `iss`, `pis`, `cofins`, `csll`,
   * `inss` and `ir`. The retentions default to "none" (`false` / `0`), the common case; the
   * ISS rate does NOT default — a wrong rate prints a wrong legal document, so a missing one
   * is refused here instead of being sent as 0. Any other key the caller passes (`nbsCode`,
   * the tax-reform fields) goes through as-is.
   */
  #buildTaxes(input: InvoiceEmitInput): Record<string, unknown> {
    const tax = input.tax ?? {};
    if (typeof tax.iss !== 'number') {
      throw new Error(
        '[payments] Asaas invoices need the ISS rate: pass `tax.iss` (percent, e.g. 2 for 2%) on the invoice option.',
      );
    }
    return {
      ...tax,
      retainIss: tax.retainIss ?? false,
      iss: tax.iss,
      pis: tax.pis ?? 0,
      cofins: tax.cofins ?? 0,
      csll: tax.csll ?? 0,
      inss: tax.inss ?? 0,
      ir: tax.ir ?? 0,
    };
  }

  async #findLiveByReference(reference: string): Promise<AsaasInvoiceResponse | null> {
    const list = await this.#request<AsaasListResponse<AsaasInvoiceResponse>>(
      `/invoices?externalReference=${encodeURIComponent(reference)}&limit=100`,
    );
    // Cancelled and ERROR notes are terminal and not valid documents: re-emitting after
    // either is the retry the caller is asking for.
    return (
      (list.data ?? []).find(
        (invoice) => invoice.status !== 'CANCELED' && invoice.status !== 'ERROR',
      ) ?? null
    );
  }

  async #request<T>(
    path: string,
    options: { method?: string; body?: unknown; allowNotFound: true },
  ): Promise<T | null>;
  async #request<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T>;
  async #request<T>(
    path: string,
    options: { method?: string; body?: unknown; allowNotFound?: boolean } = {},
  ): Promise<T | null> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        access_token: this.#apiKey,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    if (options.allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[payments] Asaas invoice request failed (${response.status}): ${text}`);
    }
    return (await response.json()) as T;
  }

  #mapInvoice(data: AsaasInvoiceResponse): Invoice {
    const status = mapAsaasInvoiceStatus(data.status);
    return {
      id: data.id,
      gatewayId: data.id,
      provider: this.provider,
      ...(data.customer ? { customerId: data.customer } : {}),
      status,
      ...(data.number ? { number: data.number } : {}),
      ...(data.pdfUrl ? { hostedPdfUrl: data.pdfUrl } : {}),
      ...(status === 'issued' && data.effectiveDate ? { issuedAt: data.effectiveDate } : {}),
      amount: { amount: fromDecimal(Number(data.value ?? 0), 'brl'), currency: 'brl' },
      createdAt: new Date().toISOString(),
      payload: data as unknown as Record<string, unknown>,
    };
  }
}
