import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import loader from '../commands/main.js';

/**
 * Every command file must be in the barrel.
 *
 * `commands/main.ts` is a hand-maintained `ListLoader` array, and ace only ever sees what
 * that array names. A command added to the folder and forgotten here is not a broken
 * command — it is an ABSENT one: `node ace` never lists it, and the failure is a "command
 * not found" for a file that exists in the published package.
 */
describe('commands barrel', () => {
  it('registers every command in the commands folder', async () => {
    const dir = fileURLToPath(new URL('../commands', import.meta.url));
    const files = (await readdir(dir))
      .filter((file) => file.endsWith('.ts') && file !== 'main.ts')
      .map((file) => file.replace(/\.ts$/, ''));

    const registered = (await loader.getMetaData()).map((meta) => meta.commandName);

    // `payments:webhook` lives in `payments_webhook.ts`, `make:billable` in
    // `make_billable.ts` — the file name is the command name with `:`/`-` as `_`.
    const asFileName = (commandName: string) => commandName.replace(/[:-]/g, '_');
    const missing = files.filter((file) => !registered.some((name) => asFileName(name) === file));

    expect(missing, `not registered in commands/main.ts: ${missing.join(', ')}`).toEqual([]);
  });

  it('exposes payments:health with its thresholds as flags', async () => {
    const health = (await loader.getMetaData()).find(
      (meta) => meta.commandName === 'payments:health',
    );
    expect(health).toBeDefined();
    const flagNames = (health?.flags ?? []).map((flag) => flag.name);
    expect(flagNames).toEqual(
      expect.arrayContaining(['stuckAfter', 'unconfirmedAfter', 'window', 'json']),
    );
  });
});
