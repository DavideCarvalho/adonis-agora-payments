import { describe, expect, it } from 'vitest';
import type { Invoice, InvoiceProvider } from '../src/index.js';
import { emitInvoice, emitInvoiceIfRequested } from '../src/invoice/emit_invoice.js';

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

describe('a failing invoice provider', () => {
  /**
   * The charge already exists at the gateway by the time the invoice is emitted. A throwing
   * provider used to propagate out of `charge()`, so the caller saw a rejected call over
   * money that had been taken — and the obvious response to a failed charge is to charge
   * again.
   */
  it('does not fail the charge that already went through', async () => {
    const ctx = {
      config: () => ({
        invoice: {
          default: 'boom',
          providers: {
            boom: () => ({
              provider: 'boom',
              emit: async () => {
                throw new Error('SEFAZ timed out');
              },
            }),
          },
        },
      }),
    } as never;

    const payment = {
      id: 'pi_1',
      gatewayId: 'pi_1',
      provider: 'stripe',
      amount: { amount: 1990, currency: 'brl' },
      status: 'paid' as const,
      createdAt: new Date().toISOString(),
    };

    await expect(
      emitInvoiceIfRequested(ctx, { invoice: true }, payment, { provider: 'stripe' }),
    ).resolves.toBeUndefined();
    // And the payment keeps saying what is true: it was charged, and it has no invoice.
    expect((payment as { invoice?: unknown }).invoice).toBeUndefined();
  });

  it('publishes invoice.failed so a missing NFS-e is not silent', async () => {
    // Swallowing without publishing would trade one bad failure for a worse one: in Brazil a
    // fiscal invoice is a legal obligation, and nothing else would ever mention it.
    const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
    const global = globalThis as Record<symbol, unknown>;
    const previous = global[EMIT_SLOT];
    const seen: unknown[] = [];
    global[EMIT_SLOT] = (lib: string, event: string, payload: unknown) =>
      seen.push({ lib, event, payload });

    try {
      const ctx = {
        config: () => ({
          invoice: {
            default: 'boom',
            providers: {
              boom: () => ({
                provider: 'boom',
                emit: async () => {
                  throw new Error('SEFAZ timed out');
                },
              }),
            },
          },
        }),
      } as never;

      await emitInvoiceIfRequested(
        ctx,
        { invoice: true },
        {
          id: 'pi_1',
          gatewayId: 'pi_1',
          provider: 'stripe',
          amount: { amount: 1990, currency: 'brl' },
          status: 'paid' as const,
          createdAt: new Date().toISOString(),
        },
        { provider: 'stripe' },
      );

      // The gateway id is the load-bearing field: it names the charge that exists and has
      // no invoice, which is the only thing a human needs to go fix it.
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        lib: 'payments',
        event: 'invoice.failed',
        payload: { gatewayId: 'pi_1', provider: 'stripe' },
      });
      expect((seen[0] as { payload: { error: string } }).payload.error).toBeTypeOf('string');
    } finally {
      if (previous === undefined) delete global[EMIT_SLOT];
      else global[EMIT_SLOT] = previous;
    }
  });
});
