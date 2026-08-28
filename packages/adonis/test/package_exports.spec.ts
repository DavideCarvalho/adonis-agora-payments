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

/**
 * A published stub is code the library writes into somebody's app. If it imports a symbol
 * the package does not export, the very first file `node ace make:billable` produces does
 * not compile — and nothing inside this repo notices, because the stub is a `.stub` and no
 * build ever reads it.
 *
 * That is exactly what happened: `make/billable/main.stub` imported `withBillable` from the
 * package root, which exported `BillingCustomer` and friends but none of the three mixin
 * functions. Every scaffold the command has ever produced was broken.
 */
describe('published stubs', () => {
  it('only import symbols the package actually exports', async () => {
    const stubsDir = fileURLToPath(new URL('../stubs/', import.meta.url));
    const root = (await import('../src/index.js')) as Record<string, unknown>;

    const missing: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const full = `${dir}${item.name}`;
        if (item.isDirectory()) {
          await walk(`${full}/`);
          continue;
        }
        if (!item.name.endsWith('.stub')) continue;
        const text = await readFile(full, 'utf-8');
        // Only the package ROOT: a subpath is covered by the export-map test above.
        for (const match of text.matchAll(
          /import\s*\{([^}]+)\}\s*from\s*'@adonis-agora\/payments'/g,
        )) {
          for (const raw of (match[1] as string).split(',')) {
            const name = raw
              .trim()
              .replace(/^type\s+/, '')
              .split(/\s+as\s+/)[0]
              ?.trim();
            if (name && root[name] === undefined) missing.push(`${item.name}: ${name}`);
          }
        }
      }
    };
    await walk(stubsDir);

    expect(
      missing,
      `stubs import symbols the package root does not export: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
