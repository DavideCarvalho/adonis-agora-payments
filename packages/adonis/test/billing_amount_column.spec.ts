import { describe, expect, it } from 'vitest';
import { BillingDispute, BillingPayment } from '../src/billing/mixins/index.js';

/**
 * `amount` is `BIGINT`, and node-postgres returns bigints as **strings** — it will not guess
 * past 2^53, and that is the right call for a general driver. It is the wrong shape here: the
 * column is minor units, the declared type is `number`, and a row read back held `'1990'`. An
 * app adding a fee to it got `'1990500'`, silently, with no type error anywhere because the
 * declaration says otherwise.
 *
 * The integration suite is what found this; this pins it without needing Postgres. `Number()`
 * is safe for this column specifically: 2^53 minor units is ninety trillion reais.
 */
describe('billing amount columns', () => {
  const consumeOf = (model: typeof BillingPayment | typeof BillingDispute) =>
    model.$getColumn('amount')?.consume as ((value: unknown) => unknown) | undefined;

  it.each([
    ['BillingPayment', BillingPayment],
    ['BillingDispute', BillingDispute],
  ])('%s coerces the bigint Postgres hands back', (_name, model) => {
    const consume = consumeOf(model as typeof BillingPayment);
    expect(consume, 'no consume on `amount` — a bigint will arrive as a string').toBeTypeOf(
      'function',
    );
    expect(consume?.('1990')).toBe(1990);
    expect(consume?.(1990)).toBe(1990);
  });

  it('keeps a null amount null', () => {
    // A pre-dispute alert names a charge and a fraud type and no money at all. `Number(null)`
    // is `0`, which would report a dispute over nothing as a dispute over nothing owed.
    expect(consumeOf(BillingDispute)?.(null)).toBeNull();
  });
});
