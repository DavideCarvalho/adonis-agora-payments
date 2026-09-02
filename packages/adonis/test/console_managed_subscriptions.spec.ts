import { describe, expect, it } from 'vitest';
import { billingHealth } from '../src/billing/billing_health.js';
import { monthlyRecurringRevenue } from '../src/billing/billing_overview.js';
import type { BillingStore } from '../src/billing/billing_store.js';
import {
  createManagedSubscription,
  renewDueManagedSubscriptions,
} from '../src/billing/managed_subscriptions.js';
import { payments } from '../src/dashboard/handlers.js';
import type { PaymentsDriver } from '../src/driver.js';
import { FakePaymentsDriver } from '../src/testing/fake_payments_driver.js';
import { InMemoryBillingStore } from '../src/testing/in_memory_billing_store.js';

class FlakyDriver extends FakePaymentsDriver {
  failNextCharge = false;
  async charge(input: Parameters<PaymentsDriver['charge']>[0]) {
    if (this.failNextCharge) {
      this.failNextCharge = false;
      throw new Error('gateway recusou o débito');
    }
    return super.charge(input);
  }
}

const store = () => new InMemoryBillingStore() as unknown as BillingStore;

async function seed(billing: BillingStore, driver: FakePaymentsDriver, startDate: string) {
  return createManagedSubscription(driver, billing, {
    customerId: 'cus_1',
    planId: 'p',
    amount: 9900,
    cycle: 'MONTHLY',
    startDate,
  });
}

describe('MRR', () => {
  it('normaliza cada ciclo para um mês', () => {
    expect(
      monthlyRecurringRevenue([
        { cycle: 'MONTHLY', total: 10_000, count: 1 },
        { cycle: 'YEARLY', total: 120_000, count: 1 },
        { cycle: 'QUARTERLY', total: 30_000, count: 1 },
      ]),
      // 10.000 + 120.000/12 + 30.000/3
    ).toBe(30_000);
  });

  /**
   * Ciclo desconhecido é ignorado, não tratado como mensal. Contá-lo como mensal inflaria o
   * número em silêncio — e um MRR errado para cima é pior que um incompleto, porque ninguém
   * audita uma métrica que parece boa.
   */
  it('ignora ciclo que não conhece em vez de chutar mensal', () => {
    expect(
      monthlyRecurringRevenue([
        { cycle: 'MONTHLY', total: 5_000, count: 1 },
        { cycle: 'A_CADA_LUA_CHEIA', total: 999_999, count: 1 },
      ]),
    ).toBe(5_000);
  });

  /** `SEMIANUALY`/`ANNUALY` são as grafias do Woovi, não erros de digitação. */
  it('aceita as grafias do gateway', () => {
    expect(monthlyRecurringRevenue([{ cycle: 'ANNUALY', total: 12_000, count: 1 }])).toBe(1_000);
    expect(monthlyRecurringRevenue([{ cycle: 'SEMIANUALY', total: 6_000, count: 1 }])).toBe(1_000);
  });
});

describe('renovação: o que fica registrado', () => {
  it('grava o erro e conta a sequência, e zera quando volta a funcionar', async () => {
    const driver = new FlakyDriver();
    const billing = store();
    const created = await seed(billing, driver, '2026-01-10');

    driver.failNextCharge = true;
    await renewDueManagedSubscriptions(() => driver, billing, {
      now: new Date('2026-02-10T00:00:00Z'),
    });

    // Uma falha não muda mais NADA na linha — o período não avança de propósito. Sem estes
    // campos, "falhando há uma semana" e "vence amanhã" eram indistinguíveis no console.
    const failed = (await billing.findSubscriptionById(created.id)) as unknown as {
      lastRenewalError: string | null;
      renewalFailureCount: number | null;
    };
    expect(failed.lastRenewalError).toBe('gateway recusou o débito');
    expect(failed.renewalFailureCount).toBe(1);

    await renewDueManagedSubscriptions(() => driver, billing, {
      now: new Date('2026-02-10T00:00:00Z'),
    });

    // Mede uma SEQUÊNCIA, não um total histórico: quem falhou em março e paga desde então não
    // é um problema aberto.
    const recovered = (await billing.findSubscriptionById(created.id)) as unknown as {
      lastRenewalError: string | null;
      renewalFailureCount: number | null;
    };
    expect(recovered.lastRenewalError).toBeNull();
    expect(recovered.renewalFailureCount).toBe(0);
  });
});

