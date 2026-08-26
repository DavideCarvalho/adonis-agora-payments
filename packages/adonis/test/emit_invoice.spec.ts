import { describe, expect, it } from 'vitest';
import type { Invoice, InvoiceProvider } from '../src/index.js';
import { emitInvoice } from '../src/invoice/emit_invoice.js';

function fakeProvider(name: string): InvoiceProvider {
  const calls: { input: Parameters<InvoiceProvider['emit']>[0] }[] = [];
  return {
    provider: name,
    emit: async (input) => {
      calls.push({ input });
      const invoice: Invoice = {
        id: `inv_${name}`,
        gatewayId: `inv_${name}`,
        provider: name,
        status: 'issued',
        number: '1',
        amount: { amount: input.amount, currency: input.currency },
        createdAt: new Date().toISOString(),
        payload: {},
      };
      (invoice as unknown as { calls: typeof calls }).calls = calls;
      return invoice;
    },
    find: async () => null,
  };
}

describe('emitInvoice', () => {
  it('uses the named invoice provider (payment via one, invoice via another)', async () => {
    const focus = fakeProvider('focus');
    const tecnospeed = fakeProvider('tecnospeed');
    const ctx = { invoice: (name?: string) => (name === 'tecnospeed' ? tecnospeed : focus) };

    const invoice = await emitInvoice(ctx, 'tecnospeed', {
      customer: { taxId: '12345678000100' },
      amount: 1990,
      currency: 'brl',
      payment: { gatewayId: 'pay_1', provider: 'woovi' },
    });

    expect(invoice?.provider).toBe('tecnospeed');
    const calls = (
      invoice as unknown as { calls: { input: Parameters<InvoiceProvider['emit']>[0] }[] }
    ).calls;
    expect(calls[0]!.input.payment).toEqual({ gatewayId: 'pay_1', provider: 'woovi' });
  });

  it('uses the default provider when invoice is true', async () => {
    const focus = fakeProvider('focus');
    const ctx = { invoice: (name?: string) => (name === undefined ? focus : fakeProvider(name)) };
    const invoice = await emitInvoice(ctx, true, {
      customer: { taxId: '123' },
      amount: 500,
      currency: 'brl',
    });
    expect(invoice?.provider).toBe('focus');
  });

  it('returns undefined when invoice is not requested', async () => {
    const ctx = { invoice: (name?: string) => fakeProvider(name ?? 'focus') };
    expect(
      await emitInvoice(ctx, undefined, { customer: { taxId: '1' }, amount: 1, currency: 'brl' }),
    ).toBeUndefined();
    expect(
      await emitInvoice(ctx, false, { customer: { taxId: '1' }, amount: 1, currency: 'brl' }),
    ).toBeUndefined();
  });

  it('throws a helpful error when no invoice provider is configured', async () => {
    const ctx = { invoice: undefined };
    await expect(
      emitInvoice(ctx, true, { customer: { taxId: '1' }, amount: 1, currency: 'brl' }),
    ).rejects.toThrow(/no invoice provider is configured/);
  });
});
