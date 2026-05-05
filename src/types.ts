export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  created_at: string | null;
  updated_at: string | null;
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  prompt_template: string;
}

export interface RepositoriesConfig {
  owner: string | null;
  base_url: string;
  protocol: "https" | "ssh";
  label_prefix: string;
  default: string[];
  required: boolean;
}

export interface RepoCheckout {
  name: string;
  path: string;
  url: string;
  created_now: boolean;
}

export interface ServiceConfig {
  workflowPath: string;
  workflowDir: string;
  tracker: {
    kind: "linear" | null;
    endpoint: string;
    api_key: string | null;
    team: string | null;
    active_states: string[];
    terminal_states: string[];
  };
  polling: { interval_ms: number };
  server: { port: number | null };
  workspace: { root: string };
  repositories: RepositoriesConfig;
  hooks: {
    after_create: string | null;
    before_run: string | null;
    after_run: string | null;
    before_remove: string | null;
    timeout_ms: number;
  };
  agent: {
    max_concurrent_agents: number;
    max_turns: number;
    max_retries: number;
    max_retry_backoff_ms: number;
    max_concurrent_agents_by_state: Map<string, number>;
  };
  codex: {
    command: string;
    approval_policy: unknown;
    thread_sandbox: unknown;
    turn_sandbox_policy: unknown;
    turn_timeout_ms: number;
    read_timeout_ms: number;
    stall_timeout_ms: number;
  };
}

export interface Workspace {
  path: string;
  workspace_key: string;
  created_now: boolean;
  repositories: RepoCheckout[];
}

export interface LiveSession {
  session_id: string;
  thread_id: string;
  turn_id: string;
  codex_app_server_pid: string | null;
  last_codex_event: string | null;
  last_codex_timestamp: string | null;
  last_codex_message: string | null;
  codex_input_tokens: number;
  codex_output_tokens: number;
  codex_total_tokens: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  turn_count: number;
}

export interface RunningEntry {
  issue: Issue;
  started_at_ms: number;
  worker: { cancel(reason: string): Promise<void> };
  live_session: LiveSession | null;
  workspace_path: string;
}

export interface RetryEntry {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  timer_handle: NodeJS.Timeout | null;
  error: string | null;
}

export interface OrchestratorState {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retry_attempts: Map<string, RetryEntry>;
  completed: Set<string>;
  codex_totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    runtime_ms: number;
  };
  codex_rate_limits: unknown;
}

export type RunnerStatus = "succeeded" | "failed" | "timed_out" | "stalled" | "canceled";

export interface RunResult {
  status: RunnerStatus;
  error: string | null;
  runtime_ms: number;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}
