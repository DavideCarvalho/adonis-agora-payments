/**
 * The error a provider throws for a cancellation it does not implement. A fiscal invoice
 * that is still valid at the city hall must never read as cancelled, so this refuses
 * loudly instead of returning the invoice unchanged.
 */
export function unsupportedInvoiceCancel(provider: string): Error {
  return new Error(
    `[payments] Cancelling an invoice is not supported by the "${provider}" invoice provider. Cancel it in the provider's dashboard.`,
  );
}
