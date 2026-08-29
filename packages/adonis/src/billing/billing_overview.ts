import type { BillingStore } from './billing_store.js';

/** One aggregate line of the billing overview. */
export interface BillingOverviewMetric {
  key: string;
  label: string;
  value: number;
}

/** The dashboard's data contract: aggregate KPIs over a window. */
export interface BillingOverview {
  period: { from: Date; to: Date };
  metrics: BillingOverviewMetric[];
}

/**
 * Compute a billing overview from the store — the data foundation a billing dashboard
 * (Agora dashboard pattern) renders. Aggregates KPIs over a `from`/`to` window: revenue —
 * BOTH gross (`revenue`, the sum of paid payments) and net of refunds (`net_revenue`,
 * `amount - refunded_amount` over the same rows) — active subscriptions, and usage per meter.
 * Pure store queries (no gateway calls), so it works headless and is trivially testable.
 */
export async function billingOverview(
  store: BillingStore,
  options: { from: Date; to: Date },
): Promise<BillingOverview> {
  const { from, to } = options;
  const [revenue, netRevenue, activeSubscriptions, usage] = await Promise.all([
    store.revenue({ from, to }),
    store.netRevenue({ from, to }),
    store.countActiveSubscriptions(),
    store.usageReport({ from, to }),
  ]);

  const metrics: BillingOverviewMetric[] = [
    // Two money lines, and the labels are load-bearing. `revenue` was the only one for two
    // releases, and it is GROSS: a charge that was half refunded counts at its full value in
    // it. Nothing on the screen said so, so a partial refund was invisible in the console's
    // headline number. Both figures are legitimate — gross is what was collected, net is what
    // was kept — and the fix is to publish both under names that cannot be confused, not to
    // quietly redefine the one apps already read.
    { key: 'revenue', label: 'Revenue, gross (cents)', value: revenue },
    { key: 'net_revenue', label: 'Revenue, net of refunds (cents)', value: netRevenue },
    { key: 'active_subscriptions', label: 'Active subscriptions', value: activeSubscriptions },
  ];
  for (const line of usage) {
    metrics.push({
      key: `meter:${line.meter}`,
      label: `Usage · ${line.meter}`,
      value: line.quantity,
    });
  }

  return { period: { from, to }, metrics };
}
