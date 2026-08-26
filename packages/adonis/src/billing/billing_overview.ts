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
 * (Agora dashboard pattern) renders. Aggregates KPIs over a `from`/`to` window: revenue
 * (sum of paid payments), active subscriptions, and usage per meter. Pure store queries
 * (no gateway calls), so it works headless and is trivially testable.
 */
export async function billingOverview(
  store: BillingStore,
  options: { from: Date; to: Date },
): Promise<BillingOverview> {
  const { from, to } = options;
  const [revenue, activeSubscriptions, usage] = await Promise.all([
    store.revenue({ from, to }),
    store.countActiveSubscriptions(),
    store.usageReport({ from, to }),
  ]);

  const metrics: BillingOverviewMetric[] = [
    { key: 'revenue', label: 'Revenue (cents)', value: revenue },
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
