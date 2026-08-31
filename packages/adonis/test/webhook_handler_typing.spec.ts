import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WEBHOOK_EVENT_TYPES } from '../src/billing/webhook_events.js';
import type { WebhookEvent } from '../src/types.js';
import {
  assertWebhookHandlerTypes,
  defineWebhookHandler,
  normalizeWebhookHandlerModule,
} from '../src/webhook_handlers.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const typescriptPackage = require.resolve('typescript/package.json');
const tsc = join(
  dirname(typescriptPackage),
  (JSON.parse(readFileSync(typescriptPackage, 'utf8')) as { bin: { tsc: string } }).bin.tsc,
);

/**
 * `WebhookEvent<T = unknown>` plus `WebhookHandler = (event: WebhookEvent) => …` forced every
 * handler in the consuming app to open with `const data = event.data as PaymentWebhookData` —
 * five handlers, and this package's own `make:webhook-handler` stub, all casting. A cast is a
 * claim nothing checks, and on `payment.disputed` the claim was simply false: that event
 * carries a `DisputeWebhookData`, whose `amount` and `currency` are optional because a Stripe
 * early fraud warning has neither.
 */
describe('defineWebhookHandler', () => {
  it('hands the handler the payload its event type actually carries', async () => {
    let seen: string | undefined;
    const handler = defineWebhookHandler('payment.disputed', async (event) => {
      // No cast. `event.data` is a DisputeWebhookData because the type says so.
      seen = event.data.actionableUntil;
    });

    await handler({
      id: 'evt_1',
      provider: 'asaas',
      type: 'payment.disputed',
      data: { gatewayId: 'pay_1', actionableUntil: '2026-09-01T00:00:00.000Z' },
      raw: {},
    } as WebhookEvent);

    expect(seen).toBe('2026-09-01T00:00:00.000Z');
  });

  it('is usable as BOTH wiring styles — a folder default export and a config handler', () => {
    const handler = defineWebhookHandler('payment.succeeded', () => {});

    // The conventions folder reads `{ type, handle }` off the default export…
    expect(normalizeWebhookHandlerModule(handler)).toEqual({
      type: 'payment.succeeded',
      entry: expect.any(Function),
    });
    // …and `billing.handlers` wants a plain callable. One value serves both.
    expect(typeof handler).toBe('function');
  });

  /**
   * The compile-time half, which is the whole point of the map: a runtime test cannot
   * observe "this would not have compiled". The program below is type-checked with the
   * package's own compiler options.
   */
  describe('type checking', () => {
    const dirs: string[] = [];
    afterEach(async () => {
      await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
    });

    async function errorsIn(body: string): Promise<string[]> {
      const dir = await mkdtemp(join(tmpdir(), 'payments-types-'));
      dirs.push(dir);
      const file = join(dir, 'probe.ts');
      const source = `import { defineWebhookHandler } from '${join(here, '../src/webhook_handlers.js').replace(/\\/g, '/')}'\n${body}\n`;
      const tsconfig = join(dir, 'tsconfig.json');
      await Promise.all([
        writeFile(file, source),
        writeFile(
          tsconfig,
          JSON.stringify({
            compilerOptions: {
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              exactOptionalPropertyTypes: true,
              noUncheckedIndexedAccess: true,
            },
            files: ['./probe.ts'],
          }),
        ),
      ]);
      // Shelling out to `tsc` rather than driving the compiler API keeps this working across
      // TypeScript majors: TS 7 (the native compiler) no longer ships `createProgram`.
      const result = spawnSync(process.execPath, [tsc, '-p', tsconfig, '--pretty', 'false'], {
        encoding: 'utf8',
      });
      if (result.error) throw result.error;
      const errors: string[] = [];
      for (const line of `${result.stdout}\n${result.stderr}`.split('\n')) {
        const match = /^.*probe\.ts\(\d+,\d+\): error TS\d+: (.*)$/.exec(line);
        if (match) errors.push(match[1]!);
        // `--pretty false` continues a multi-line message on indented lines.
        else if (/^\s+\S/.test(line) && errors.length > 0)
          errors[errors.length - 1] += ` ${line.trim()}`;
      }
      return errors;
    }

    it('accepts a handler reading its own event type payload', async () => {
      expect(
        await errorsIn(
          "defineWebhookHandler('payment.disputed', (event) => { void event.data.actionableUntil })",
        ),
      ).toEqual([]);
    });

    it('REFUSES the wrong pairing — a payment field read off a dispute event', async () => {
      const errors = await errorsIn(
        "defineWebhookHandler('payment.disputed', (event) => { void event.data.paidAt })",
      );
      expect(errors.join('\n')).toMatch(/paidAt/);
    });

    it('leaves a driver passthrough type as `unknown` rather than inventing a shape', async () => {
      // `payment_anticipated` is what Asaas' unmapped-event branch emits. Nothing normalized
      // it, so claiming it has `externalReference` would be the same lie one level down.
      const errors = await errorsIn(
        "defineWebhookHandler('payment_anticipated', (event) => { void (event.data as { x?: 1 }).x })",
      );
      expect(errors).toEqual([]);
    });
  });
});

