import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { LucidBillingStore } from '../src/billing/lucid_billing_store.js';
import type { PaymentsConfig } from '../src/define_config.js';
import { PaymentsManager } from '../src/payments_manager.js';

/**
 * `node ace payments:sync [--provider=stripe] [--customer=cus_123]` — reconcile local
 * billing records with the gateway. Useful after missed webhooks or manual dashboard
 * changes: pulls recent invoices for a customer and upserts them into the local store,
 * so the billing tables converge with the gateway.
 */
export default class PaymentsSync extends BaseCommand {
  static override commandName = 'payments:sync';
  static override description = 'Reconcile local billing records with a payment provider';
  static override options: CommandOptions = { allowUnknownFlags: true };

  @flags.string({ description: 'Provider to sync (a key of config/providers)' })
  declare provider?: string;

  @flags.string({ description: 'Gateway customer id to sync invoices for' })
  declare customer?: string;

  override async run(): Promise<void> {
    const config = this.app.config.get<PaymentsConfig>('payments', {});
    if (config.billing?.enabled === false) {
      this.logger.error(
        'The billing layer is disabled (billing.enabled = false). Nothing to sync.',
      );
      return;
    }
    if (!this.customer) {
      this.logger.error('Pass --customer=<gateway customer id> to sync invoices for a customer.');
      return;
    }

    const manager = await this.app.container.make(PaymentsManager);
    const driver = manager.driver(this.provider);
    // Some gateways (Woovi/OpenPix) have no invoice concept — fail early with a clear
    // message instead of listing nothing.
    manager.assertCapability(driver, 'invoices');
    const store = new LucidBillingStore();

    this.logger.info(`Syncing invoices for customer ${this.customer} via ${driver.provider}...`);
    const invoices = await driver.listInvoices(this.customer);
    let synced = 0;
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
      }
    }
    this.logger.success(`Synced ${synced} paid invoice(s).`);
  }
}
