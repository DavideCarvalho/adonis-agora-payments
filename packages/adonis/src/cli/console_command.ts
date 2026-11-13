import { userInfo } from 'node:os';
import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import {
  type ResolvedPaymentsTenancy,
  resolvePaymentsTenancy,
  tenantOwnerTypes,
} from '../agora/tenancy.js';
import type { BillingStore } from '../billing/billing_store.js';
import {
  consoleCapabilities,
  createConsoleActions,
  resolveAppWebhookHandlers,
  serveConsoleRoute,
} from '../dashboard/api_core.js';
import { resolveConfig } from '../dashboard/define_config.js';
import type { PaymentsApiRoute } from '../dashboard/dev_tools.js';
import type { ApiRequest, ApiResponse } from '../dashboard/handlers.js';
import type { PaymentsConfig } from '../define_config.js';
import { formatDecimal } from '../money.js';
import { PaymentsManager } from '../payments_manager.js';
import { findBillingStore } from '../services/main.js';

/** A failure the command reports as one line and exit code 1 (never a stack trace). */
export class CliError extends Error {}

/** One column of a human table: a header and how to read the cell off a row. */
export type Column = [header: string, cell: (row: Record<string, unknown>) => unknown];

/** The actor a CLI action is recorded against: `cli:<os user>`, or `cli`. */
export function cliActor(): string {
  try {
    const name = userInfo().username;
    return name ? `cli:${name}` : 'cli';
  } catch {
    return 'cli';
  }
}

/**
 * The base of the `payments:*` operator commands: every one of them serves the SAME console
 * handler the payments console's JSON API and its dev tools serve (same validation, organization
 * scope and audit trail), from the terminal. Nothing here re-implements a rule; it builds the
 * request, calls the handler, and prints the answer.
 *
 * - `--json` prints the handler's body as is (lists: `{ data, meta }`); the default is a table.
 * - `--tenant <id>` (organizations on) narrows every read to one organization, like the console's
 *   Organization picker. Without it the operator sees every organization.
 * - Any answer that is not `2xx` prints its error and exits `1`.
 */
export abstract class PaymentsConsoleCommand extends BaseCommand {
  static override options: CommandOptions = { startApp: true };

  @flags.boolean({ description: 'Print the result as JSON' })
  declare json?: boolean;

  @flags.string({
    description: 'With organizations on: narrow to this organization id (default: every one)',
  })
  declare tenant?: string;

  /** Who the audit trail records. Overridable in tests. */
  protected auditActor(): string {
    return cliActor();
  }

  override async run(): Promise<void> {
    try {
      await this.handle();
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      this.logger.error(error.message);
      this.exitCode = 1;
    }
  }

  /** The command's body. Throw {@link CliError} for a one-line failure. */
  protected abstract handle(): Promise<void>;

  protected paymentsConfig(): PaymentsConfig {
    return this.app.config.get<PaymentsConfig>('payments', {});
  }

  protected tenancy(): ResolvedPaymentsTenancy {
    return resolvePaymentsTenancy(this.paymentsConfig().tenancy);
  }

  /** The app's billing store, or a sentence saying the billing layer is off. */
  protected async store(): Promise<BillingStore> {
    if (this.paymentsConfig().billing?.enabled === false) {
      throw new CliError(
        'The billing layer is disabled (billing.enabled = false). There is nothing to operate on.',
      );
    }
    try {
      return (await this.app.container.make('payments.billingStore' as never)) as BillingStore;
    } catch {
      const store = findBillingStore();
      if (store !== undefined) return store;
      throw new CliError(
        'The billing store is not available. Make sure the PaymentsProvider is registered and `billing.enabled` is not false.',
      );
    }
  }

  /** The app's payments manager, or `undefined` when none is configured. */
  protected async manager(): Promise<PaymentsManager | undefined> {
    try {
      return await this.app.container.make(PaymentsManager);
    } catch {
      return undefined;
    }
  }

  /** Serve one console handler, scoped and attributed like the console does. */
  protected async serve(route: PaymentsApiRoute, req: Partial<ApiRequest>): Promise<ApiResponse> {
    const store = await this.store();
    const tenancy = this.tenancy();
    if (this.tenant !== undefined && !tenancy.enabled) {
      throw new CliError('`--tenant` needs organizations (tenancy) on in config/payments.ts.');
    }
    const config = this.paymentsConfig();
    const dashboard = resolveConfig(this.app.config.get('payments_dashboard', {}));
    return serveConsoleRoute({
      store,
      route,
      req: { params: req.params ?? {}, query: req.query ?? {}, body: req.body },
      currency: dashboard.currency,
      actor: this.auditActor(),
      ownerScope:
        this.tenant !== undefined
          ? {
              tenantOwnerTypes: tenantOwnerTypes(tenancy),
              tenantIds: [this.tenant],
              includeNull: false,
            }
          : undefined,
      actions: async (scoped) => {
        const manager = await this.manager();
        if (manager === undefined) return {};
        return createConsoleActions({
          manager,
          store: scoped,
          handlers: await resolveAppWebhookHandlers(this.app, config.billing?.handlers),
          tenancy: () => resolvePaymentsTenancy(config.tenancy),
        });
      },
      capabilities: async () => {
        const manager = await this.manager();
        return manager === undefined ? undefined : consoleCapabilities(manager.drivers);
      },
    });
  }

