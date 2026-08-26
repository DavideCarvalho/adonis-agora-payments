import { describe, expect, it } from 'vitest';
import { WebhookProcessor } from '../src/billing/webhook_processor.js';
import { AbacateDriver } from '../src/drivers/abacate.js';
import { AsaasDriver } from '../src/drivers/asaas.js';
import { WooviDriver } from '../src/drivers/woovi.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

/**
 * Contract tests: a real driver's `parseWebhook` output fed into the `WebhookProcessor`
 * must sync the store. This closes the exact-string coupling between the drivers'
 * `#mapWebhookType` and the processor's `#runBuiltIn` switch — a drift used to pass the
 * whole suite silently.
 */
describe('driver → processor contract', () => {
  it('Asaas PAYMENT_RECEIVED syncs a paid payment row', async () => {
    const driver = new AsaasDriver({ config: () => ({}) }, { apiKey: 'test', sandbox: true });
    const raw = JSON.stringify({
      event: 'PAYMENT_RECEIVED',
      payment: {
        id: 'pay_1',
        customer: 'cus_1',
        value: 19.9,
        billingType: 'PIX',
        status: 'RECEIVED',
        dueDate: '2026-01-10',
        externalReference: 'payment_abc',
      },
    });
    const event = driver.parseWebhook(raw, {});

    const store = new InMemoryBillingStore();
    const processor = new WebhookProcessor({ store, driver });
    await processor.process(event);

    const row = await store.findPaymentByGatewayId('pay_1');
    expect(row?.status).toBe('paid');
    expect(row?.amount).toBe(1990);
    expect(row?.currency).toBe('brl');
  });

  it('Asaas SUBSCRIPTION_CREATED syncs a subscription row', async () => {
    const driver = new AsaasDriver({ config: () => ({}) }, { apiKey: 'test', sandbox: true });
    const raw = JSON.stringify({
      event: 'SUBSCRIPTION_CREATED',
      subscription: {
        id: 'sub_1',
        customer: 'cus_1',
        status: 'ACTIVE',
        billingType: 'PIX',
        value: 49.9,
        cycle: 'MONTHLY',
        nextDueDate: '2026-02-01',
      },
    });
    const event = driver.parseWebhook(raw, {});

    const store = new InMemoryBillingStore();
    const processor = new WebhookProcessor({ store, driver });
    await processor.process(event);

    const row = await store.findSubscriptionByGatewayId('sub_1');
    expect(row?.status).toBe('active');
    expect(row?.customerId).toBe('cus_1');
  });

  it('AbacatePay checkout.completed maps but raw payload is rejected by the shape guard', async () => {
    const driver = new AbacateDriver({ config: () => ({}) }, { apiKey: 'test', publicKey: 'pk' });
    const raw = JSON.stringify({
      id: 'log_1',
      event: 'checkout.completed',
      data: { id: 'bill_1', status: 'PAID' },
    });
    // AbacatePay signs with the public key — build the expected signature.
    const { createHmac } = await import('node:crypto');
    const signature = createHmac('sha256', 'pk').update(raw, 'utf8').digest('base64');
    const event = driver.parseWebhook(raw, { 'x-webhook-signature': signature });

    const store = new InMemoryBillingStore();
    const processor = new WebhookProcessor({ store, driver });
    // AbacatePay's webhook data is the raw payload (no normalized gatewayId) — the
    // processor must reject it instead of writing a garbage row.
    await expect(processor.process(event)).rejects.toThrow(/Malformed/);
    const ledger = [...store.webhookEvents.values()][0]!;
    expect(ledger.status).toBe('failed');
  });

  it('Woovi PIX_AUTOMATIC_APPROVED maps but raw payload is rejected by the shape guard', async () => {
    const driver = new WooviDriver({ config: () => ({}) }, { appId: 'test' });
    const raw = JSON.stringify({
      event: 'PIX_AUTOMATIC_APPROVED',
      correlationID: 'corr_1',
      value: 100,
      status: 'ACTIVE',
      globalID: 'sub_1',
    });
    const event = driver.parseWebhook(raw, {});

    const store = new InMemoryBillingStore();
    const processor = new WebhookProcessor({ store, driver });
    await expect(processor.process(event)).rejects.toThrow(/Malformed/);
    const ledger = [...store.webhookEvents.values()][0]!;
    expect(ledger.status).toBe('failed');
  });
});
