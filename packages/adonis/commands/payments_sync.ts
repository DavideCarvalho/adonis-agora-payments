import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import type { BillingStore } from '../src/billing/billing_store.js';
import { resolveBillingStore } from '../src/billing/resolve_store.js';
import type { PaymentsConfig } from '../src/define_config.js';
import { PaymentsManager } from '../src/payments_manager.js';

/** Customers pulled per page while iterating `--all`. */
const PAGE = 100;

/**
 * `node ace payments:sync [--provider=stripe] [--customer=cus_123 | --all]` — reconcile
 * local billing records with the gateway. Useful after missed webhooks or manual
 * dashboard changes: pulls recent invoices for a customer (or every customer in
 * recorded customer with `--all`) and upserts the paid ones into the local store, so
 * the billing tables converge with the gateway.
 */
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

  override async run(): Promise<void> {
    const config = this.app.config.get<PaymentsConfig>('payments', {});
    if (config.billing?.enabled === false) {
      this.logger.error(
        'The billing layer is disabled (billing.enabled = false). Nothing to sync.',
      );
      return;
    }
    if (!this.customer && !this.all) {
      this.logger.error(
        'Pass --customer=<gateway customer id> to sync one customer, or --all to sync every recorded gateway customer.',
      );
      return;
    }

    const manager = await this.app.container.make(PaymentsManager);
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
    for (const customerId of customers) {
      const invoices = await driver.listInvoices(customerId);
      let skipped = 0;
      for (const invoice of invoices) {
        // Only sync invoices that represent a settled/paid billing event.
        if (invoice.status === 'paid') {
          await store.savePayment({
            gatewayId: invoice.gatewayId,
            provider: invoice.provider,
            status: 'paid',
            amount: invoice.amount.amount,
            currency: invoice.amount.currency,
            ...(invoice.customerId !== undefined ? { customerId: invoice.customerId } : {}),
            ...(invoice.subscriptionId !== undefined
              ? { subscriptionId: invoice.subscriptionId }
              : {}),
            paidAt: new Date(),
            payload: invoice.payload,
          });
          synced += 1;
        } else {
          skipped += 1;
        }
      }
      this.logger.info(
        `  ${customerId}: ${invoices.length} invoice(s), ${invoices.length - skipped} synced, ${skipped} skipped (non-paid)`,
      );
    }
    this.logger.success(`Synced ${synced} paid invoice(s) across ${customers.length} customer(s).`);
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