describe('health: renovação', () => {
  it('acusa assinatura vencida que ninguém cobrou — o cron morto', async () => {
    const driver = new FakePaymentsDriver();
    const billing = store();
    await seed(billing, driver, '2026-01-10');

    // Dois meses depois e nada renovou: só acontece se `payments:renew` parou de rodar.
    const report = await billingHealth(billing, { now: new Date('2026-04-10T00:00:00Z') });
    const overdue = report.checks.find((check) => check.key === 'overdue_renewals');
    expect(overdue?.count).toBe(1);
    expect(report.healthy).toBe(false);
  });

  it('não acusa nada quando a próxima cobrança ainda não venceu', async () => {
    const driver = new FakePaymentsDriver();
    const billing = store();
    await seed(billing, driver, '2026-01-10');

    const report = await billingHealth(billing, { now: new Date('2026-01-20T00:00:00Z') });
    expect(report.checks.find((check) => check.key === 'overdue_renewals')?.count).toBe(0);
  });

  it('separa "o runner não rodou" de "o gateway recusou"', async () => {
    const driver = new FlakyDriver();
    const billing = store();
    await seed(billing, driver, '2026-01-10');

    driver.failNextCharge = true;
    await renewDueManagedSubscriptions(() => driver, billing, {
      now: new Date('2026-02-10T00:00:00Z'),
    });

    const report = await billingHealth(billing, { now: new Date('2026-02-10T01:00:00Z') });
    // As duas checagens existem porque as causas são opostas: uma é o cron parado, a outra é
    // o cron rodando e o gateway dizendo não. O conserto de uma não é o da outra.
    expect(report.checks.find((check) => check.key === 'failing_renewals')?.count).toBe(1);
  });
});

describe('listagem: assinatura gerenciada', () => {
  it('devolve valor, ciclo e próxima cobrança — o que não tem painel de gateway pra consultar', async () => {
    const driver = new FakePaymentsDriver();
    const billing = store();
    const created = await seed(billing, driver, '2026-01-10');

    const rows = await billing.listSubscriptions({ limit: 10 });
    const row = rows.find((candidate) => candidate.id === created.id);

    expect(row).toBeDefined();
    // Numa linha gerenciada não existe `gatewayId` — sem os campos abaixo a tela mostrava um
    // id nulo e nada sobre quanto cobra ou quando.
    expect(row?.gatewayId).toBeNull();
    expect(row?.managed).toBe(true);
    expect(row?.amount).toBe(9900);
    expect(row?.cycle).toBe('MONTHLY');
    expect(row?.nextChargeAt).toEqual(new Date('2026-02-10T00:00:00.000Z'));
  });
});

describe('console: ação que o gateway não sabe fazer', () => {
  it('não oferece Refund num gateway sem estorno', async () => {
    const billing = new InMemoryBillingStore();
    await billing.savePayment({
      gatewayId: 'chg_woovi',
      provider: 'woovi',
      status: 'paid',
      amount: 9900,
      currency: 'BRL',
    });
    await billing.savePayment({
      gatewayId: 'pi_asaas',
      provider: 'asaas',
      status: 'paid',
      amount: 9900,
      currency: 'BRL',
    });

    const body = (
      await payments(
        {
          store: billing as unknown as BillingStore,
          currency: 'BRL',
          capabilities: {
            woovi: { refunds: false, disputes: false, cancelSubscription: false },
            asaas: { refunds: true, disputes: true, cancelSubscription: true },
          },
        },
        { params: {}, query: {} },
      )
    ).body as { payments: { gatewayId: string; refundable: boolean }[] };

    const byId = new Map(body.payments.map((row) => [row.gatewayId, row.refundable]));
    // O OpenPix não tem estorno por API. Antes, todo Pix pago mostrava um botão que só podia
    // falhar — e o operador descobria clicando.
    expect(byId.get('chg_woovi')).toBe(false);
    expect(byId.get('pi_asaas')).toBe(true);
  });

  it('oferece a ação quando não deu para perguntar as capabilities', async () => {
    const billing = new InMemoryBillingStore();
    await billing.savePayment({
      gatewayId: 'chg_1',
      provider: 'woovi',
      status: 'paid',
      amount: 100,
      currency: 'BRL',
    });

    const body = (
      await payments(
        { store: billing as unknown as BillingStore, currency: 'BRL' },
        { params: {}, query: {} },
      )
    ).body as { payments: { refundable: boolean }[] };

    // Sem manager alcançável não há o que consultar. Esconder a ação puniria o operador por
    // uma indisponibilidade de lookup — mostrar é o comportamento anterior, e o pior caso é
    // um erro do gateway, que é o que acontecia antes o tempo todo.
    expect(body.payments[0]?.refundable).toBe(true);
  });
});
