export interface JobCard {
  id: string;
  pack: 'onboarding' | 'support' | 'booking';
  name: string;
  description: string;
  goal: string;
  setup?: JobSetup;
  params: Record<string, unknown>;
  eval: EvalSpec;
  timeout_ms?: number;
}

export interface JobSetup {
  reset_db?: boolean;
  seed_data?: Record<string, unknown>;
  pre_actions?: PreAction[];
}

export interface PreAction {
  type: 'mark_slot_unavailable' | 'create_ticket' | 'create_user';
  params: Record<string, unknown>;
}

export interface EvalSpec {
  type: 'db_check' | 'api_check' | 'file_check' | 'composite';
  checks: EvalCheck[];
}

export interface EvalCheck {
  name: string;
  type: 'db_row_exists' | 'db_row_matches' | 'db_query' | 'api_response' | 'file_exists' | 'cookie_exists' | 'url_matches';
  query?: string;
  params?: unknown[];
  table?: string;
  where?: Record<string, unknown>;
  expected_min_rows?: number;
  endpoint?: string;
  method?: 'GET' | 'POST';
  expected?: Record<string, unknown>;
  path?: string;
  cookie_name?: string;
}

export type JobStatus = 'pending' | 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'timeout';

export interface JobResult {
  job_id: string;
  status: JobStatus;
  started_at?: Date;
  finished_at?: Date;
  duration_ms?: number;
  eval_results?: EvalCheckResult[];
  error?: string;
  guest_id?: string;
  logs?: string[];
}

export interface EvalCheckResult {
  name: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  error?: string;
}

export interface GuestConfig {
  id: string;
  driver: 'process' | 'docker' | 'microvm';
  memory_mb: number;
  browser_mode: 'lightpanda' | 'chromium';
  cdp_port: number;
  fixtures_url: string;
}

export interface OrchestratorConfig {
  max_concurrent_guests: number;
  memory_per_guest_mb: number;
  total_memory_budget_mb: number;
  reserved_host_memory_mb: number;
  fixtures_url: string;
  driver: 'process' | 'docker' | 'microvm';
  browser_mode: 'lightpanda' | 'chromium';
  default_timeout_ms: number;
}

export interface QueueStats {
  pending: number;
  running: number;
  completed: number;
  passed: number;
  failed: number;
  cancelled: number;
  timeout: number;
}

export interface DashboardState {
  config: OrchestratorConfig;
  stats: QueueStats;
  active_guests: GuestState[];
  recent_results: JobResult[];
  queue_depth: number;
  memory_usage_mb: number;
}

export interface GuestState {
  id: string;
  job_id: string;
  job_name: string;
  status: 'starting' | 'running' | 'stopping';
  started_at: Date;
  memory_mb: number;
}

export interface AppServerMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ThreadStartParams {
  thread_id: string;
  model?: string;
  instructions?: string;
}

export interface TurnStartParams {
  thread_id: string;
  user_message: string;
  tools?: ToolDefinition[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'done';
  timestamp: Date;
  data: unknown;
}
