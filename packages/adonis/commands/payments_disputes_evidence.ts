import { readFile } from 'node:fs/promises';
import { args, flags } from '@adonisjs/core/ace';
import { CliError, PaymentsActionCommand } from '../src/cli/console_command.js';
import { CONSOLE_ROUTES } from '../src/dashboard/api_core.js';

/**
 * `node ace payments:disputes:evidence <gatewayId> --file=evidence.json` — submit evidence for an
 * open dispute through its gateway (a representment). MOST GATEWAYS ACCEPT IT ONCE: asks for
 * confirmation unless `--force`; `--dry-run` checks everything and sends nothing.
 *
 * `--file` is a JSON `DisputeEvidence` (`explanation`, `documents: [{ kind, id }]` of files already
 * uploaded to the gateway, `priorUndisputedPayments`, …); `--explanation` sets or overrides the
 * free-text explanation.
 */
export default class PaymentsDisputesEvidence extends PaymentsActionCommand {
  static override commandName = 'payments:disputes:evidence';
  static override description =
    'Submit evidence for an open dispute through its gateway (most accept it once)';

  @args.string({ description: 'Gateway dispute id' })
  declare gatewayId: string;

  @flags.string({ description: 'Path to a JSON file with the evidence (DisputeEvidence)' })
  declare file?: string;

  @flags.string({ description: 'Free-text explanation (sets or overrides the file one)' })
  declare explanation?: string;

  protected async handle(): Promise<void> {
    const evidence = await this.readEvidence();
    const req = {
      params: { gatewayId: this.gatewayId },
      body: { evidence, ...this.noteBody() },
    };
    const preview = await this.preview(CONSOLE_ROUTES.evidence, req, (dry) => {
      const d = dry.dispute as { provider: string; status: string };
      const fields = (dry.evidence as { fields: string[] }).fields;
      return `Submit evidence (${fields.join(', ')}) for ${d.status} dispute ${this.gatewayId} to ${d.provider}. Most gateways accept evidence ONCE.`;
    });
    if (preview === null) return;

    const body = this.bodyOf(await this.serve(CONSOLE_ROUTES.evidence, req));
    if (this.json) return this.printJson(body);
    const dispute = body.dispute as { gatewayStatus: string };
    this.logger.success(
      `Evidence submitted for dispute ${this.gatewayId} (gateway status: ${dispute.gatewayStatus}).`,
    );
    this.logger.info(String(body.note));
  }

  private async readEvidence(): Promise<Record<string, unknown>> {
    let evidence: Record<string, unknown> = {};
    if (this.file !== undefined) {
      let raw: string;
      try {
        raw = await readFile(this.file, 'utf8');
      } catch (error) {
        throw new CliError(
          `Cannot read ${this.file}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        evidence = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new CliError(`${this.file} is not valid JSON.`);
      }
    }
    if (this.explanation !== undefined) evidence = { ...evidence, explanation: this.explanation };
    if (this.file === undefined && this.explanation === undefined) {
      throw new CliError('Give the evidence with --file=<evidence.json> and/or --explanation.');
    }
    return evidence;
  }
}
