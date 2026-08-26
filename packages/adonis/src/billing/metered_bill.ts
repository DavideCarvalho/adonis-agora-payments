import type { BillingStore } from './billing_store.js';

/** The per-meter rate and included allowance for a metered plan. */
export interface MeterRate {
  /** The meter name, e.g. `'api_calls'`. */
  meter: string;
  /** Price per unit of the meter, in currency smallest unit (e.g. cents). */
  rate: number;
  /** Units included free of charge per billing period. Defaults to 0. */
  included?: number;
}

/** One metered bill line — how much of a meter was consumed and what it costs. */
export interface MeteredBillLine {
  meter: string;
  quantity: number;
  /** Quantity beyond the plan's included allowance. */
  billable: number;
  /** `billable × rate`, in cents. */
  amount: number;
}

/** The result of pricing a period's metered usage. */
export interface MeteredBill {
  lines: MeteredBillLine[];
  /** Sum of all line amounts, in cents. */
  total: number;
}

/**
 * Price a period's metered usage against per-meter rates — the "how much do I bill for
 * what was consumed" step of a metered subscription. Pure: feed it a
 * {@link BillingStore.usageReport} result and the plan's {@link MeterRate}s.
 *
 * ```ts
 * const usage = await store.usageReport({ subscriptionId: sub.id, from, to })
 * const bill = meteredBill(usage, [
 *   { meter: 'api_calls', rate: 0.5,  included: 1000 },
 *   { meter: 'storage_gb', rate: 200 },
 * ])
 * bill.total // cents to charge for overage
 * ```
 */
export function meteredBill(
  usage: Array<{ meter: string; quantity: number }>,
  rates: MeterRate[],
): MeteredBill {
  const byMeter = new Map(rates.map((r) => [r.meter, r]));
  const lines: MeteredBillLine[] = [];
  for (const line of usage) {
    const rate = byMeter.get(line.meter);
    if (!rate) continue; // usage for an unmetered/unpriced meter is ignored
    const included = rate.included ?? 0;
    const billable = Math.max(0, line.quantity - included);
    lines.push({
      meter: line.meter,
      quantity: line.quantity,
      billable,
      amount: Math.round(billable * rate.rate),
    });
  }
  return { lines, total: lines.reduce((sum, line) => sum + line.amount, 0) };
}

/**
 * Convenience: run a subscription's metered usage for a window through
 * {@link meteredBill}. Fetches the usage from the store, prices it with `rates`, and
 * returns the bill (plus the raw usage for reference).
 */
export async function meteredBillForSubscription(
  store: BillingStore,
  input: { subscriptionId: string; from: Date; to: Date; rates: MeterRate[] },
): Promise<MeteredBill & { usage: Array<{ meter: string; quantity: number }> }> {
  const usage = await store.usageReport({
    subscriptionId: input.subscriptionId,
    from: input.from,
    to: input.to,
  });
  return { ...meteredBill(usage, input.rates), usage };
}
