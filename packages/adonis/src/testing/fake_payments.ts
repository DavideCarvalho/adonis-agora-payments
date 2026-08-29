import type { BillingStore } from '../billing/billing_store.js';
import { PaymentsManager } from '../payments_manager.js';
import {
  findBillingStore,
  findPayments,
  findWebhookDispatcher,
  resetBillingStore,
  resetPayments,
  setBillingStore,
  setPayments,
} from '../services/main.js';
import { FakePaymentsDriver } from './fake_payments_driver.js';

/**
 * A real {@link PaymentsManager} over a {@link FakePaymentsDriver}.
 *
 * Until this existed `./testing` shipped the fake DRIVER and no way to build a manager
 * around it, so every app wrote the same line:
 *
 * ```ts
 * setPayments({ driver: () => fake } as never)
 * ```
 *
 * `as never` is the tell. That object is not a manager: it has no `invoice()` and no
 * `assertCapability()`, so a charge with `invoice: true` and a refund against a gateway
 * that cannot refund both took a path the test could not exercise — the cast erased exactly
 * the two methods whose absence would have been caught.
 *
 * No `methods` routing is configured on purpose: with one driver and no routing, `driver()`
 * returns it unbound, which is what a test wants. Route explicitly if the test is ABOUT
 * routing.
 */
export function fakePayments(
  driver: FakePaymentsDriver = new FakePaymentsDriver(),
): PaymentsManager {
  return new PaymentsManager({ drivers: new Map([[driver.provider, driver]]) });
}

/**
 * Install a manager on the `services/main` singleton and hand back the restore.
 *
 * The restore works when NOTHING was set, which is the normal case in a test that never
 * booted a provider — and the case the hand-rolled save/restore could not express, because
 * saving meant calling a `getPayments()` that throws when nothing is set.
 *
 * ```ts
 * const fake = new FakePaymentsDriver()
 * const restore = swapPayments(fakePayments(fake))
 * afterEach(restore)
 * ```
 */
export function swapPayments(manager: PaymentsManager): () => void {
  const previous = findPayments();
  setPayments(manager);
  return () => {
    if (previous === undefined) resetPayments();
    else setPayments(previous);
  };
}

/** The same, for the billing store — `InMemoryBillingStore` is the usual argument. */
export function swapBillingStore(store: BillingStore): () => void {
  const previous = findBillingStore();
  setBillingStore(store);
  return () => {
    if (previous === undefined) resetBillingStore();
    else setBillingStore(previous);
  };
}

/**
 * Wait until every webhook this process accepted has finished processing.
 *
 * The gap it closes: with `billing.dispatcher: 'durable'` the delivery resolves when the
 * event is ACCEPTED, not processed, so `await request(...)` returns before anything has
 * happened. Apps papered over it with polling `waitFor` helpers — and could then write a
 * NEGATIVE assertion only as a timed sleep, which is slow when it passes and wrong when the
 * machine is busy.
 *
 * ```ts
 * await client.post('/payments/webhook/asaas').json(payload)
 * await flushWebhooks()
 * expect(await grants.count()).toBe(0)   // an assertion, not a sleep
 * ```
 *
 * No-op when the billing layer is off (nothing dispatched, nothing to wait for). Throws on
 * timeout rather than hanging — including the honest case where a separate worker process
 * runs the events and no in-process wait can ever see them.
 */
export async function flushWebhooks(options: { timeoutMs?: number } = {}): Promise<void> {
  await findWebhookDispatcher()?.flushWebhooks(options);
}
