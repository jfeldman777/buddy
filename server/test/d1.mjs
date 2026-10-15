// Minimal D1 stand-in on Node's built-in SQLite, enough to run the Worker in node --test.
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));
const normalize = (value) => (value === undefined ? null : typeof value === 'boolean' ? Number(value) : value);
const returnsRows = (sql) => /^\s*select\b/i.test(sql) || /\breturning\b/i.test(sql);

export async function createD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(await readFile(join(MIGRATIONS, file), 'utf8'));
  }

  class Statement {
    constructor(sql, params = []) {
      this.sql = sql;
      this.params = params;
    }
    bind(...params) {
      return new Statement(this.sql, params.map(normalize));
    }
    execute() {
      const statement = db.prepare(this.sql);
      if (returnsRows(this.sql)) return { results: statement.all(...this.params).map((row) => ({ ...row })), success: true, meta: {} };
      const info = statement.run(...this.params);
      return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    }
    async first(column) {
      const row = this.execute().results[0];
      if (!row) return null;
      return column ? row[column] : row;
    }
    async all() {
      return this.execute();
    }
    async run() {
      return this.execute();
    }
  }

  return {
    sqlite: db,
    prepare: (sql) => new Statement(sql),
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
