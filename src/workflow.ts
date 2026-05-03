import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import { Liquid } from "liquidjs";
import { SymphonyError } from "./errors.js";
import type { Issue, ServiceConfig, WorkflowDefinition } from "./types.js";

const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];

export async function loadWorkflow(
  workflowPath?: string
): Promise<WorkflowDefinition & { path: string }> {
  const selectedPath = path.resolve(workflowPath ?? path.join(process.cwd(), "WORKFLOW.md"));
  let raw: string;
  try {
    raw = await readFile(selectedPath, "utf8");
  } catch (error) {
    throw new SymphonyError(
      "missing_workflow_file",
      `Cannot read workflow file: ${selectedPath}`,
      error
    );
  }

  if (!raw.startsWith("---")) {
    return { path: selectedPath, config: {}, prompt_template: raw.trim() };
  }

  const lines = raw.split(/\r?\n/);
  let closeIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      closeIndex = index;
      break;
    }
  }
  if (closeIndex === -1) {
    throw new SymphonyError(
      "workflow_parse_error",
      "YAML front matter is missing a closing delimiter"
    );
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(lines.slice(1, closeIndex).join("\n")) ?? {};
  } catch (error) {
    throw new SymphonyError("workflow_parse_error", "YAML front matter could not be parsed", error);
  }
  if (!isRecord(parsed)) {
    throw new SymphonyError(
      "workflow_front_matter_not_a_map",
      "YAML front matter must decode to a map/object"
    );
  }

  return {
    path: selectedPath,
    config: parsed,
    prompt_template: lines
      .slice(closeIndex + 1)
      .join("\n")
      .trim()
  };
}

export async function loadServiceConfig(
  workflowPath?: string
): Promise<{ workflow: WorkflowDefinition; config: ServiceConfig }> {
  const loaded = await loadWorkflow(workflowPath);
  return { workflow: loaded, config: resolveServiceConfig(loaded.config, loaded.path) };
}

export function resolveServiceConfig(
  raw: Record<string, unknown>,
  workflowPath: string
): ServiceConfig {
  const workflowDir = path.dirname(path.resolve(workflowPath));
  const tracker = getRecord(raw.tracker);
  const polling = getRecord(raw.polling);
  const workspace = getRecord(raw.workspace);
  const hooks = getRecord(raw.hooks);
  const agent = getRecord(raw.agent);
  const codex = getRecord(raw.codex);

  const kind = getString(tracker.kind, null);
  const resolvedKind = kind === null ? null : kind.toLowerCase();
  if (resolvedKind !== null && resolvedKind !== "linear") {
    throw new SymphonyError("config_validation_error", `Unsupported tracker.kind: ${kind}`);
  }

  const apiKeyRaw = getString(tracker.api_key, null);
  const apiKey = resolveEnvReference(apiKeyRaw ?? "$LINEAR_API_KEY");
  const byState = new Map<string, number>();
  for (const [state, value] of Object.entries(getRecord(agent.max_concurrent_agents_by_state))) {
    const parsed = toPositiveInteger(value);
    if (parsed !== null) byState.set(normalizeState(state), parsed);
  }

  return {
    workflowPath: path.resolve(workflowPath),
    workflowDir,
    tracker: {
      kind: resolvedKind,
      endpoint:
        getString(tracker.endpoint, "https://api.linear.app/graphql") ??
        "https://api.linear.app/graphql",
      api_key: apiKey === "" ? null : apiKey,
      project_slug: getString(tracker.project_slug, null),
      active_states: getStringArray(tracker.active_states, DEFAULT_ACTIVE_STATES),
      terminal_states: getStringArray(tracker.terminal_states, DEFAULT_TERMINAL_STATES)
    },
    polling: { interval_ms: getInteger(polling.interval_ms, 30000) },
    workspace: {
      root: resolvePathValue(
        getString(workspace.root, path.join(os.tmpdir(), "symphony_workspaces"))!,
        workflowDir
      )
    },
    hooks: {
      after_create: getString(hooks.after_create, null),
      before_run: getString(hooks.before_run, null),
      after_run: getString(hooks.after_run, null),
      before_remove: getString(hooks.before_remove, null),
      timeout_ms: getInteger(hooks.timeout_ms, 60000)
    },
    agent: {
      max_concurrent_agents: getInteger(agent.max_concurrent_agents, 10),
      max_turns: getInteger(agent.max_turns, 20),
      max_retry_backoff_ms: getInteger(agent.max_retry_backoff_ms, 300000),
      max_concurrent_agents_by_state: byState
    },
    codex: {
      command: getString(codex.command, "codex app-server") ?? "codex app-server",
      approval_policy: codex.approval_policy,
      thread_sandbox: codex.thread_sandbox,
      turn_sandbox_policy: codex.turn_sandbox_policy,
      turn_timeout_ms: getInteger(codex.turn_timeout_ms, 3600000),
      read_timeout_ms: getInteger(codex.read_timeout_ms, 5000),
      stall_timeout_ms: getInteger(codex.stall_timeout_ms, 300000)
    }
  };
}

