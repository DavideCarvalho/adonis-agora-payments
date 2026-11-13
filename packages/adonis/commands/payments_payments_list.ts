import { flags } from '@adonisjs/core/ace';
import { money, PaymentsConsoleCommand } from '../src/cli/console_command.js';
import { CONSOLE_ROUTES } from '../src/dashboard/api_core.js';

/** `node ace payments:payments:list` — the console's payments list, newest first. */
export default class PaymentsPaymentsList extends PaymentsConsoleCommand {
  static override commandName = 'payments:payments:list';
  static override description = 'List payments, newest first (exact lookups by reference and ids)';

  @flags.string({ description: 'Payment status (paid, pending, failed, refunded, disputed…)' })
  declare status?: string;

  @flags.string({ description: 'Gateway name, e.g. stripe, asaas' })
  declare provider?: string;

  @flags.string({ description: "The app's own reference (exact)" })
  declare reference?: string;

  @flags.string({ description: 'Gateway payment id (exact)' })
  declare gatewayId?: string;

  @flags.string({ description: 'Gateway customer id (exact)' })
  declare customerId?: string;

  @flags.number({ description: 'Page number, 1-based' })
  declare page?: number;

  @flags.number({ description: 'Rows per page (default 50, at most 200)' })
  declare size?: number;

  protected async handle(): Promise<void> {
    const query = this.listQuery(
      {
        status: this.status,
        provider: this.provider,
        externalReference: this.reference,
        gatewayId: this.gatewayId,
        customerId: this.customerId,
      },
      { page: this.page, size: this.size },
    );
    const body = this.bodyOf(await this.serve(CONSOLE_ROUTES.payments, { query }));
    this.printList(body, [
      ['gateway id', (r) => r.gatewayId],
      ['provider', (r) => r.provider],
      ['status', (r) => r.status],
      ['amount', (r) => money(r.amount, r.currency)],
      ['refunded', (r) => money(r.refundedAmount, r.currency)],
      ['reference', (r) => r.externalReference],
      ['owner', (r) => ownerLabel(r.owner)],
      ['created', (r) => r.createdAt],
    ]);
  }
}

function ownerLabel(owner: unknown): string | null {
  if (owner === null || typeof owner !== 'object') return null;
  const o = owner as { type: string | null; id: string | null; email: string | null };
  return o.email ?? (o.type !== null && o.id !== null ? `${o.type}:${o.id}` : null);
}
