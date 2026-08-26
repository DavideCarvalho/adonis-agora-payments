import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import type { PaymentsConfig } from '../src/define_config.js';
import { PaymentsManager } from '../src/payments_manager.js';

/**
 * The webhook events each gateway needs, with the capability each event depends on.
 * Events whose capability is `false` on the resolved driver are filtered out, so a
 * Woovi provider never advertises refund events and an AbacatePay without billing
 * subscriptions never advertises subscription events. Keyed by the driver's own
 * `provider` id (not the config key), so custom providers built on top of a built-in
 * factory get the right list too.
 */
const EVENTS_BY_PROVIDER: Record<
  string,
  Array<{ event: string; requires?: 'refunds' | 'invoices' | 'subscriptions' }>
> = {
  stripe: [
    { event: 'checkout.session.completed' },
    { event: 'invoice.payment_succeeded', requires: 'invoices' },
    { event: 'customer.subscription.created', requires: 'subscriptions' },
    { event: 'customer.subscription.updated', requires: 'subscriptions' },
    { event: 'customer.subscription.deleted', requires: 'subscriptions' },
  ],
  asaas: [
    { event: 'PAYMENT_CREATED' },
    { event: 'PAYMENT_RECEIVED' },
    { event: 'PAYMENT_OVERDUE' },
    { event: 'PAYMENT_REFUNDED', requires: 'refunds' },
    { event: 'SUBSCRIPTION_CREATED', requires: 'subscriptions' },
    { event: 'SUBSCRIPTION_UPDATED', requires: 'subscriptions' },
    { event: 'SUBSCRIPTION_DELETED', requires: 'subscriptions' },
  ],
  abacate: [
    { event: 'checkout.completed' },
    { event: 'checkout.refunded', requires: 'refunds' },
    { event: 'subscription.completed', requires: 'subscriptions' },
    { event: 'subscription.renewed', requires: 'subscriptions' },
    { event: 'subscription.cancelled', requires: 'subscriptions' },
  ],
  woovi: [
    { event: 'PIX_AUTOMATIC_APPROVED' },
    { event: 'PIX_AUTOMATIC_REJECTED' },
    { event: 'PIX_AUTOMATIC_COBR_COMPLETED' },
    { event: 'CHARGE_COMPLETED' },
    { event: 'CHARGE_EXPIRED' },
  ],
};

/**
 * `node ace payments:webhook` — print the webhook endpoints to register in each
 * configured payment provider's dashboard, with the events each provider needs. The
 * gateway dashboards require manual registration (unlike a `cashier:webhook`-style API
 * call), so this command surfaces the exact URL + event list to paste. Events are
 * filtered by the driver's declared capabilities.
 */
export default class PaymentsWebhook extends BaseCommand {
  static override commandName = 'payments:webhook';
  static override description = 'Show the webhook endpoints to register in each payment provider';
  static override options: CommandOptions = { allowUnknownFlags: true };

  @flags.string({ description: 'Only show this provider (a key of config/providers)' })
  declare provider?: string;

  override async run(): Promise<void> {
    const config = this.app.config.get<PaymentsConfig>('payments', {});
    const names = Object.keys(config.providers ?? {}).filter((name) =>
      this.provider === undefined ? true : name === this.provider,
    );

    if (names.length === 0) {
      this.logger.info('No payment providers configured. Add providers to config/payments.ts.');
      return;
    }

    const manager = await this.app.container.make(PaymentsManager);
    for (const name of names) {
      // Resolve the real driver so custom providers (e.g. a wrapped Asaas) report the
      // correct event list and capabilities instead of falling back to '*'.
      const driver = manager.driver(name);
      const all = EVENTS_BY_PROVIDER[driver.provider] ?? [];
      const events = all
        .filter(
          (entry) =>
            entry.requires === undefined || driver.capabilities?.[entry.requires] !== false,
        )
        .map((entry) => entry.event);

      this.logger.info(`\n[${name}] (${driver.provider})`);
      this.logger.info(`  URL: ${this.app.makeURL(`/payments/webhook/${name}`)}`);
      this.logger.info(
        events.length > 0
          ? `  Events: ${events.join(', ')}`
          : '  Events: * (unknown driver — register all events)',
      );
    }
    this.logger.info(
      '\nRegister these endpoints in the provider dashboard. Webhook payloads are validated by the provider driver.',
    );
  }
}
