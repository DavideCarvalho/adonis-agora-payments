import type { Invoice, InvoiceOptions, InvoiceTaxes } from '../types.js';

/** Context handed to invoice provider factories. */
export interface InvoiceContext {
  config: () => unknown;
}

/**
 * The invoice emission provider contract. Gateways that emit invoices natively and
 * dedicated providers (Focus, Tecnospeed, eNotas, PlugNotas) implement this so a charge
 * call with `invoice: true` can emit an invoice no matter which gateway backs the payment.
 */
export interface InvoiceProvider {
  readonly provider: string;

  /** Emit an invoice. Returns the issued/pending invoice. */
  emit(input: InvoiceEmitInput): Promise<Invoice>;

  /** Look up an issued invoice by its id at the provider. */
  find(invoiceId: string): Promise<Invoice | null>;

  /**
   * Ask the provider to cancel an invoice. Cancelling a fiscal invoice usually depends on
   * the city hall, so the returned invoice may still be `issued` while the cancellation is
   * processed — follow the provider's webhook (Asaas: `nfse.canceled` /
   * `nfse.cancellation_denied`) for the outcome.
   *
   * Providers whose cancellation is not implemented throw a `[payments] … not supported`
   * error rather than pretending the invoice was cancelled.
   */
  cancel(invoiceId: string, options?: InvoiceCancelOptions): Promise<Invoice>;
}

export interface InvoiceCancelOptions {
  /** Why the invoice is being cancelled (providers that take a justification send it). */
  reason?: string;
  /**
   * Cancel only at the provider, without asking the city hall (Asaas: `cancelOnlyOnAsaas`).
   * For a note the city hall already cancelled by other means.
   */
  providerOnly?: boolean;
}

export interface InvoiceEmitInput {
  /** The billing customer's data (name, taxId, address...). */
  customer: {
    name?: string;
    taxId: string;
    email?: string;
    address?: Record<string, unknown>;
    /**
     * The customer's id AT THE INVOICE PROVIDER, when it has its own customer records
     * (Asaas: `cus_…`). Asaas identifies the recipient by this id or by the charge
     * (`payment`) — never by the CPF/CNPJ.
     */
    gatewayId?: string;
  };
  /** Amount in the currency's smallest unit (e.g. cents). */
  amount: number;
  currency: string;
  /** Service details for service invoices. */
  service: {
    description: string;
    /** Service code. */
    code?: string;
    /** Municipal service code. */
    cityServiceCode?: string;
    /** The provider's own id of the municipal service (Asaas: `municipalServiceId`). */
    municipalServiceId?: string;
    /** The municipal service's name (Asaas: `municipalServiceName`). */
    municipalServiceName?: string;
  };
  /** Tax configuration (ISS, retentions, etc.). */
  tax?: InvoiceTaxes;
  /**
   * The issue date (`YYYY-MM-DD`). Providers that schedule emission (Asaas) emit on this
   * date; defaults to today in Brasília.
   */
  effectiveDate?: string;
  /**
   * Deductions in the currency's smallest unit. They do not change the invoice total; they
   * reduce the ISS base. Defaults to 0.
   */
  deductions?: number;
  /** Free-text observations printed on the invoice. */
  observations?: string;
  /**
   * Your own id for this invoice. Providers that support it store it, and the Asaas driver
   * also uses it for idempotency: an emit with a reference that already has a live
   * (non-cancelled) invoice returns that invoice instead of creating a second one.
   */
  externalReference?: string;
  /** The gateway payment this invoice is attached to, when available. */
  payment?: {
    gatewayId: string;
    provider: string;
  };
  /** Extra provider-specific fields. */
  metadata?: Record<string, unknown>;
}

export type { Invoice, InvoiceOptions, InvoiceTaxes };
