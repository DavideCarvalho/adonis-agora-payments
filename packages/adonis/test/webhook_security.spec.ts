import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AbacateDriver } from '../src/drivers/abacate.js';
import { AsaasDriver } from '../src/drivers/asaas.js';
import { WooviDriver } from '../src/drivers/woovi.js';

const ASAAS_BODY = JSON.stringify({
  event: 'PAYMENT_RECEIVED',
  payment: { id: 'p', status: 'RECEIVED', value: 1, billingType: 'PIX', dueDate: '2026-01-01' },
});
const WOOVI_BODY = JSON.stringify({ event: 'CHARGE_COMPLETED', id: 'charge_1' });
const ABACATE_BODY = JSON.stringify({ event: 'checkout.completed', data: { id: 'ck_1' } });

describe('webhook security', () => {
  it('Asaas: rejects a request with no token header when a token is configured', () => {
    const driver = new AsaasDriver(
      { config: () => ({}) },
      { apiKey: 'test', sandbox: true, webhookToken: 'tok' },
    );
    expect(() => driver.parseWebhook(ASAAS_BODY, {})).toThrow(/Missing webhook token/);
  });

  it('AbacatePay: rejects a tampered body', () => {
    const driver = new AbacateDriver(
      { config: () => ({}) },
      { apiKey: 'test', publicKey: 'pub-key' },
    );
    const signature = createHmac('sha256', 'pub-key').update('other-body').digest('base64');
    expect(() => driver.parseWebhook(ABACATE_BODY, { 'x-webhook-signature': signature })).toThrow(
      /signature/,
    );
  });

  it('AbacatePay: rejects a request with a missing signature header', () => {
    const driver = new AbacateDriver(
      { config: () => ({}) },
      { apiKey: 'test', publicKey: 'pub-key' },
    );
    expect(() => driver.parseWebhook(ABACATE_BODY, {})).toThrow(/signature/);
  });

  it('AbacatePay: accepts a valid HMAC-SHA256 signature', () => {
    const driver = new AbacateDriver(
      { config: () => ({}) },
      { apiKey: 'test', webhookSecret: 'pub-key' },
    );
    const signature = createHmac('sha256', 'pub-key').update(ABACATE_BODY, 'utf8').digest('base64');
    const event = driver.parseWebhook(ABACATE_BODY, { 'x-webhook-signature': signature });
    expect(event.type).toBe('payment.succeeded');
  });

  it('Woovi: accepts a valid per-webhook HMAC (X-OpenPix-Signature)', () => {
    const driver = new WooviDriver(
      { config: () => ({}) },
      { appId: 'test', webhookSecret: 'hmac-secret' },
    );
    const hmac = createHmac('sha1', 'hmac-secret').update(WOOVI_BODY, 'utf8').digest('base64');
    const event = driver.parseWebhook(WOOVI_BODY, { 'X-OpenPix-Signature': hmac });
    expect(event.type).toBe('payment.succeeded');
  });

  it('Woovi: rejects a bad per-webhook HMAC', () => {
    const driver = new WooviDriver(
      { config: () => ({}) },
      { appId: 'test', webhookSecret: 'hmac-secret' },
    );
    expect(() => driver.parseWebhook(WOOVI_BODY, { 'X-OpenPix-Signature': 'garbage=' })).toThrow(
      /HMAC/,
    );
  });

  it('Woovi: accepts a valid x-webhook-signature (RSA-SHA256) and prefers it over the HMAC secret', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const signer = createSign('RSA-SHA256');
    signer.update(WOOVI_BODY);
    signer.end();
    const signature = signer.sign(privateKey, 'base64');

    // Public key AND HMAC secret configured: the RSA path wins.
    const driver = new WooviDriver(
      { config: () => ({}) },
      { appId: 'test', webhookPublicKey: pem, webhookSecret: 'unused' },
    );
    const event = driver.parseWebhook(WOOVI_BODY, {
      'x-webhook-signature': signature,
      'X-OpenPix-Signature': 'wrong=',
    });
    expect(event.type).toBe('payment.succeeded');
  });

  it('Woovi: rejects an invalid x-webhook-signature', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const driver = new WooviDriver(
      { config: () => ({}) },
      { appId: 'test', webhookPublicKey: pem },
    );
    expect(() =>
      driver.parseWebhook(WOOVI_BODY, { 'x-webhook-signature': 'not-a-signature=' }),
    ).toThrow(/signature/);
  });

  it('Woovi: accepts a base64-encoded PEM public key', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const signer = createSign('RSA-SHA256');
    signer.update(WOOVI_BODY);
    signer.end();
    const signature = signer.sign(privateKey, 'base64');

    const driver = new WooviDriver(
      { config: () => ({}) },
      { appId: 'test', webhookPublicKey: Buffer.from(pem).toString('base64') },
    );
    const event = driver.parseWebhook(WOOVI_BODY, { 'x-webhook-signature': signature });
    expect(event.type).toBe('payment.succeeded');
  });

  it('drivers without credentials keep parsing webhooks (verification is opt-in)', () => {
    const asaas = new AsaasDriver({ config: () => ({}) }, { apiKey: 'test', sandbox: true });
    expect(asaas.parseWebhook(ASAAS_BODY, {}).type).toBe('payment.succeeded');
    const abacate = new AbacateDriver({ config: () => ({}) }, { apiKey: 'test' });
    expect(abacate.parseWebhook(ABACATE_BODY, {}).type).toBe('payment.succeeded');
  });
});
