import type { Invoice, InvoiceOptions } from '../types.js';

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
}

export interface InvoiceEmitInput {
  /** The billing customer's data (name, taxId, address...). */
  customer: {
    name?: string;
    taxId: string;
    email?: string;
    address?: Record<string, unknown>;
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
  };
  /** Tax configuration (ISS, etc.). */
  tax?: Record<string, unknown>;
  /** The gateway payment this invoice is attached to, when available. */
  payment?: {
    gatewayId: string;
    provider: string;
  };
  /** Extra provider-specific fields. */
  metadata?: Record<string, unknown>;
}

export type { Invoice, InvoiceOptions };
