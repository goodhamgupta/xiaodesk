export interface EvalCheck {
  name: string;
  type: 'db_row_exists' | 'db_row_matches' | 'db_query' | 'api_response' | 'file_exists' | 'cookie_exists' | 'url_matches';
  query?: string;
  params?: unknown[];
  table?: string;
  where?: Record<string, unknown>;
  expected?: Record<string, unknown>;
  expected_min_rows?: number;
  endpoint?: string;
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  path?: string;
  cookie_name?: string;
  url_pattern?: string;
}

export interface EvalCheckResult {
  name: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  error?: string;
}

export interface EvalSpec {
  type: 'db_check' | 'api_check' | 'file_check' | 'composite';
  checks: EvalCheck[];
}

export interface JobCard {
  id: string;
  pack: 'onboarding' | 'support' | 'booking';
  name: string;
  goal: string;
  params: Record<string, unknown>;
  eval: EvalSpec;
}
