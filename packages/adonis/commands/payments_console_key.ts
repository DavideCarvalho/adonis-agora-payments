import { readFileSync } from 'node:fs';
import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import type { PaymentsConfig } from '../src/define_config.js';
import { appKeyOf, consoleCommandKeys } from '../src/federation/console.js';

/**
 * `node ace payments:console-key` — the public key another app's federated console seals this
 * app's console commands to (token mode: `consoleCommands.verifyTenant`, without `crypto`). Paste
 * it as that console's `apps.<key>.controlPlane.publicKey`. It is derived from `APP_KEY` and the
 * `consoleCommands.prefix`, so it changes when either does. It is public: printing it is safe.
 */
export default class PaymentsConsoleKey extends BaseCommand {
  static override commandName = 'payments:console-key';
  static override description =
    "Print the public key a federated console seals this app's console commands to (token mode)";
  static override options: CommandOptions = { startApp: true };

  @flags.string({ description: 'The consoleCommands prefix (default: the configured one)' })
  declare prefix?: string;

  override async run(): Promise<void> {
    const config = this.app.config.get<PaymentsConfig>('payments', {});
    const option =
      config.consoleCommands && typeof config.consoleCommands === 'object'
        ? config.consoleCommands
        : {};
    const prefix = this.prefix ?? option.prefix ?? this.#packageName();
    if (!prefix) {
      this.logger.error('No consoleCommands.prefix (and no package.json name): pass --prefix');
      this.exitCode = 1;
      return;
    }
    const appKey = await appKeyOf(this.app);
    if (!appKey || appKey.length < 16) {
      this.logger.error('No APP_KEY (16+ characters): the console-command key is derived from it');
      this.exitCode = 1;
      return;
    }
    const { d: _private, ...publicKey } = consoleCommandKeys(appKey, prefix).publicKey;
    // Only the JSON on stdout, so it can be piped into the console app's environment.
    process.stdout.write(`${JSON.stringify(publicKey)}\n`);
  }

  #packageName(): string {
    try {
      const pkg = JSON.parse(readFileSync(this.app.makePath('package.json'), 'utf8')) as {
        name?: unknown;
      };
      if (typeof pkg.name === 'string' && pkg.name !== '') return pkg.name.replace(/^@[^/]+\//, '');
    } catch {
      // No package.json: --prefix is then required.
    }
    return '';
  }
}
