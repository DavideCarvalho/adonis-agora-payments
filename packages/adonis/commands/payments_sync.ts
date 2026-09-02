import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import type { BillingStore } from '../src/billing/billing_store.js';
import { resolveBillingStore } from '../src/billing/resolve_store.js';
import type { PaymentsConfig } from '../src/define_config.js';
import type { PaymentsDriver } from '../src/driver.js';
import { PaymentsManager } from '../src/payments_manager.js';

/** Customers pulled per page while iterating `--all`. */
const PAGE = 100;

/**
 * A gateway-sent settlement date as a `Date`, or `undefined` when there is nothing usable.
 *
 * Never a fallback to "now". `revenue()` windows on `paid_at`, so a manufactured date files
 * money in the month the reconcile ran rather than the month it was earned — and running the
 * reconcile twice, in two months, counted the same charge in both.
 */
function parseInstant(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * `node ace payments:sync [--provider=stripe] [--customer=cus_123 | --all | --subscriptions]` — reconcile
 * local billing records with the gateway. Useful after missed webhooks or manual dashboard
 * changes: pages through every invoice for a customer (or for every recorded customer with
 * `--all`), asks the gateway what each charge's payment actually says, and writes that into
 * the local store — so the billing tables converge with the gateway.
 *
 * Three properties this command has to have, and did not:
 *
 * 1. **Every invoice, not the first page.** It read one unpaginated listing and reported the
 *    total as if it were the whole customer.
 * 2. **Both directions.** It wrote `status: 'paid'` and nothing else, counting everything
 *    that was not paid as "skipped (non-paid)" — so a local row saying `paid` while the
 *    gateway said refunded or charged back could never be corrected, which is precisely the
 *    drift a gateway-is-truth reconcile exists for.
 * 3. **The gateway's settlement date, or none.** It stamped `paidAt: new Date()`, which moved
 *    historic revenue into the month the reconcile ran.
 *
 * One local state is deliberately NOT reconcilable from the gateway: `disputed`. See the
 * comment on it below.
 *
 * `--subscriptions` is a different reconcile on the same principle: it refreshes price, cycle
 * and status of every recorded gateway subscription. It is the backfill for rows created
 * before the price reached the store, and afterwards the drift correction for an amount edited
 * in the gateway's own dashboard — which some gateways do not send a webhook for at all.
 */
/** O que `reconcileSubscriptions` reporta ao chamador. */
export interface SubscriptionSyncResult {
  updated: number;
  unchanged: number;
  skipped: number;
  missing: number;
}

/** O pedaço do logger do ace que o reconcile usa. */
export interface SyncLogger {
  info(message: string): void;
  warning(message: string): void;
}

/**
 * Reconcile recorded subscriptions against the gateway: price, cycle and status.
 *
 * This exists because a subscription's price only reached the store when a
 * `subscription.created`/`updated` delivery carried it. Every subscription created BEFORE
 * that shipped therefore has no `amount`/`cycle` on its row, and is skipped by the recurring
 * revenue maths until the gateway happens to send an update — which for a healthy
 * subscription that nobody edits is never. This is the backfill, and afterwards it is the
 * drift correction: an amount changed in the gateway's own dashboard produces no webhook in
 * some gateways, and a reconcile is the only thing that would notice.
 *
 * Two kinds of row are skipped, for opposite reasons:
 *
 * - **Managed** — the library owns that recurrence and the gateway has never heard of it.
 *   Asking about it would 404, and "correcting" it from a gateway answer would be writing
 *   over the only authority there is.
 * - **No `gatewayId`** — a free plan or an admin courtesy. Nothing to ask about.
 */
export async function reconcileSubscriptions(
  manager: Pick<PaymentsManager, 'driver'>,
  store: BillingStore,
  options: { provider?: string | undefined; log: SyncLogger },
): Promise<SubscriptionSyncResult> {
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  let missing = 0;

  for (let offset = 0; ; offset += PAGE) {
    const page = await store.listSubscriptions({
      limit: PAGE,
      offset,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
    });

    for (const row of page) {
      if (row.managed || !row.gatewayId) {
        skipped += 1;
        continue;
      }

      let driver: PaymentsDriver;
      try {
        driver = manager.driver(row.provider);
      } catch {
        // Uma linha de um provider que este deploy não configura mais. Não é erro do
        // reconcile, e derrubar a varredura inteira por causa dela seria.
        skipped += 1;
        continue;
      }
      if (driver.capabilities?.subscriptions !== true) {
        skipped += 1;
        continue;
      }

      const remote = await driver.findSubscription(row.gatewayId);
      if (remote === null) {
        // O gateway não conhece mais. NÃO é cancelar por conta própria: uma chave de API
        // trocada ou um ambiente errado produzem exatamente esta resposta, e cancelar em
        // massa a partir dela seria pior que o problema que este comando resolve.
        missing += 1;
        options.log.warning(`${row.provider} ${row.gatewayId}: not found at the gateway`);
        continue;
      }

      const amount = remote.amount?.amount;
      const currency = remote.amount?.currency;
      if (
        row.status === remote.status &&
        row.amount === (amount ?? null) &&
        row.cycle === (remote.cycle ?? null)
      ) {
        unchanged += 1;
        continue;
      }

      await store.saveSubscription({
        gatewayId: row.gatewayId,
        provider: row.provider,
        customerId: remote.customerId,
        status: remote.status,
        planId: remote.planId,
        // Só o que o gateway REALMENTE respondeu. Ausente preserva o que já está gravado —
        // um driver que não mapeia ciclo não pode apagar um que outro caminho gravou.
        ...(amount !== undefined ? { amount } : {}),
        ...(currency !== undefined ? { currency } : {}),
        ...(remote.cycle !== undefined ? { cycle: remote.cycle } : {}),
        payload: remote.payload,
      });
      updated += 1;
    }

    if (page.length < PAGE) break;
  }

  options.log.info(
    `subscriptions: ${updated} updated, ${unchanged} already current, ${skipped} skipped, ${missing} not found`,
  );
  return { updated, unchanged, skipped, missing };
}

export default class PaymentsSync extends BaseCommand {
  static override commandName = 'payments:sync';
  static override description = 'Reconcile local billing records with a payment provider';
  static override options: CommandOptions = { allowUnknownFlags: true };

  @flags.string({ description: 'Provider to sync (a key of config/providers)' })
  declare provider?: string;

  @flags.string({ description: 'Gateway customer id to sync invoices for' })
  declare customer?: string;

  @flags.boolean({
    description: 'Sync invoices for every recorded gateway customer',
  })
  declare all?: boolean;

  @flags.boolean({
    description: 'Reconcile recorded subscriptions (price, cycle, status) instead of invoices',
  })
  declare subscriptions?: boolean;

  override async run(): Promise<void> {
    const config = this.app.config.get<PaymentsConfig>('payments', {});
    if (config.billing?.enabled === false) {
      this.logger.error(
        'The billing layer is disabled (billing.enabled = false). Nothing to sync.',
      );
      return;
    }
    const manager = await this.app.container.make(PaymentsManager);

    // Assinaturas ANTES do guard de customer: este modo não itera customers, e exigir
    // `--all`/`--customer` para rodá-lo seria pedir um argumento que ele ignora.
    if (this.subscriptions) {
      await reconcileSubscriptions(manager, await resolveBillingStore(config), {
        provider: this.provider,
        log: this.logger,
      });
      return;
    }

    if (!this.customer && !this.all) {
      this.logger.error(
        'Pass --customer=<gateway customer id> to sync one customer, --all to sync every recorded gateway customer, or --subscriptions to reconcile subscriptions.',
      );
      return;
    }

    const driver = manager.driver(this.provider);
    // Some gateways (Woovi/OpenPix) have no invoice concept — fail early with a clear
    // message instead of listing nothing.
    manager.assertCapability(driver, 'invoices');
    // The CONFIGURED store, not a fresh Lucid one: an app that pointed `billing.store`
    // somewhere else would otherwise have its reconcile write to a database the rest of
    // the billing layer never reads.
    const store = await resolveBillingStore(config);

    const customers = this.customer
      ? [this.customer]
      : await this.#listCustomers(store, this.provider);
    if (customers.length === 0) {
      this.logger.info(
        'No customers recorded to sync. `--all` iterates the mappings written by ensureCustomer({ store }) / store.saveCustomer() — see the billing docs.',
      );
      return;
    }

    let synced = 0;
    let protectedRows = 0;
    for (const customerId of customers) {
      const invoices = await driver.listInvoices(customerId);
      let changed = 0;
      let unchanged = 0;
      let undecided = 0;
      for (const invoice of invoices) {
        const local = await store.findPaymentByGatewayId(invoice.gatewayId);

        // The converged case, and the reason a second run of this command is cheap: the
        // gateway says paid, the local row says paid, and it already carries a settlement
        // date. There is nothing a `findPayment` could tell us, so it is not asked.
        if (
          local !== null &&
          local.status === 'paid' &&
          local.paidAt &&
          invoice.status === 'paid'
        ) {
          unchanged += 1;
          continue;
        }

        // `Invoice.status` cannot say `refunded` or `disputed` — its vocabulary has no
        // members for them, so a reversed charge arrives here as `draft`. That is the exact
        // drift a gateway-is-truth reconcile exists to correct, so the authority is the
        // PAYMENT resource, which speaks `BillingStatus`: the listing enumerates, the payment
        // decides.
        const remote = await driver.findPayment(invoice.gatewayId);
        if (remote === null) {
          undecided += 1;
          continue;
        }

        // The one local state the gateway does not get to overwrite. A chargeback is money
        // the bank has pulled back, it lives in `billing_disputes` with a deadline, and the
        // gateway's payment resource frequently goes on reporting the charge as received
        // while the dispute is open — so reconciling `disputed` back to `paid` here would
        // re-count money that is gone and silence the dispute at the same time. Only
        // `payment.dispute_closed`, which carries an outcome, resolves one.
        if (local !== null && local.status === 'disputed' && remote.status !== 'disputed') {
          protectedRows += 1;
          this.logger.warning(
            `  ${invoice.gatewayId}: local row is disputed, gateway says ${remote.status} — left alone. A dispute is resolved by its close event, not by a reconcile.`,
          );
          continue;
        }

        // Already agreed, with nothing left to add: same status, and either the settlement
        // date is recorded or the gateway has none to give. Skipped so a reconcile over a
        // stable install writes nothing at all rather than churning every row's `updated_at`.
        if (
          local !== null &&
          local.status === remote.status &&
          (local.paidAt || remote.paidAt === undefined)
        ) {
          unchanged += 1;
          continue;
        }

        // The gateway's OWN settlement date, and never a substitute for it. Stamping
        // `new Date()` here — which is what this did — relocated historic revenue into the
        // month the reconcile ran, so running it twice in different months counted the same
        // charge in both. An already-recorded `paid_at` is never overwritten, and an invoice
        // that carries none records none: absent means "not stated" to `savePayment`, which
        // leaves whatever is there alone.
        const settledAt = local?.paidAt ? undefined : parseInstant(remote.paidAt);

        await store.savePayment({
          gatewayId: invoice.gatewayId,
          provider: invoice.provider,
          // Both directions. Writing only `paid` meant a local row saying `paid` while the
          // gateway said refunded or charged back could never be corrected — and every such
          // row was counted as "skipped (non-paid)", which read like nothing was wrong.
          status: remote.status,
          amount: remote.amount.amount,
          currency: remote.amount.currency,
          ...(invoice.customerId !== undefined ? { customerId: invoice.customerId } : {}),
          ...(invoice.subscriptionId !== undefined
            ? { subscriptionId: invoice.subscriptionId }
            : {}),
          ...(settledAt !== undefined ? { paidAt: settledAt } : {}),
          payload: invoice.payload,
        });
        changed += 1;
        synced += 1;
      }
      this.logger.info(
        `  ${customerId}: ${invoices.length} invoice(s), ${changed} reconciled, ${unchanged} already current, ${undecided} undecidable (gateway had no payment)`,
      );
    }
    this.logger.success(
      `Reconciled ${synced} payment(s) across ${customers.length} customer(s)${
        protectedRows > 0 ? `; ${protectedRows} disputed row(s) left alone` : ''
      }.`,
    );
  }

  /**
   * Gateway customer ids from the recorded customer mappings.
   *
   * Read through the STORE rather than the table: `billing.store` is a configured seam, and
   * a reconcile that queried `billing_customers` directly would iterate a table the rest of
   * the billing layer no longer uses the moment an app points that seam elsewhere.
   *
   * Paged, because `--all` on a large install would otherwise select the whole table into
   * memory before the first invoice is fetched.
   */
  async #listCustomers(store: BillingStore, provider?: string): Promise<string[]> {
    const ids: string[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await store.listCustomers({
        limit: PAGE,
        offset,
        ...(provider !== undefined ? { provider } : {}),
      });
      for (const row of page) ids.push(row.gatewayId);
      if (page.length < PAGE) return ids;
    }
  }
}
