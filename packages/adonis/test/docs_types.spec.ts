import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The API reference restates the domain unions as prose-adjacent TypeScript, which drifts
 * silently: `authorized` and `paused` were added to the types — each because the old
 * mapping granted or withheld access wrongly — and the page went on listing the six-member
 * unions for weeks. A reader checking whether a status exists reads the docs, not the
 * `.d.ts`, so a stale union here is a wrong answer with a citation.
 *
 * This compares members, not formatting: the page may wrap however it reads best.
 */
describe('api-reference domain unions', () => {
  const read = (path: string) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf-8');

  const members = (source: string, name: string): string[] => {
    // A union may be written out, or derived from a `const` list — `PaymentMethodName` is
    // `(typeof PAYMENT_METHOD_NAMES)[number]`, because the routing error message needs the
    // members at runtime and spelling them twice is how that message went stale. Read the
    // list in that case; the docs still spell the union out, which is what a reader wants.
    const derived = source.match(
      new RegExp(`\\btype ${name}\\s*=\\s*\\(typeof (\\w+)\\)\\[number\\]`),
    );
    const key = derived ? `${derived[1]} = [` : `type ${name}\\s*=`;
    const body = derived
      ? source.split(key)[1]
      : source.split(new RegExp(`\\btype ${name}\\s*=`))[1];
    if (body === undefined) throw new Error(`union ${name} not found`);
    // Stop at the first line that starts a new declaration or leaves the code block.
    const block = body.split(/\n(?=(?:\/\/|type |interface |```|export ))/)[0] ?? '';
    return [...block.matchAll(/'([a-z_]+)'/g)].map((match) => match[1] as string).sort();
  };

  const UNIONS = ['BillingStatus', 'SubscriptionStatus', 'PaymentMethodType', 'PaymentMethodName'];

  it.each(UNIONS)('documents every member of %s', async (name) => {
    const [types, docs] = await Promise.all([
      read('../src/types.ts'),
      read('../../../docs/api-reference.mdx'),
    ]);

    const inCode = members(types, name);
    const inDocs = members(docs, name);
    expect(inCode.length, `${name} parsed as empty — did the declaration move?`).toBeGreaterThan(1);

    expect(
      inDocs,
      `docs/api-reference.mdx lists ${name} as [${inDocs}] but src/types.ts says [${inCode}]`,
    ).toEqual(inCode);
  });
});

/**
 * The diagnostics page is a table of every event on the bus, and it is the only place an
 * app author learns one exists. `payment.disputed` was published by the processor for weeks
 * without ever appearing there — an event nobody can subscribe to because nobody knows its
 * name is the same as an event that does not exist.
 */
describe('diagnostics documentation', () => {
  it('documents every event on the bus', async () => {
    const [source, docs] = await Promise.all([
      readFile(fileURLToPath(new URL('../src/diagnostics.ts', import.meta.url)), 'utf-8'),
      readFile(fileURLToPath(new URL('../../../docs/diagnostics.mdx', import.meta.url)), 'utf-8'),
    ]);

    const block = source.split('PAYMENTS_DIAGNOSTIC_EVENTS = [')[1]?.split(']')[0] ?? '';
    const published = [...block.matchAll(/'([a-z]+\.[a-z_.]+)'/g)].map((m) => m[1] as string);
    expect(published.length, 'no events parsed — did the constant move?').toBeGreaterThan(1);

    // The table's first cell, so a passing mention in prose does not count as documented.
    const rows = [...docs.matchAll(/^\| `([a-z]+\.[a-z_.]+)` \|/gm)].map((m) => m[1] as string);
    const missing = published.filter((event) => !rows.includes(event));
    expect(
      missing,
      `published on the bus but absent from the table in docs/diagnostics.mdx: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
