import Database from 'better-sqlite3';
import type { EvalCheck, EvalCheckResult } from '../types.js';

export class DbChecker {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: true });
  }

  check(evalCheck: EvalCheck): EvalCheckResult {
    try {
      if (evalCheck.type === 'db_row_exists') {
        return this.checkRowExists(evalCheck);
      } else if (evalCheck.type === 'db_row_matches') {
        return this.checkRowMatches(evalCheck);
      } else if (evalCheck.type === 'db_query') {
        return this.checkQuery(evalCheck);
      }
      return { name: evalCheck.name, passed: false, error: `Unknown check type: ${evalCheck.type}` };
    } catch (error) {
      return {
        name: evalCheck.name,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private checkRowExists(evalCheck: EvalCheck): EvalCheckResult {
    const { table, where } = evalCheck;
    if (!table || !where) {
      return { name: evalCheck.name, passed: false, error: 'Missing table or where clause' };
    }

    const conditions = Object.keys(where).map(k => `${k} = ?`).join(' AND ');
    const values = Object.values(where);
    const query = `SELECT COUNT(*) as count FROM ${table} WHERE ${conditions}`;
    
    const result = this.db.prepare(query).get(...values) as { count: number };
    const exists = result.count > 0;

    return {
      name: evalCheck.name,
      passed: exists,
      expected: { exists: true },
      actual: { exists, count: result.count },
      error: exists ? undefined : `No row found matching: ${JSON.stringify(where)}`,
    };
  }

  private checkRowMatches(evalCheck: EvalCheck): EvalCheckResult {
    const { table, where, expected } = evalCheck;
    if (!table || !where || !expected) {
      return { name: evalCheck.name, passed: false, error: 'Missing table, where, or expected' };
    }

    const conditions = Object.keys(where).map(k => `${k} = ?`).join(' AND ');
    const values = Object.values(where);
    const query = `SELECT * FROM ${table} WHERE ${conditions} LIMIT 1`;
    
    const row = this.db.prepare(query).get(...values) as Record<string, unknown> | undefined;
    if (!row) {
      return {
        name: evalCheck.name,
        passed: false,
        expected,
        actual: null,
        error: `No row found matching: ${JSON.stringify(where)}`,
      };
    }

    const mismatches: string[] = [];
    for (const [key, expectedValue] of Object.entries(expected)) {
      const actualValue = row[key];
      
      let actualParsed = actualValue;
      if (typeof actualValue === 'string' && (actualValue.startsWith('[') || actualValue.startsWith('{'))) {
        try { actualParsed = JSON.parse(actualValue); } catch { /* keep string */ }
      }

      if (expectedValue === '*') {
        if (actualParsed === null || actualParsed === undefined || actualParsed === '') {
          mismatches.push(`${key}: expected a non-empty value`);
        }
      } else if (Array.isArray(expectedValue)) {
        const actualArray = Array.isArray(actualParsed) ? actualParsed : [];
        const actualSet = new Set(actualArray);
        if (expectedValue.length !== actualArray.length ||
            !expectedValue.every(v => actualSet.has(v))) {
          mismatches.push(`${key}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualArray)}`);
        }
      } else if (actualParsed !== expectedValue) {
        mismatches.push(`${key}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualParsed)}`);
      }
    }

    return {
      name: evalCheck.name,
      passed: mismatches.length === 0,
      expected,
      actual: row,
      error: mismatches.length > 0 ? mismatches.join('; ') : undefined,
    };
  }

  private checkQuery(evalCheck: EvalCheck): EvalCheckResult {
    if (!evalCheck.query) {
      return { name: evalCheck.name, passed: false, error: 'Missing query' };
    }
    const rows = this.db.prepare(evalCheck.query).all(...(evalCheck.params ?? [])) as unknown[];
    const min = evalCheck.expected_min_rows ?? 1;
    const passed = rows.length >= min;
    return {
      name: evalCheck.name,
      passed,
      expected: { min_rows: min },
      actual: { rows: rows.length, sample: rows[0] ?? null },
      error: passed ? undefined : `expected at least ${min} row(s), got ${rows.length}`,
    };
  }

  close(): void {
    this.db.close();
  }
}
