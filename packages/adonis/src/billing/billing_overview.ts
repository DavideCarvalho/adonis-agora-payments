import type { BillingStore, SubscriptionCycleTotal } from './billing_store.js';

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
/** Quantos meses cada ciclo cobre. O que não estiver aqui é ignorado, não chutado. */
const MONTHS_PER_CYCLE: Record<string, number> = {
  WEEKLY: 7 / 30.44,
  BIWEEKLY: 14 / 30.44,
  MONTHLY: 1,
  BIMONTHLY: 2,
  QUARTERLY: 3,
  TRIMONTHLY: 3,
  SEMIANNUALLY: 6,
  SEMIANUALY: 6,
  YEARLY: 12,
  ANNUALLY: 12,
  ANNUALY: 12,
};

/**
 * Receita recorrente mensal a partir dos totais por ciclo.
 *
 * Anual vira mensal dividindo por 12 — a convenção usual, e uma DECISÃO, que é por que ela
 * mora aqui e não numa expressão SQL: o store devolve os totais agrupados e quem interpreta é
 * esta função, num lugar só, legível e testável.
 *
 * Ciclo desconhecido é IGNORADO em vez de tratado como mensal. Contá-lo como mensal inflaria o
 * número em silêncio, e um MRR errado para cima é pior que um incompleto: ninguém audita uma
 * métrica que parece boa.
 *
 * As grafias duplicadas (`SEMIANUALY`, `ANNUALY`) não são erro de digitação — são as do produto
 * de assinatura comum do Woovi, e uma linha gravada com elas é receita de verdade.
 */
export function monthlyRecurringRevenue(lines: SubscriptionCycleTotal[]): number {
  let monthly = 0;
  for (const line of lines) {
    const months = MONTHS_PER_CYCLE[line.cycle.toUpperCase()];
    if (months === undefined) continue;
    monthly += line.total / months;
  }
  return Math.round(monthly);
}

export async function billingOverview(
  store: BillingStore,
  options: { from: Date; to: Date },
): Promise<BillingOverview> {
  const { from, to } = options;
  const [revenue, netRevenue, activeSubscriptions, usage, cycleTotals] = await Promise.all([
    store.revenue({ from, to }),
    store.netRevenue({ from, to }),
    store.countActiveSubscriptions(),
    store.usageReport({ from, to }),
    // Só as gerenciadas: são as únicas cujo valor e ciclo esta biblioteca conhece. Numa
    // assinatura do gateway o preço vive lá, e somar as duas daria um número que é metade da
    // verdade apresentada como o total.
    store.subscriptionAmountByCycle({ status: 'active', managed: true }),
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
    // Receita recorrente COMPROMETIDA, que é pergunta diferente das duas acima: elas olham o
    // que já entrou na janela, esta olha o que entra por mês enquanto nada mudar. Só passou a
    // ser calculável quando a assinatura gerenciada começou a guardar valor e ciclo — numa
    // assinatura do gateway esse dado nunca esteve deste lado.
    {
      key: 'mrr',
      label: 'Recurring revenue, monthly (cents)',
      value: monthlyRecurringRevenue(cycleTotals),
    },
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
