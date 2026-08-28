import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WEBHOOK_EVENT_TYPES } from '../src/billing/webhook_events.js';

/**
 * `WEBHOOK_EVENT_TYPES` describes itself as the shared constant that stops a typo in one
 * driver silently degrading to the processor's no-op branch — and until this test it had
 * **no consumers at all**, so the guarantee was entirely fictional. `payment.disputed` was
 * added to the processor and to the diagnostics list, and missed here, which is exactly the
 * drift the constant claims to prevent.
 */
describe('WEBHOOK_EVENT_TYPES', () => {
  const read = (path: string) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf-8');

  it('covers every type the processor syncs', async () => {
    const processor = await read('../src/billing/webhook_processor.ts');
    const handled = [...processor.matchAll(/case '([a-z]+\.[a-z_]+)':/g)].map((m) => m[1]);
    expect(handled.length, 'no cases found — did the switch move?').toBeGreaterThan(0);

    const missing = handled.filter((type) => !WEBHOOK_EVENT_TYPES.includes(type as never));
    expect(
      missing,
      `the processor syncs types the shared constant does not list: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('covers every payment/subscription type the diagnostics bus publishes', async () => {
    const diagnostics = await read('../src/diagnostics.ts');
    const block = diagnostics.split('PAYMENTS_DIAGNOSTIC_EVENTS = [')[1]?.split(']')[0] ?? '';
    const published = [...block.matchAll(/'([a-z]+\.[a-z_]+)'/g)]
      .map((m) => m[1] as string)
      // The bus also carries gateway-action and lifecycle events, which are not normalized
      // webhook types — only the business ones have to line up.
      .filter((event) => /^(payment|subscription)\./.test(event));

    const missing = published.filter((type) => !WEBHOOK_EVENT_TYPES.includes(type as never));
    expect(
      missing,
      `published on the bus but not a canonical webhook type: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('lists payment.disputed — the one that was missed', () => {
    expect(WEBHOOK_EVENT_TYPES).toContain('payment.disputed');
  });
});
