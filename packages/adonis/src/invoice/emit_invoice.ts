import { publishInvoiceEmittedDiagnostics } from '../diagnostics.js';
import type { ChargeInput, PaymentsDriver } from '../driver.js';
import type { InvoiceOptions, Payment } from '../types.js';
import type { InvoiceProvider } from './invoice_provider.js';

/** The invoice-resolution surface a payment driver receives (from the factory ctx). */
export interface EmitInvoiceContext {
  /** Resolve an invoice provider by name; falls back to the configured default. */
  invoice?: (name?: string) => InvoiceProvider;
}

export interface EmitInvoiceData {
  /** The billing customer's fiscal data. */
  customer: {
    name?: string;
    taxId: string;
    email?: string;
    address?: Record<string, unknown>;
  };
  /** Amount in the currency's smallest unit (e.g. cents). */
  amount: number;
  currency: string;
  /** The gateway payment this invoice is attached to, when available. */
  payment?: {
    gatewayId: string;
    provider: string;
  };
}

/**
 * Emit an invoice for a charge when the call asked for one. The `invoice` option on a
 * charge/subscription/checkout resolves the provider by NAME, independent of the payment
 * gateway:
 *
 * - `true` — use the default invoice provider from `config.invoice.providers`.
 * - `'tecnospeed'` — use the named invoice provider (a key of `invoice.providers`).
 * - `{ provider?, ... }` — named provider (or default) with these overrides.
 *
 * Returns `undefined` when the call did not request an invoice.
 */
export async function emitInvoice(
  ctx: EmitInvoiceContext,
  option: boolean | string | InvoiceOptions | undefined,
  data: EmitInvoiceData,
): Promise<ReturnType<InvoiceProvider['emit']> | undefined> {
  if (option === undefined || option === false) return undefined;

  const providerName =
    typeof option === 'string' ? option : typeof option === 'object' ? option.provider : undefined;
  const provider = ctx.invoice?.(providerName);
  if (!provider) {
    throw new Error(
      '[payments] invoice was requested but no invoice provider is configured. ' +
        'Add `invoice.providers` to config/payments.ts (and an `invoice.default`).',
    );
  }

  const overrides = typeof option === 'object' ? option : {};
  return provider.emit({
    customer: {
      ...data.customer,
      ...(overrides.customer !== undefined ? overrides.customer : {}),
    },
    amount: data.amount,
    currency: data.currency,
    service: {
      description: 'Payment',
      ...(overrides.service !== undefined ? overrides.service : {}),
    },
    ...(overrides.tax !== undefined ? { tax: overrides.tax } : {}),
    ...(data.payment !== undefined ? { payment: data.payment } : {}),
    ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
  });
}

/**
 * The per-driver charge helper: when `input.invoice` is present, resolve the payer's
 * fiscal data from `input.customer` (falling back to `card.holder`), emit through the
 * configured invoice provider, and attach the result to the payment. One call replaces
 * the ~15-line block that used to be copy-pasted in every driver's `charge()`.
 */
export async function emitInvoiceIfRequested(
  ctx: EmitInvoiceContext,
  input: Pick<ChargeInput, 'invoice' | 'customer' | 'card'>,
  payment: Payment,
  driver: Pick<PaymentsDriver, 'provider'>,
): Promise<void> {
  if (input.invoice === undefined || input.invoice === false) return;

  const holder = input.card?.holder;
  const taxId = input.customer?.taxId ?? holder?.cpfCnpj ?? '';
  const name = input.customer?.name ?? holder?.name;
  const email = input.customer?.email ?? holder?.email;

  const invoice = await emitInvoice(ctx, input.invoice, {
    customer: {
      taxId,
      ...(name !== undefined ? { name } : {}),
      ...(email !== undefined ? { email } : {}),
    },
    amount: payment.amount.amount,
    currency: payment.amount.currency,
    payment: { gatewayId: payment.gatewayId, provider: driver.provider },
  });
  if (invoice) {
    payment.invoice = invoice;
    publishInvoiceEmittedDiagnostics({
      gatewayId: invoice.gatewayId,
      provider: invoice.provider,
      ...(invoice.number !== undefined ? { number: invoice.number } : {}),
      ...(invoice.hostedPdfUrl !== undefined ? { url: invoice.hostedPdfUrl } : {}),
    });
  }
}
