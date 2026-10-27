import type { LucidRow } from '@adonisjs/lucid/types/model';

/** Whether the row is read and written through a SQLite connection. */
function onSqlite(row: LucidRow): boolean {
  try {
    const Model = row.constructor as unknown as {
      query(options?: unknown): { client: { dialect: { name: string } } };
    };
    return /sqlite|libsql/i.test(Model.query(row.$options).client.dialect.name);
  } catch {
    return false;
  }
}

/**
 * Column options for a JSON document (`payload`, `metadata`, `normalized`).
 *
 * Postgres (`JSONB`) and MySQL (`JSON`) take the object as-is and hand an object back, so on those
 * dialects both hooks pass the value through untouched. SQLite stores the column as `TEXT`: its
 * driver cannot bind an object, and reads come back as the JSON string. There the object is
 * serialized on the way in and parsed on the way out.
 */
export const jsonColumn = {
  prepare(value: unknown, _attribute: string, row: LucidRow): unknown {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    return onSqlite(row) ? JSON.stringify(value) : value;
  },
  consume(value: unknown, _attribute: string, row: LucidRow): unknown {
    if (typeof value !== 'string' || !onSqlite(row)) return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  },
};
