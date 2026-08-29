import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AsaasDriver } from '../src/drivers/asaas.js';
import { StripeDriver } from '../src/drivers/stripe.js';
import { assertWebhookVerification } from '../src/webhook_security.js';

const ctx = { config: () => ({}) } as never;

/**
 * These drivers read their webhook credential from the environment as a fallback, so a
 * developer machine with `ASAAS_WEBHOOK_ACCESS_TOKEN` exported would make the "unconfigured"
 * assertions pass for the wrong reason — or fail for one.
 */
const ENV_KEYS = [
  'ASAAS_WEBHOOK_ACCESS_TOKEN',
  'ASAAS_WEBHOOK_TOKEN',
  'STRIPE_WEBHOOK_SECRET',
] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * The boot refusal is only worth anything if the DRIVERS answer honestly. Asaas is the one
 * the bug was found on: `if (this.#webhookToken !== undefined)` meant an empty slot verified
 * nothing, and `POST /payments/webhook/asaas` accepted every body posted to it.
 */
describe('driver webhook-verification state', () => {
  it('Asaas says "unconfigured" when the token slot is empty', () => {
    const driver = new AsaasDriver(ctx, { apiKey: 'k' });
    expect(driver.webhookVerification).toBe('unconfigured');
  });

  it('Asaas says "configured" once it has a token', () => {
    const driver = new AsaasDriver(ctx, { apiKey: 'k', webhookToken: 'tok' });
    expect(driver.webhookVerification).toBe('configured');
  });

  it('drives the boot refusal end to end, from the real driver', () => {
    const driver = new AsaasDriver(ctx, { apiKey: 'k' });
    expect(() => assertWebhookVerification([['asaas', driver]])).toThrow(/no credential/);
    expect(() =>
      assertWebhookVerification([['asaas', driver]], { allowUnverifiedWebhooks: ['asaas'] }),
    ).not.toThrow();
  });

  it('Stripe answers too — its parseWebhook already refused, this moves it to boot', () => {
    expect(new StripeDriver(ctx, { apiKey: 'sk', currency: 'brl' }).webhookVerification).toBe(
      'unconfigured',
    );
    expect(
      new StripeDriver(ctx, { apiKey: 'sk', currency: 'brl', webhookSecret: 'whsec' })
        .webhookVerification,
    ).toBe('configured');
  });

  /**
   * A new driver that forgets to declare it is a new driver that fails open — silently, and
   * only on the endpoint the public internet can reach. The check is structural for that
   * reason.
   */
  it('every shipped driver declares one', async () => {
    const dir = fileURLToPath(new URL('../src/drivers/', import.meta.url));
    const missing: string[] = [];
    for (const file of await readdir(dir)) {
      if (!file.endsWith('.ts') || file === 'shared.ts') continue;
      const source = await readFile(`${dir}${file}`, 'utf-8');
      if (!source.includes('get webhookVerification()')) missing.push(file);
    }
    expect(
      missing,
      `drivers with no webhookVerification declaration: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * Mollie's CLASSIC webhook has no credential to configure, and that is not a gap: the
 * request carries only `id=tr_xxx`, and the driver authenticates by reading that payment
 * back with the API key. The body is never trusted, so a forged call cannot claim a payment
 * succeeded.
 *
 * It reported `'unconfigured'`, which is the state that refuses to boot — so the supported,
 * safe configuration stopped booting, and the only way out was `allowUnverifiedWebhooks`,
 * which would ALSO have silenced a genuinely missing next-gen secret.
 */
describe('Mollie declares the classic flow as unsupported, not unconfigured', () => {
  it('boots on the classic flow with no webhook secret', async () => {
    const { MollieDriver } = await import('../src/drivers/mollie.js');
    const driver = new MollieDriver({} as never, { apiKey: 'test_key', currency: 'eur' });
    expect(driver.webhookVerification).toBe('unsupported');
  });

  it('still demands the secret once next-gen webhooks are in use', async () => {
    const { MollieDriver } = await import('../src/drivers/mollie.js');
    const driver = new MollieDriver({} as never, {
      apiKey: 'test_key',
      currency: 'eur',
      webhookSecret: 's3cret',
    });
    expect(driver.webhookVerification).toBe('configured');
  });
});
