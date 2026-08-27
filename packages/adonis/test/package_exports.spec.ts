import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The export map is the package's public surface, and Node enforces it: a subpath missing
 * from `exports` is not merely undocumented, it is a hard `ERR_PACKAGE_PATH_NOT_EXPORTED`
 * for anyone who imports it.
 *
 * This caught a real one: the docs told custom-provider authors to import the webhook
 * signature helpers from `@adonis-agora/payments/webhook_security` — the most
 * security-critical thing a custom driver touches — and that subpath was not in the map at
 * all, so following the documentation threw.
 */
describe('package exports', () => {
  const read = async (path: string) =>
    readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf-8');

  it('exports every subpath the docs tell people to import', async () => {
    const pkg = JSON.parse(await read('../package.json')) as {
      exports: Record<string, unknown>;
      name: string;
    };
    const docsDir = fileURLToPath(new URL('../../../docs/', import.meta.url));

    const mentioned = new Set<string>();
    const walk = async (dir: string): Promise<void> => {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const full = `${dir}${item.name}`;
        if (item.isDirectory()) await walk(`${full}/`);
        else if (item.name.endsWith('.mdx')) {
          const text = await readFile(full, 'utf-8');
          for (const match of text.matchAll(/@adonis-agora\/payments(\/[a-z0-9_\-/]+)/g)) {
            mentioned.add(`.${match[1]}`);
          }
        }
      }
    };
    await walk(docsDir);

    const resolves = (subpath: string) =>
      subpath in pkg.exports ||
      // Wildcard entries: `./drivers/*` covers `./drivers/stripe`.
      Object.keys(pkg.exports).some(
        (key) => key.endsWith('/*') && subpath.startsWith(key.slice(0, -1)),
      );

    const missing = [...mentioned].filter((subpath) => !resolves(subpath)).sort();
    expect(missing, `documented but not in package.json#exports: ${missing.join(', ')}`).toEqual(
      [],
    );
  });
});
