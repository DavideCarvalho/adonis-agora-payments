import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { BaseModel } from '@adonisjs/lucid/orm';
import type { BaseSchema } from '@adonisjs/lucid/schema';

/**
 * Every published migration, in the order `configure.ts` publishes them.
 *
 * Both, not just the first: `add_billing_external_reference` is what existing installs get,
 * and running only the create stub here would leave the suite testing a schema no upgraded
 * app has. It is also the only place the second migration's `hasColumn` guards are ever
 * executed — on a fresh database the create stub already declares those columns, so this run
 * proves the guarded migration is a no-op instead of a failure.
 */
const STUBS = ['create_billing_tables', 'add_billing_external_reference'].map((name) => ({
  name,
  path: fileURLToPath(new URL(`../../stubs/database/migrations/${name}.stub`, import.meta.url)),
}));
const GENERATED_DIR = fileURLToPath(new URL('./__generated__/', import.meta.url));

/**
 * Materialize the PUBLISHED migration stub as an importable module.
 *
 * The point of the whole integration suite is that it runs against the schema real apps
 * get — the one `node ace configure` copies. Re-declaring the tables in the test would
 * make the suite green while the stub drifted, which is the exact failure this is here to
 * catch. So the stub is the source: strip its `{{{ exports(...) }}}` codegen header (the
 * only non-TypeScript in the file) and import what is left.
 */
async function loadMigration(schemaName: string, stub: string): Promise<typeof BaseSchema> {
  const raw = await readFile(stub, 'utf-8');
  const header = raw.indexOf('}}}');
  if (!raw.startsWith('{{{') || header === -1) {
    throw new Error(`Expected a stub header in ${stub}. Did the stub format change?`);
  }
  // The directory is gitignored, so a fresh checkout (CI) does not have it.
  await mkdir(GENERATED_DIR, { recursive: true });
  // Named per schema AND per stub: vitest's forks pool runs spec files in parallel processes,
  // and a single shared filename means one process can be importing the file while another
  // rewrites it.
  const generated = `${GENERATED_DIR}${schemaName}__${basename(stub, '.stub')}.ts`;
  await writeFile(generated, raw.slice(header + 3).trimStart(), 'utf-8');
  const mod = (await import(generated)) as { default: typeof BaseSchema };
  return mod.default;
}

export interface IntegrationDatabase {
  db: Database;
  teardown(): Promise<void>;
}

/**
 * A Lucid `Database` bound to the throwaway Postgres from `global_setup`, with the billing
 * tables created by the real migration.
 *
 * Each caller gets its own Postgres SCHEMA (`searchPath`), so spec files running in
 * parallel forks cannot see each other's rows — counting "every failed event in the last
 * hour" is only meaningful when the table holds nothing but this test's rows.
 */
export async function createIntegrationDatabase(schemaName: string): Promise<IntegrationDatabase> {
  const url = process.env.PAYMENTS_TEST_PG_URL;
  if (!url) {
    throw new Error(
      'PAYMENTS_TEST_PG_URL is unset — run the integration suite through vitest.integration.config.ts so the container starts.',
    );
  }

  const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
  await app.init();
  const emitter = new Emitter(app);
  const logger = new LoggerFactory().create();

  const db = new Database(
    {
      connection: 'primary',
      connections: {
        primary: {
          client: 'pg',
          connection: url,
          searchPath: [schemaName],
          pool: { min: 0, max: 4 },
        },
      },
    },
    logger,
    emitter,
  );
  BaseModel.useAdapter(db.modelAdapter());

  await db.rawQuery(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

  for (const stub of STUBS) {
    const Migration = await loadMigration(schemaName, stub.path);
    const migration = new Migration(db.connection(), stub.path, false);
    await migration.execUp();
  }

  return {
    db,
    async teardown() {
      await db.rawQuery(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await db.manager.closeAll();
    },
  };
}
