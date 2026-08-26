import type { IndexGenerator } from '@adonisjs/assembler/index_generator';
import { hooks } from '@adonisjs/core/app';

/**
 * Where the generated webhook-handlers barrel is written, relative to the app root. The
 * payments provider imports THIS path at boot (build-time codegen) instead of scanning
 * `app/payment_handlers` with `readdir` at runtime. Kept in sync with the provider.
 */
export const GENERATED_WEBHOOK_HANDLERS_OUTPUT = '.adonisjs/payments/webhook_handlers.ts';

/**
 * Options for {@link webhookHandlersHook} — mirror the relevant `IndexGenerator.add`
 * knobs so an app can point the generator at a non-default handlers directory or import
 * alias.
 */
export interface WebhookHandlersHookOptions {
  /** Directory the generator scans for handler modules, relative to the app root. Default `app/payment_handlers`. */
  source?: string;
  /** Import alias the generated barrel uses for each handler module. Default `#payment_handlers`. */
  importAlias?: string;
  /** Output path for the generated barrel, relative to the app root. Default `.adonisjs/payments/webhook_handlers.ts`. */
  output?: string;
}

/**
 * An AdonisJS **Assembler `init` hook** that generates a typed barrel of the app's
 * `app/payment_handlers/` directory at build/dev time — exactly how the durable package
 * generates `app/workflows` and `@adonisjs/core` generates the controllers/events
 * barrels (`indexEntities`). The build-time barrel replaces the provider's runtime
 * `readdir` scan; the file watcher re-runs the generator whenever a handler file
 * changes.
 *
 * The generated file is a lazy barrel — `export const webhookHandlers = { Name: () =>
 * import('#payment_handlers/…') }` — which the payments provider imports at boot and
 * registers alongside `config.billing.handlers`.
 *
 * Register it in `adonisrc.ts`:
 *
 * ```ts
 * export default defineConfig({
 *   hooks: {
 *     init: [() => import('@adonis-agora/payments/hooks/webhook_handlers')],
 *   },
 * })
 * ```
 */
export function webhookHandlersHook(
  options: WebhookHandlersHookOptions = {},
): (parent: unknown, hooksManager: unknown, indexGenerator: IndexGenerator) => void {
  const source = options.source ?? 'app/payment_handlers';
  const importAlias = options.importAlias ?? '#payment_handlers';
  const output = options.output ?? GENERATED_WEBHOOK_HANDLERS_OUTPUT;

  return hooks.init(
    (
      _parent: unknown,
      _hooksManager: unknown,
      indexGenerator: {
        add(name: string, config: Record<string, unknown>): unknown;
      },
    ) => {
      indexGenerator.add('webhookHandlers', {
        source,
        as: 'barrelFile',
        exportName: 'webhookHandlers',
        importAlias,
        // `app/payment_handlers/payment_succeeded.ts` → barrel key `Payment/Succeeded`;
        // the event type itself comes from each module's `type`/`eventType`.
        skipSegments: ['payment_handlers'],
        output,
        comment: true,
      });
    },
  ) as (parent: unknown, hooksManager: unknown, indexGenerator: IndexGenerator) => void;
}

/** The default export is the hook itself, so `() => import('@adonis-agora/payments/hooks/webhook_handlers')`
 *  in `adonisrc.ts` resolves to a ready hook (the assembler calls it). Annotated
 *  explicitly so the declaration emit stays portable (same as collaboration's
 *  `codegen_init`). */
export default webhookHandlersHook() as (
  parent: unknown,
  hooksManager: unknown,
  indexGenerator: IndexGenerator,
) => void;