  /** The `2xx` body, or a {@link CliError} carrying the handler's error. */
  protected bodyOf(response: ApiResponse): Record<string, unknown> {
    const body = (response.body ?? {}) as Record<string, unknown>;
    if (response.status >= 200 && response.status < 300) return body;
    const error = typeof body.error === 'string' ? body.error : 'the request was refused';
    const note = typeof body.note === 'string' ? ` ${body.note}` : '';
    throw new CliError(`${error}${note} (${response.status})`);
  }

  /** `filter[field]` for each flag given, plus `page`/`size`. */
  protected listQuery(
    filters: Record<string, string | number | undefined>,
    paging: { page?: number | undefined; size?: number | undefined },
  ): Record<string, unknown> {
    const filter: Record<string, string> = {};
    for (const [field, value] of Object.entries(filters)) {
      if (value !== undefined && value !== '') filter[field] = String(value);
    }
    return {
      filter,
      ...(paging.page !== undefined ? { page: String(paging.page) } : {}),
      ...(paging.size !== undefined ? { size: String(paging.size) } : {}),
    };
  }

  /** Print a list answer: JSON as is, else a table and the paging line. */
  protected printList(body: Record<string, unknown>, columns: Column[]): void {
    if (this.json) {
      this.printJson(body);
      return;
    }
    const rows = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
    const meta = (body.meta ?? {}) as { total?: number; currentPage?: number; lastPage?: number };
    if (rows.length === 0) {
      this.logger.info('No rows.');
      return;
    }
    this.printTable(rows, columns);
    this.logger.log(
      `page ${meta.currentPage ?? 1} of ${meta.lastPage ?? 1} · ${meta.total ?? rows.length} total`,
    );
  }

  protected printTable(rows: Record<string, unknown>[], columns: Column[]): void {
    const table = this.ui.table();
    table.head(columns.map(([header]) => header));
    for (const row of rows) table.row(columns.map(([, cell]) => text(cell(row))));
    table.render();
  }

  /** Print `key: value` lines (a detail or an action result). */
  protected printFields(fields: Array<[label: string, value: unknown]>): void {
    for (const [label, value] of fields) this.logger.log(`${label}: ${text(value)}`);
  }

  protected printJson(value: unknown): void {
    this.logger.log(JSON.stringify(value, null, 2));
  }
}

/**
 * The base of an operator ACTION: `--dry-run` asks the handler what would happen and changes
 * nothing; otherwise the command asks for confirmation (unless `--force`) and `--note` is recorded
 * in the billing audit trail beside the actor.
 */
export abstract class PaymentsActionCommand extends PaymentsConsoleCommand {
  @flags.boolean({ description: 'Show what would happen without changing anything' })
  declare dryRun?: boolean;

  @flags.boolean({ description: 'Skip the confirmation prompt' })
  declare force?: boolean;

  @flags.string({ description: 'Why, recorded in the billing audit trail' })
  declare note?: string;

  /** `{ note }` for the handler's body, when one was given. */
  protected noteBody(): Record<string, unknown> {
    return this.note !== undefined && this.note !== '' ? { note: this.note } : {};
  }

  /**
   * Validate through the handler's own dry run, show what would happen, then confirm (unless
   * `--force`) — so a refused action fails before the prompt, never after the operator said yes.
   * Answers the dry-run body, or `null` when the operator declined.
   */
  protected async preview(
    route: PaymentsApiRoute,
    req: Partial<ApiRequest>,
    describe: (body: Record<string, unknown>) => string,
  ): Promise<Record<string, unknown> | null> {
    const dry = this.bodyOf(
      await this.serve(route, { ...req, body: { ...(req.body as object), dryRun: true } }),
    );
    if (this.dryRun === true) {
      if (this.json) this.printJson(dry);
      else this.logger.info(`[dry run] ${describe(dry)}`);
      return null;
    }
    if (!(await this.confirmOrAbort(`${describe(dry)} Continue?`))) return null;
    return dry;
  }

  /**
   * Ask before a destructive action, unless `--force`. Refuses (exit 1) in a non-interactive shell
   * rather than hanging on a prompt nobody can answer.
   */
  protected async confirmOrAbort(question: string): Promise<boolean> {
    if (this.force === true) return true;
    const traps = (this.prompt as unknown as { traps?: { prompts?: Map<unknown, unknown> } }).traps
      ?.prompts;
    const interactive = process.stdin.isTTY === true || (traps !== undefined && traps.size > 0);
    if (!interactive) {
      throw new CliError(
        'Refusing to run a destructive action without confirmation in a non-interactive shell. Pass --force.',
      );
    }
    const confirmed = await this.prompt.confirm(question, { name: 'confirm' });
    if (!confirmed) {
      this.logger.info('Aborted. Nothing was changed.');
      this.exitCode = 1;
    }
    return confirmed;
  }
}

/** A cell as text: `—` for nothing, JSON for an object. */
export function text(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Integer minor units as `12.34 BRL` (the right exponent per currency), or `—`. */
export function money(amount: unknown, currency: unknown): string {
  if (typeof amount !== 'number') return '—';
  const code = typeof currency === 'string' && currency !== '' ? currency : undefined;
  return code === undefined
    ? String(amount)
    : `${formatDecimal(amount, code)} ${code.toUpperCase()}`;
}
