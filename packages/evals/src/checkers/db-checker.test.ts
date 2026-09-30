import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { DbChecker } from './db-checker.js';
import { EvalRunner } from './index.js';

function fixtureDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eval-db-'));
  const path = join(dir, 't.db');
  const db = new Database(path);
  db.exec(`
    CREATE TABLE users (id TEXT, email TEXT, name TEXT, plan TEXT, terms_accepted_at TEXT);
    CREATE TABLE sessions (id TEXT, user_id TEXT, token TEXT);
    INSERT INTO users VALUES ('u1', 'ada@example.com', 'Ada Lovelace', 'pro', '2024-03-01');
    INSERT INTO sessions VALUES ('s1', 'u1', 'tok');
  `);
  db.close();
  return path;
}

describe('db checker', () => {
  it('matches rows, wildcard fields, and joined queries', async () => {
    const checker = new DbChecker(fixtureDb());
    const row = checker.check({
      name: 'user',
      type: 'db_row_matches',
      table: 'users',
      where: { email: 'ada@example.com' },
      expected: { name: 'Ada Lovelace', plan: 'pro', terms_accepted_at: '*' },
    });
    expect(row.passed).toBe(true);

    const missing = checker.check({
      name: 'missing',
      type: 'db_row_exists',
      table: 'users',
      where: { email: 'nobody@example.com' },
    });
    expect(missing.passed).toBe(false);

    const session = checker.check({
      name: 'session',
      type: 'db_query',
      query: 'SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?',
      params: ['ada@example.com'],
      expected_min_rows: 1,
    });
    expect(session.passed).toBe(true);
    checker.close();

    const runner = new EvalRunner({ fixturesUrl: 'http://127.0.0.1:9', dbPath: fixtureDb() });
    const results = await runner.evaluate({
      id: 't',
      pack: 'onboarding',
      name: 't',
      goal: 't',
      params: {},
      eval: {
        type: 'composite',
        checks: [{
          name: 'session',
          type: 'db_query',
          query: 'SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?',
          params: ['ada@example.com'],
          expected_min_rows: 1,
        }],
      },
    });
    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.error).toBeUndefined();
  });
});
