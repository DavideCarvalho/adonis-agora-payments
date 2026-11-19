import { describe, expect, it } from 'vitest';
import { billingStores, defineConfig, invoice, payments } from '../src/define_config.js';

const STACK = Symbol.for('@adonis-agora/stack');
const uses = (value: unknown) => (value as Record<symbol, unknown>)[STACK];

describe('stack descriptors (telescope Architecture page)', () => {
  it('describes each gateway factory by the API it calls', () => {
    expect(uses(payments.stripe({ secretKey: 'sk_test' } as never))).toEqual([
      { tech: 'stripe', purpose: 'gateway' },
    ]);
    expect(uses(payments.asaas({ apiKey: 'k' }))).toEqual([{ tech: 'asaas', purpose: 'gateway' }]);
    expect(uses(payments.abacate())).toEqual([{ tech: 'abacatepay', purpose: 'gateway' }]);
    expect(uses(payments.mercadopago({ accessToken: 't' } as never))).toEqual([
      { tech: 'mercadopago', purpose: 'gateway' },
    ]);
    expect(uses(payments.when(true, () => payments.pagarme({} as never)))).toEqual([
      { tech: 'pagarme', purpose: 'gateway' },
    ]);
  });

  it('keeps the descriptor out of enumeration and never carries a key', () => {
    const factory = payments.stripe({ secretKey: 'sk_live_secret' } as never);
    expect(Object.keys(factory)).toEqual([]);
    expect(JSON.stringify(uses(factory))).not.toContain('sk_live_secret');
  });

  it('describes every built-in gateway with a valid tech', () => {
    const factories = Object.entries(payments).filter(([name]) => name !== 'when');
    expect(factories.length).toBe(18);
    for (const [, build] of factories) {
      const described = uses((build as (c: unknown) => object)({})) as Array<{ tech: string }>;
      expect(described).toHaveLength(1);
      expect(described[0]?.tech).toMatch(/^[a-z0-9][a-z0-9._-]{0,31}$/);
    }
  });

  it('describes invoice providers', () => {
    expect(uses(invoice.focus())).toEqual([{ tech: 'focusnfe', purpose: 'invoices' }]);
    expect(uses(invoice.asaas())).toEqual([{ tech: 'asaas', purpose: 'invoices' }]);
  });

  it('puts the billing connection on the billing section', () => {
    const config = defineConfig({ billing: { connection: 'hub' } });
    expect(uses(config.billing)).toEqual([{ tech: 'sql', connection: 'hub', purpose: 'billing' }]);
    expect(Object.keys(config.billing)).toEqual(['connection']);
  });

  it('describes nothing without a billing connection (the default connection is the app one)', () => {
    expect(uses(defineConfig({ billing: { enabled: true } }).billing)).toBeUndefined();
  });

  it('describes a Lucid store given its own connection', () => {
    expect(uses(billingStores.lucid({ connection: 'billing' }))).toEqual([
      { tech: 'sql', connection: 'billing', purpose: 'billing' },
    ]);
    expect(uses(billingStores.lucid())).toBeUndefined();
  });
});
