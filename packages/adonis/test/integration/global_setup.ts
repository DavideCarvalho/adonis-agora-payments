import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * One Postgres container for the whole integration run.
 *
 * Vitest's `forks` pool gives every spec file its own process, so a `beforeAll` container
 * would be started once PER FILE — minutes of container churn for seconds of assertions.
 * Starting it here and handing the URL down through the environment keeps it to one.
 */
let container: StartedPostgreSqlContainer | undefined;

export async function setup(): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.PAYMENTS_TEST_PG_URL = container.getConnectionUri();
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
