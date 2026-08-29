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
      // | link | methods | charge | refunds | subscriptions | invoices | disputes | webhook auth |
      // The methods cell was NOT gated at first, so when two drivers widened their
      // supportedMethods the table went stale in silence — the exact drift this test is
      // supposed to make impossible.
      const methods = (source.match(/supportedMethods = \[([^\]]*)\]/)?.[1] ?? '')
        .split(',')
        .map((entry) => entry.trim().replace(/'/g, ''))
        .filter(Boolean)
        .map((name) => (name === 'undefined' ? 'any' : name.replace(/_/g, ' ')));
      expect(cells[2], `${slug}: methods cell disagrees with supportedMethods`).toBe(
        methods.join(', ') || '—',
      );
      // Whether the gateway can be charged from the server at all. Four are checkout-only —
      // their `charge()` opens with a throw — and that is the difference a reader most needs
      // up front: every other column is moot if the charge call cannot be made.
      const chargeBody =
        source.match(/async charge\([\s\S]*?\)[^{]*\{\s*([\s\S]{0,40})/)?.[1] ?? '';
      expect(cells[3], `${slug}: charge cell disagrees with the driver`).toBe(
        chargeBody.trimStart().startsWith('throw') ? 'checkout only' : 'server',
      );
      expect(cells[4], `${slug}: refunds cell disagrees with the driver`).toBe(supports('refunds'));
      expect(cells[5], `${slug}: subscriptions cell disagrees`).toBe(supports('subscriptions'));
      expect(cells[6], `${slug}: invoices cell disagrees`).toBe(supports('invoices'));
      expect(cells[7], `${slug}: disputes cell disagrees`).toBe(supports('disputes'));
      // A driver returns the literal `'configured'` only from `webhookVerification`, so its
      // presence is exactly "this gateway signs its deliveries and we can check it". The two
      // without it sign nothing at all — a dash there is the gateway's gap, not the driver's.
      expect(cells[8], `${slug}: webhook-auth cell disagrees`).toBe(
        source.includes("'configured'") ? '\u2705' : '\u2014',
      );
    }
  });

  /**
   * `externalReference` is the only thing tying a gateway's webhook back to the app's own
   * row, and each gateway hides it in a different field — `correlationID`, `reference_id`,
   * `notes`, a txid. A page that omits it documents everything except the one thing a
   * reader cannot work out from the gateway's own site.
   */
  it('names externalReference on every provider page', async () => {
    const pages = await Promise.all(
      (await slugs()).map(async (slug) => ({
        slug,
        body: await readFile(`${docsDir}${slug}.mdx`, 'utf-8'),
      })),
    );
    const silent = pages.filter((page) => !page.body.includes('externalReference'));
    expect(
      silent.map((page) => page.slug),
      `provider pages that never mention externalReference: ${silent.map((p) => p.slug).join(', ')}`,
    ).toEqual([]);
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

  /**
   * The gateway count is a selling point, so it is written on four surfaces nobody edits
   * when a driver lands: two npm descriptions and two docs descriptions. It went stale
   * exactly that way — the package advertised four gateways while eighteen shipped, and
   * nothing failed, because a description is not code. It is now.
   */
  it('advertises the real number of gateways everywhere it claims one', async () => {
    const count = (await slugs()).length;
    const claim = new RegExp(`\\b${count} (?:payment )?gateways\\b`);
    const read = async (path: string) =>
      readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf-8');

    const surfaces = [
      {
        name: 'packages/adonis/package.json',
        text: JSON.parse(await read('../package.json')).description as string,
      },
      {
        name: 'package.json (repo root)',
        text: JSON.parse(await read('../../../package.json')).description as string,
      },
      {
        name: 'docs/meta.json',
        text: JSON.parse(await read('../../../docs/meta.json')).description as string,
      },
      {
        name: 'docs/index.mdx (frontmatter)',
        text: (await read('../../../docs/index.mdx')).match(/^description:\s*(.+)$/m)?.[1] ?? '',
      },
    ];

    const stale = surfaces.filter((surface) => !claim.test(surface.text));
    expect(
      stale.map((surface) => `${surface.name}: ${surface.text}`),
      `descriptions that do not say "${count} gateways" — ${count} drivers ship`,
    ).toEqual([]);
  });

  /**
   * npm search is how someone with an Adyen account finds out this package already speaks
   * Adyen. Ten drivers shipped without ever reaching the keywords, so the package was
   * unfindable by the name of the gateway it supported.
   */
  it('names every gateway in the npm keywords', async () => {
    /** Drivers whose gateway is sold under a different name than the file. */
    const aliases: Record<string, string> = { abacate: 'abacatepay' };
    const keywords = new Set<string>(
      JSON.parse(
        await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'),
      ).keywords,
    );
    const missing = (await slugs()).filter(
      (slug) => !keywords.has(slug) && !keywords.has(aliases[slug] ?? slug),
    );
    expect(
      missing,
      `drivers absent from the npm keywords — unfindable by gateway name: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
