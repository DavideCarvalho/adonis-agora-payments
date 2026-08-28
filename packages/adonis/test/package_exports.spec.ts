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
  /**
   * Every name the package ROOT exports as a TYPE.
   *
   * A type-only import cannot be checked the way a value can — `import('../src/index.js')`
   * returns the runtime namespace, where a type is simply absent, so asking the module
   * whether it exports `PaymentWebhookData` gets `undefined` for "not exported" and
   * `undefined` for "exported, but it's a type". This reads the barrel instead, which is
   * the authority for the root's surface: `src/index.ts` re-exports and declares, and
   * contains no `export *` (that would make this text scan lie, so it is asserted below).
   */
  const rootTypeExports = async (text: string): Promise<Set<string>> => {
    const names = new Set<string>();
    for (const match of text.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
      for (const raw of (match[1] as string).split(',')) {
        const name = raw
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)
          .at(-1)
          ?.trim();
        if (name) names.add(name);
      }
    }
    for (const match of text.matchAll(
      /export\s+(?:declare\s+)?(?:type|interface|class|function|const|enum)\s+([A-Za-z0-9_$]+)/g,
    )) {
      names.add(match[1] as string);
    }
    return names;
  };

  it('only import symbols the package actually exports', async () => {
    const stubsDir = fileURLToPath(new URL('../stubs/', import.meta.url));
    const root = (await import('../src/index.js')) as Record<string, unknown>;
    const indexSource = await readFile(
      fileURLToPath(new URL('../src/index.ts', import.meta.url)),
      'utf-8',
    );
    // The text scan above only sees what the barrel spells out. A star re-export would
    // add names it cannot see, and every missing type would pass as "exported".
    expect(
      indexSource,
      'src/index.ts gained an `export *`, which this scan cannot follow',
    ).not.toMatch(/^export\s+\*/m);
    const typeExports = await rootTypeExports(indexSource);

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
        // `import type { … }` is matched too — it used to fall outside this regex, so a
        // stub could import a type that does not exist and this test stayed green.
        for (const match of text.matchAll(
          /import\s+(type\s+)?\{([^}]+)\}\s*from\s*'@adonis-agora\/payments'/g,
        )) {
          const typeOnly = match[1] !== undefined;
          for (const raw of (match[2] as string).split(',')) {
            const cleaned = raw.trim().replace(/^type\s+/, '');
            const name = cleaned.split(/\s+as\s+/)[0]?.trim();
            if (!name) continue;
            // A value import must resolve at runtime; a type import can only be read off
            // the barrel. `import { type Foo }` is a type in a value import statement.
            const isType = typeOnly || cleaned !== raw.trim();
            const exported = isType ? typeExports.has(name) : root[name] !== undefined;
            if (!exported) missing.push(`${item.name}: ${name}`);
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
