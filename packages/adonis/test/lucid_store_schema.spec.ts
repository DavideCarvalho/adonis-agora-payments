import { describe, expect, it, vi } from 'vitest';
import { LucidBillingStore } from '../src/billing/lucid_billing_store.js';

/**
 * `autoCreateSchema` is only worth having if it covers every door into the store.
 *
 * A lazily-created schema that most methods wait for is worse than no auto-create at all:
 * it works in development, where something writes before anything reads, and fails in
 * production on whichever call happens to be first — a dashboard opened before the first
 * charge, a health check on a fresh deploy. "I added a method and forgot the gate" is not a
 * failure a reviewer catches, so it is a failure a test has to catch.
 *
 * This enumerates the class's public methods rather than listing them, so a method added
 * tomorrow is covered by a test written today.
 */
describe('LucidBillingStore schema gate', () => {
  /** Every public method on the store, discovered rather than listed. */
  const methodNames = (): string[] =>
    Object.getOwnPropertyNames(LucidBillingStore.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        // The two that legitimately do not query. `ensureSchema` IS the schema creation —
        // gating it on itself deadlocks — and `disableAutoCreateSchema` only flips a flag.
        // Everything else on this class talks to the database and must not do so first.
        name !== 'ensureSchema' &&
        name !== 'disableAutoCreateSchema' &&
        typeof (LucidBillingStore.prototype as unknown as Record<string, unknown>)[name] ===
          'function',
    );

  it('has public methods to check', () => {
    // If the reflection breaks, every case below passes vacuously — which is the one way
    // this test could lie.
    expect(methodNames().length).toBeGreaterThan(20);
  });

  it.each(methodNames())('%s creates the schema before it queries', async (name) => {
    const store = new LucidBillingStore();
    const ensure = vi.spyOn(store, 'ensureSchema').mockResolvedValue(undefined);

    // The call itself fails: there is no database in a unit test. That is fine and is the
    // point — the assertion is about what happened BEFORE the query, so the rejection is
    // swallowed and only the ordering is checked.
    try {
      await (store as unknown as Record<string, () => Promise<unknown>>)[name]?.call(store, {});
    } catch {
      // expected — no connection configured
    }

    expect(ensure, `${name}() queried without creating the schema first`).toHaveBeenCalled();
  });

  it('does nothing when autoCreateSchema is off', async () => {
    // The escape hatch has to actually escape: an app that manages the schema through its
    // own migrations must not have DDL run behind its back.
    const store = new LucidBillingStore({}, { autoCreateSchema: false });
    const ensure = vi.spyOn(store, 'ensureSchema').mockResolvedValue(undefined);

    try {
      await store.findPaymentByGatewayId('pi_1');
    } catch {
      // expected — no connection configured
    }

    expect(ensure).not.toHaveBeenCalled();
  });

  it('creates the schema once, however many calls race for it', async () => {
    const store = new LucidBillingStore();
    const ensure = vi.spyOn(store, 'ensureSchema').mockResolvedValue(undefined);

    await Promise.all(
      [1, 2, 3, 4, 5].map(async () => {
        try {
          await store.findPaymentByGatewayId('pi_1');
        } catch {
          // expected — no connection configured
        }
      }),
    );

    // Six `CREATE TABLE IF NOT EXISTS` per query would be a round trip per query forever.
    expect(ensure).toHaveBeenCalledTimes(1);
  });
});
