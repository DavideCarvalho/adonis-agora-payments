import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { payments } from '../src/define_config.js';

/**
 * Every driver on disk must be reachable, documented and navigable.
 *
 * This is the recurring bug class in this codebase: something exists, is correct, is
 * tested — and is wired to nothing. A driver with no factory in `payments` cannot be named
 * in `config/payments.ts` at all, so it is not a limited feature, it is an absent one; and
 * its unit tests pass either way, because they construct the class directly.
 */
describe('driver registry', () => {
  const driversDir = fileURLToPath(new URL('../src/drivers/', import.meta.url));
  const docsDir = fileURLToPath(new URL('../../../docs/providers/', import.meta.url));

  /** Driver slugs = the files in src/drivers, minus the shared helpers. */
  const slugs = async (): Promise<string[]> =>
    (await readdir(driversDir))
      .filter((file) => file.endsWith('.ts') && file !== 'shared.ts')
      .map((file) => file.replace(/\.ts$/, ''))
      .sort();

  it('exposes a factory in `payments` for every driver', async () => {
    const factories = new Set(Object.keys(payments));
    const missing = (await slugs()).filter((slug) => !factories.has(slug));
    expect(
      missing,
      `drivers with no payments.<name>() factory — unreachable from config: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('has a docs page for every driver', async () => {
    const pages = new Set(
      (await readdir(docsDir))
        .filter((file) => file.endsWith('.mdx'))
        .map((file) => file.replace(/\.mdx$/, '')),
    );
    const missing = (await slugs()).filter((slug) => !pages.has(slug));
    expect(missing, `drivers with no docs/providers page: ${missing.join(', ')}`).toEqual([]);
  });

  it('re-exports every driver config type from the package root', async () => {
    // A config type that stops at `define_config.ts` cannot be imported from the package
    // root the way the original four can, so an app annotating its own config has to reach
    // into an internal path. The asymmetry is invisible until someone tries.
    const index = await readFile(
      fileURLToPath(new URL('../src/index.ts', import.meta.url)),
      'utf-8',
    );
    const declared = await Promise.all(
      (await slugs()).map(async (slug) => {
        const source = await readFile(`${driversDir}${slug}.ts`, 'utf-8');
        return source.match(/export interface (\w+DriverConfig)/)?.[1];
      }),
    );
    const missing = declared
      .filter((name): name is string => name !== undefined)
      .filter((name) => !index.includes(name));
    expect(
      missing,
      `driver config types not re-exported from src/index.ts: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('keeps the providers comparison table in step with the drivers', async () => {
    // The table is the page a reader compares gateways on, and every cell in it is a fact
    // that lives in code — so it is generated from the drivers and checked here rather than
    // maintained by hand. A hand-kept matrix over eighteen gateways is a promise about
    // capabilities that quietly stops being true.
    const index = await readFile(`${docsDir}index.mdx`, 'utf-8');
    const table = index.split('providers:table:start')[1]?.split('providers:table:end')[0] ?? '';

    for (const slug of await slugs()) {
      const source = await readFile(`${driversDir}${slug}.ts`, 'utf-8');
      const row = table.split('\n').find((line) => line.includes(`/providers/${slug})`));
      expect(row, `no row for ${slug} in the providers table`).toBeDefined();

      const caps = source.match(/capabilities = \{([^}]*)\}/)?.[1] ?? '';
      const supports = (name: string) =>
        new RegExp(`${name}\\s*:\\s*true`).test(caps) ? '✅' : '—';
      const cells = (row ?? '').split('|').map((cell) => cell.trim());
      // | link | methods | refunds | subscriptions | invoices |
      expect(cells[3], `${slug}: refunds cell disagrees with the driver`).toBe(supports('refunds'));
      expect(cells[4], `${slug}: subscriptions cell disagrees`).toBe(supports('subscriptions'));
      expect(cells[5], `${slug}: invoices cell disagrees`).toBe(supports('invoices'));
    }
  });

  it('lists every docs page in the sidebar', async () => {
    const meta = JSON.parse(await readFile(`${docsDir}meta.json`, 'utf-8')) as { pages: string[] };
    const listed = new Set(meta.pages);
    const missing = (await slugs()).filter((slug) => !listed.has(slug));
    expect(
      missing,
      `pages that exist but are not in providers/meta.json — invisible in the sidebar: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
