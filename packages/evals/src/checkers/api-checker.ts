import type { EvalCheck, EvalCheckResult } from '../types.js';

export function compareExpected(expected: Record<string, unknown>, actual: unknown, path = ''): string[] {
  const mismatches: string[] = [];
  if (actual === null || actual === undefined || typeof actual !== 'object') {
    return [`${path || 'response'}: expected object, got ${JSON.stringify(actual)}`];
  }
  const record = actual as Record<string, unknown>;

  for (const [key, expectedValue] of Object.entries(expected)) {
    const current = path ? `${path}.${key}` : key;
    if (key.endsWith('_lte') || key.endsWith('_gte')) {
      const base = key.slice(0, -4);
      const actualNum = Number(record[base]);
      const limit = Number(expectedValue);
      const ok = key.endsWith('_lte') ? actualNum <= limit : actualNum >= limit;
      if (!ok) {
        mismatches.push(`${current}: expected ${base} ${key.endsWith('_lte') ? '<=' : '>='} ${limit}, got ${record[base]}`);
      }
      continue;
    }

    const actualValue = record[key];
    if (expectedValue === '*') {
      if (actualValue === undefined || actualValue === null || actualValue === '') {
        mismatches.push(`${current}: expected a value`);
      }
      continue;
    }
    if (Array.isArray(expectedValue)) {
      if (!Array.isArray(actualValue)) {
        mismatches.push(`${current}: expected array, got ${JSON.stringify(actualValue)}`);
        continue;
      }
      if (expectedValue.length > 0 && typeof expectedValue[0] === 'object' && expectedValue[0] !== null) {
        if (actualValue.length < expectedValue.length) {
          mismatches.push(`${current}: expected at least ${expectedValue.length} items, got ${actualValue.length}`);
        }
        expectedValue.forEach((item, index) => {
          if (actualValue[index] !== undefined) {
            mismatches.push(...compareExpected(item as Record<string, unknown>, actualValue[index], `${current}[${index}]`));
          }
        });
      } else {
        const actualSet = new Set(actualValue);
        for (const value of expectedValue) {
          if (!actualSet.has(value)) mismatches.push(`${current}: missing ${JSON.stringify(value)}`);
        }
      }
      continue;
    }
    if (expectedValue && typeof expectedValue === 'object') {
      mismatches.push(...compareExpected(expectedValue as Record<string, unknown>, actualValue, current));
      continue;
    }
    if (actualValue !== expectedValue) {
      mismatches.push(`${current}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`);
    }
  }
  return mismatches;
}

export class ApiChecker {
  private baseUrl: string;
  private sessionCookie?: string;

  constructor(baseUrl: string, sessionCookie?: string) {
    this.baseUrl = baseUrl;
    this.sessionCookie = sessionCookie;
  }

  async check(evalCheck: EvalCheck): Promise<EvalCheckResult> {
    try {
      const { endpoint, method = 'GET', expected, headers = {}, body } = evalCheck;
      if (!endpoint) {
        return { name: evalCheck.name, passed: false, error: 'Missing endpoint' };
      }

      const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
      
      const fetchHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...headers,
      };
      
      if (this.sessionCookie) {
        fetchHeaders['Cookie'] = `session_token=${this.sessionCookie}`;
      }

      const response = await fetch(url, {
        method,
        headers: fetchHeaders,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok && expected?.status !== response.status) {
        return {
          name: evalCheck.name,
          passed: false,
          expected,
          actual: { status: response.status },
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const data = await response.json().catch(() => null);

      if (!expected) {
        return { name: evalCheck.name, passed: true, actual: data };
      }

      const mismatches = compareExpected(expected, data);
      
      return {
        name: evalCheck.name,
        passed: mismatches.length === 0,
        expected,
        actual: data,
        error: mismatches.length > 0 ? mismatches.join('; ') : undefined,
      };
    } catch (error) {
      return {
        name: evalCheck.name,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  setSessionCookie(cookie: string): void {
    this.sessionCookie = cookie;
  }
}
