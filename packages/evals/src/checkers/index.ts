import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { EvalCheck, EvalCheckResult, JobCard } from '../types.js';
import { DbChecker } from './db-checker.js';
import { ApiChecker } from './api-checker.js';
import { gradeWorkbook, readOds, type OdsExpect } from './ods.js';

export interface EvalRunnerConfig {
  fixturesUrl: string;
  dbPath: string;
  artifactsDir?: string;
  sessionCookie?: string;
}

export class EvalRunner {
  private config: EvalRunnerConfig;

  constructor(config: EvalRunnerConfig) {
    this.config = config;
  }

  async evaluate(job: JobCard): Promise<EvalCheckResult[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const dbChecker = new DbChecker(this.config.dbPath);
      const apiChecker = new ApiChecker(this.config.fixturesUrl, this.config.sessionCookie);
      try {
        const results: EvalCheckResult[] = [];
        for (const check of job.eval.checks) {
          results.push(await this.runCheck(check, dbChecker, apiChecker));
        }
        return results;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      } finally {
        dbChecker.close();
      }
    }
    throw lastError;
  }

  private async runCheck(
    check: EvalCheck,
    dbChecker: DbChecker,
    apiChecker: ApiChecker
  ): Promise<EvalCheckResult> {
    switch (check.type) {
      case 'db_row_exists':
      case 'db_row_matches':
      case 'db_query':
        return dbChecker.check(check);

      case 'api_response':
        return apiChecker.check(check);

      case 'file_exists':
        return this.checkFileExists(check);

      case 'cookie_exists':
        return this.checkCookieExists(check);

      case 'url_matches':
        return this.checkUrlMatches(check);

      case 'ods_workbook':
        return this.checkOds(check);

      default:
        return {
          name: check.name,
          passed: false,
          error: `Unknown check type: ${check.type}`,
        };
    }
  }

  private checkFileExists(check: EvalCheck): EvalCheckResult {
    const { path: filePath } = check;
    if (!filePath) {
      return { name: check.name, passed: false, error: 'Missing file path' };
    }

    const fullPath = filePath.startsWith('/') 
      ? filePath 
      : join(this.config.artifactsDir || '/tmp', filePath);

    const exists = existsSync(fullPath);
    return {
      name: check.name,
      passed: exists,
      expected: { exists: true },
      actual: { exists, path: fullPath },
      error: exists ? undefined : `File not found: ${fullPath}`,
    };
  }

  private checkCookieExists(check: EvalCheck): EvalCheckResult {
    const { cookie_name } = check;
    if (!cookie_name) {
      return { name: check.name, passed: false, error: 'Missing cookie_name' };
    }

    const exists = this.config.sessionCookie !== undefined;
    return {
      name: check.name,
      passed: exists,
      expected: { cookie: cookie_name, exists: true },
      actual: { exists },
      error: exists ? undefined : `Cookie not found: ${cookie_name}`,
    };
  }

  private checkUrlMatches(check: EvalCheck): EvalCheckResult {
    return {
      name: check.name,
      passed: true,
      actual: { pattern: check.url_pattern },
    };
  }

  setSessionCookie(cookie: string): void {
    this.config.sessionCookie = cookie;
  }

  private async checkOds(check: EvalCheck): Promise<EvalCheckResult> {
    if (!check.endpoint || !check.task_file) {
      return { name: check.name, passed: false, error: 'ods_workbook needs endpoint and task_file' };
    }
    const url = check.endpoint.startsWith('http') ? check.endpoint : `${this.config.fixturesUrl}${check.endpoint}`;
    const response = await fetch(url);
    if (!response.ok) {
      return { name: check.name, passed: false, error: `artifact HTTP ${response.status}`, actual: { url } };
    }
    const task = JSON.parse(readFileSync(check.task_file, 'utf8')) as { expect: OdsExpect };
    const errors = gradeWorkbook(readOds(Buffer.from(await response.arrayBuffer())), task.expect);
    return {
      name: check.name,
      passed: errors.length === 0,
      expected: task.expect,
      actual: errors,
      error: errors[0],
    };
  }
}

export { DbChecker } from './db-checker.js';
export { ApiChecker, compareExpected } from './api-checker.js';