/**
 * A typo in `eventType` was a silent no-op end to end: `normalizeWebhookHandlerModule`
 * accepted any string, the provider did `handlers[type] = …`, and the processor looked up
 * `#handlers[event.type]` and skipped a miss. So `'payment.suceeded'` registered a handler
 * nothing ever called — while the ledger recorded the event as processed and the route
 * answered 200, promising the gateway it never has to send it again.
 */
describe('assertWebhookHandlerTypes', () => {
  it('refuses a misspelled canonical type, naming the file and the real types', () => {
    expect(() =>
      assertWebhookHandlerTypes([
        { type: 'payment.suceeded', source: 'app/payment_handlers/grant.ts' },
      ]),
    ).toThrow(/payment\.suceeded/);
    expect(() =>
      assertWebhookHandlerTypes([
        { type: 'payment.suceeded', source: 'app/payment_handlers/grant.ts' },
      ]),
    ).toThrow(/app\/payment_handlers\/grant\.ts/);
    expect(() => assertWebhookHandlerTypes([{ type: 'payment.suceeded', source: 'x' }])).toThrow(
      /payment\.succeeded/,
    );
  });

  it('accepts every canonical type', () => {
    expect(() =>
      assertWebhookHandlerTypes(WEBHOOK_EVENT_TYPES.map((type) => ({ type, source: type }))),
    ).not.toThrow();
  });

  it('accepts a driver passthrough, which is the honest half of the rule', () => {
    // Drivers lowercase what they cannot map: Asaas' PAYMENT_ANTICIPATED, Adyen's
    // REPORT_AVAILABLE. Those are real deliveries, and no library can enumerate them.
    expect(() =>
      assertWebhookHandlerTypes([
        { type: 'payment_anticipated', source: 'a.ts' },
        { type: 'report_available', source: 'b.ts' },
      ]),
    ).not.toThrow();
  });

  it('accepts a dotted gateway type when the app declares it a passthrough', () => {
    expect(() =>
      assertWebhookHandlerTypes([{ type: 'subscription.paused', source: 'a.ts' }], {
        passthroughEvents: ['subscription.paused'],
      }),
    ).not.toThrow();
    expect(() =>
      assertWebhookHandlerTypes([{ type: 'subscription.paused', source: 'a.ts' }]),
    ).toThrow(/subscription\.paused/);
  });

  it('refuses two handlers for one type, naming both — the second silently replaced the first', () => {
    expect(() =>
      assertWebhookHandlerTypes([
        { type: 'payment.succeeded', source: 'app/payment_handlers/grant.ts' },
        { type: 'payment.succeeded', source: 'app/payment_handlers/receipt.ts' },
      ]),
    ).toThrow(/grant\.ts.*receipt\.ts/s);
  });
});
