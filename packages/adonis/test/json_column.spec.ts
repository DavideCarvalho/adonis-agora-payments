import type { LucidRow } from '@adonisjs/lucid/types/model';
import { describe, expect, it } from 'vitest';
import { jsonColumn } from '../src/billing/mixins/json_column.js';

/** A row whose model reports `dialect` as its connection's dialect. */
function rowOn(dialect: string): LucidRow {
  class Model {
    static query() {
      return { client: { dialect: { name: dialect } } };
    }
    $options = undefined;
  }
  return new Model() as unknown as LucidRow;
}

describe('jsonColumn', () => {
  const doc = { a: [1, { b: 2 }] };

  it.each(['postgres', 'pg', 'mysql', 'mysql2'])(
    'hands the value through untouched on %s, both ways',
    (dialect) => {
      const row = rowOn(dialect);
      expect(jsonColumn.prepare(doc, 'payload', row)).toBe(doc);
      // A JSONB string scalar is a string on read, and must stay one.
      expect(jsonColumn.consume('"quoted"', 'payload', row)).toBe('"quoted"');
      expect(jsonColumn.consume(doc, 'payload', row)).toBe(doc);
    },
  );

  it.each(['sqlite3', 'better-sqlite3', 'libsql'])('serializes and parses on %s', (dialect) => {
    const row = rowOn(dialect);
    const stored = jsonColumn.prepare(doc, 'payload', row);
    expect(stored).toBe(JSON.stringify(doc));
    expect(jsonColumn.consume(stored, 'payload', row)).toEqual(doc);
    expect(jsonColumn.prepare(null, 'payload', row)).toBeNull();
    expect(jsonColumn.consume(null, 'payload', row)).toBeNull();
    expect(jsonColumn.consume('not json', 'payload', row)).toBe('not json');
  });
});
