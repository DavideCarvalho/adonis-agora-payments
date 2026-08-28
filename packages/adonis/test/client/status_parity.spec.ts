import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAYMENT_STATUSES, TERMINAL_PAYMENT_STATUSES } from '../../src/client/statuses.js';

/**
 * `@adonis-agora/payments-react` restates the status union rather than importing it — a
 * browser bundle must not pull an AdonisJS server package in to name seven strings.
 *
 * A restated union is a union that drifts. The consequence is not cosmetic: a status added
 * on the server and missing in the browser copy reaches a consumer's exhaustive `switch` as
 * a value outside the type, and a terminal status missing there is a browser that polls a
 * settled payment forever. So the copy is checked, from the source of truth, here.
 */
describe('payment status parity with @adonis-agora/payments-react', () => {
  const read = async () =>
    readFile(fileURLToPath(new URL('../../../react/src/statuses.ts', import.meta.url)), 'utf-8');

  /** Pull the string literals out of one `export const NAME = [...] as const` block. */
  const listIn = (source: string, name: string): string[] => {
    const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(source);
    if (!match?.[1]) throw new Error(`${name} not found in the react package's statuses.ts`);
    return [...match[1].matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1] as string);
  };

  it('lists exactly the same statuses on both sides', async () => {
    expect(listIn(await read(), 'PAYMENT_STATUSES')).toEqual([...PAYMENT_STATUSES]);
  });

  it('agrees on which statuses are terminal', async () => {
    expect(listIn(await read(), 'TERMINAL_PAYMENT_STATUSES')).toEqual([
      ...TERMINAL_PAYMENT_STATUSES,
    ]);
  });

  it('treats every status that is not pending or authorized as terminal', async () => {
    // The two non-terminal ones are the two where money can still move: an unpaid Pix, and
    // card funds that are held rather than captured.
    expect(PAYMENT_STATUSES.filter((status) => !TERMINAL_PAYMENT_STATUSES.includes(status as never))).toEqual([
      'pending',
      'authorized',
    ]);
  });
});