export function validateDispatchConfig(config: ServiceConfig): void {
  if (config.tracker.kind !== "linear")
    throw new SymphonyError("config_validation_error", "tracker.kind must be linear");
  if (!config.tracker.api_key)
    throw new SymphonyError("config_validation_error", "tracker.api_key is required for dispatch");
  if (!config.tracker.project_slug)
    throw new SymphonyError(
      "config_validation_error",
      "tracker.project_slug is required for Linear dispatch"
    );
  if (!config.codex.command.trim())
    throw new SymphonyError("config_validation_error", "codex.command must be present");
  if (config.polling.interval_ms <= 0)
    throw new SymphonyError("config_validation_error", "polling.interval_ms must be positive");
  if (config.hooks.timeout_ms <= 0)
    throw new SymphonyError("config_validation_error", "hooks.timeout_ms must be positive");
  if (config.agent.max_concurrent_agents <= 0)
    throw new SymphonyError(
      "config_validation_error",
      "agent.max_concurrent_agents must be positive"
    );
  if (config.agent.max_turns <= 0)
    throw new SymphonyError("config_validation_error", "agent.max_turns must be positive");
  if (config.agent.max_retry_backoff_ms <= 0)
    throw new SymphonyError(
      "config_validation_error",
      "agent.max_retry_backoff_ms must be positive"
    );
  if (config.codex.turn_timeout_ms <= 0)
    throw new SymphonyError("config_validation_error", "codex.turn_timeout_ms must be positive");
  if (config.codex.read_timeout_ms <= 0)
    throw new SymphonyError("config_validation_error", "codex.read_timeout_ms must be positive");
}

export async function renderPrompt(
  template: string,
  issue: Issue,
  attempt: number | null
): Promise<string> {
  const source = template.trim() === "" ? "You are working on an issue from Linear." : template;
  try {
    const engine = new Liquid({ strictVariables: true, strictFilters: true });
    const rendered: unknown = await engine.parseAndRender(source, { issue, attempt });
    return typeof rendered === "string" ? rendered : String(rendered);
  } catch (error) {
    throw new SymphonyError(
      "template_render_error",
      "Workflow prompt template could not be rendered",
      error
    );
  }
}

export function normalizeState(value: string): string {
  return value.toLowerCase();
}

function resolveEnvReference(value: string): string {
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    return process.env[value.slice(1)] ?? "";
  }
  return value;
}

function resolvePathValue(value: string, workflowDir: string): string {
  const envResolved = resolveEnvReference(value);
  const homeResolved =
    envResolved === "~" || envResolved.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), envResolved.slice(2))
      : envResolved;
  return path.resolve(
    path.isAbsolute(homeResolved) ? homeResolved : path.join(workflowDir, homeResolved)
  );
}

function getRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function getString(value: unknown, fallback: string | null): string | null {
  return typeof value === "string" ? value : fallback;
}

function getInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function toPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function getStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
