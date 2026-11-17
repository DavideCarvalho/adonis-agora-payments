import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import type { BillingKeysetPosition, BillingStore } from '../src/billing/billing_store.js';

/**
 * Keyset paging over a {@link BillingStore}, the same assertions on every store and dialect: rows
 * written at only three distinct instants (so most of them tie on `created_at` and only the id
 * keeps pages apart), walked two at a time with `keyset`, must come back once each, newest first,
 * with the filter applied on every page — and the offset read still answers `page`.
 *
 * Every row carries a provider unique to this call, and every read filters on it, so the contract
 * can run against a database other specs also write to.
 */
export async function keysetContract(store: BillingStore): Promise<void> {
  const provider = `ks_${randomUUID().slice(0, 8)}`;
  const t0 = Date.parse('2026-11-17T10:00:00.000Z');

  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    for (let n = 0; n < 7; n++) {
      vi.setSystemTime(t0 + Math.floor(n / 3) * 1000);
      await store.savePayment({
        gatewayId: `${provider}_pay_${n}`,
        provider,
        status: n % 2 === 0 ? 'paid' : 'failed',
        amount: 100 + n,
        currency: 'BRL',
      });
      await store.saveCustomer({ gatewayId: `${provider}_cus_${n}`, provider });
      await store.recordAuditEvent({
        action: 'payment.refunded',
        provider,
        subjectType: 'payment',
        subjectId: `${provider}_pay_${n}`,
        createdAt: new Date(t0 + Math.floor(n / 3) * 1000),
      });
    }
  } finally {
    vi.useRealTimers();
  }

  type Row = { id: string; createdAt: Date | null; gatewayId?: string };
  async function walk(read: (after?: BillingKeysetPosition) => Promise<Row[]>): Promise<Row[][]> {
    const pages: Row[][] = [];
    let after: BillingKeysetPosition | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const rows = await read(after);
      const page = rows.slice(0, 2);
      pages.push(page);
      if (rows.length <= 2) return pages;
      const last = page.at(-1) as Row;
      after = { createdAt: last.createdAt as Date, id: last.id };
    }
    throw new Error('no last page');
  }
  const keyset = (after?: BillingKeysetPosition) => (after === undefined ? {} : { after });

  // Payments, every status: 7 rows → 2+2+2+1, each once, newest instant first.
  const all = await walk((after) =>
    store.listPayments({ provider, size: 2, keyset: keyset(after) }),
  );
  expect(all.map((page) => page.length)).toEqual([2, 2, 2, 1]);
  const ids = all.flat().map((row) => row.gatewayId);
  expect(new Set(ids).size).toBe(7);
  expect(ids.slice(0, 1)).toEqual([`${provider}_pay_6`]);
  const times = all.flat().map((row) => (row.createdAt as Date).getTime());
  expect([...times].sort((a, b) => b - a)).toEqual(times);
  // The same rows as one big keyset read, in the same order.
  const whole = await store.listPayments({ provider, size: 50, keyset: {} });
  expect(whole.map((row) => row.gatewayId)).toEqual(ids);

  // A filter holds on every page: the four `paid` ones.
  const paid = await walk((after) =>
    store.listPayments({ provider, status: 'paid', size: 2, keyset: keyset(after) }),
  );
  expect(
    paid
      .flat()
      .map((row) => row.gatewayId)
      .sort(),
  ).toEqual([0, 2, 4, 6].map((n) => `${provider}_pay_${n}`));

  // Customers and the audit trail page the same way.
  const customers = await walk((after) =>
    store.listCustomers({ provider, size: 2, keyset: keyset(after) }),
  );
  expect(new Set(customers.flat().map((row) => row.id)).size).toBe(7);
  const audit = await walk((after) =>
    store.listAuditEvents({ provider, size: 2, keyset: keyset(after) }),
  );
  expect(new Set(audit.flat().map((row) => row.id)).size).toBe(7);

  // `page` still reads by offset, `size` rows, no extra row.
  const second = await store.listPayments({ provider, page: 2, size: 3 });
  expect(second).toHaveLength(3);
  expect(await store.countPayments({ provider })).toBe(7);
}
