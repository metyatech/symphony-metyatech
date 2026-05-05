import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import { Liquid } from "liquidjs";
import { SymphonyError } from "./errors.js";
import type {
  Issue,
  RepoCheckout,
  RepositoriesConfig,
  ServiceConfig,
  WorkflowDefinition
} from "./types.js";

const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];
const DEFAULT_LABEL_PREFIX = "repo:";
const DEFAULT_REPO_BASE_URL = "https://github.com";

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
  const server = getRecord(raw.server);
  const workspace = getRecord(raw.workspace);
  const hooks = getRecord(raw.hooks);
  const agent = getRecord(raw.agent);
  const codex = getRecord(raw.codex);
  const repositories = getRecord(raw.repositories);

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
      team: getString(tracker.team, null),
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
    repositories: resolveRepositoriesConfig(repositories),
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
      max_retries: getInteger(agent.max_retries, 5),
      max_retry_backoff_ms: getInteger(agent.max_retry_backoff_ms, 300000),
      max_concurrent_agents_by_state: byState
    },
    server: {
      port: getInteger(server.port, 3000) || null
    },
    codex: {
      command: getString(codex.command, "codex app-server") ?? "codex app-server",
      approval_policy: codex.approval_policy,
      thread_sandbox: codex.thread_sandbox,
      turn_sandbox_policy: codex.turn_sandbox_policy,
      turn_timeout_ms: getInteger(codex.turn_timeout_ms, 21600000),
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
  if (!config.tracker.team)
    throw new SymphonyError(
      "config_validation_error",
      "tracker.team is required for Linear dispatch"
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
  if (config.repositories.required && !config.repositories.owner)
    throw new SymphonyError(
      "config_validation_error",
      "repositories.required is true but repositories.owner is not set"
    );
}

export async function renderPrompt(
  template: string,
  issue: Issue,
  attempt: number | null,
  repos: RepoCheckout[] = []
): Promise<string> {
  const source = template.trim() === "" ? "You are working on an issue from Linear." : template;
  try {
    const engine = new Liquid({ strictVariables: true, strictFilters: true });
    const rendered: unknown = await engine.parseAndRender(source, { issue, attempt, repos });
    return typeof rendered === "string" ? rendered : String(rendered);
  } catch (error) {
    throw new SymphonyError(
      "template_render_error",
      "Workflow prompt template could not be rendered",
      error
    );
  }
}

/**
 * Default repositories configuration. With no `repositories:` block in
 * `WORKFLOW.md` the service operates in single-repo (legacy) mode: no labels
 * are interpreted as repos, no auto-cloning happens, and `repos` is empty in
 * the prompt context. Once a workflow declares `repositories.owner` (or any
 * `default` repos) Symphony begins clone/reuse on every workspace.
 */
function resolveRepositoriesConfig(raw: Record<string, unknown>): RepositoriesConfig {
  const protocolRaw = getString(raw.protocol, "https");
  const protocol = protocolRaw === "ssh" ? "ssh" : "https";
  const baseUrl = getString(raw.base_url, DEFAULT_REPO_BASE_URL) ?? DEFAULT_REPO_BASE_URL;
  return {
    owner: getString(raw.owner, null),
    base_url: baseUrl.replace(/\/+$/, ""),
    protocol,
    label_prefix: getString(raw.label_prefix, DEFAULT_LABEL_PREFIX) ?? DEFAULT_LABEL_PREFIX,
    default: getStringArray(raw.default, []),
    required: typeof raw.required === "boolean" ? raw.required : false
  };
}

const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/;

/**
 * Resolve which repositories an issue's workspace should contain. Repository
 * names come from labels matching `repositories.label_prefix` and from
 * `repositories.default`. Names containing `/` are treated as `owner/repo`,
 * otherwise the configured `owner` is used. Returns an empty list when
 * multi-repo support is not configured.
 */
export function selectRepositoriesForIssue(
  config: ServiceConfig,
  issue: Issue
): { name: string; owner: string | null; url: string }[] {
  const reposCfg = config.repositories;
  const seen = new Set<string>();
  const selected: { name: string; owner: string | null; url: string }[] = [];
  const candidates: string[] = [];
  for (const label of issue.labels) {
    if (label.startsWith(reposCfg.label_prefix)) {
      candidates.push(label.slice(reposCfg.label_prefix.length).trim());
    }
  }
  candidates.push(...reposCfg.default);
  for (const candidate of candidates) {
    if (!candidate || !REPO_NAME_PATTERN.test(candidate)) continue;
    const [maybeOwner, maybeRepo] = candidate.includes("/")
      ? candidate.split("/", 2)
      : [reposCfg.owner, candidate];
    const owner = maybeOwner ?? reposCfg.owner;
    const name = maybeRepo;
    if (!name) continue;
    const dedupeKey = `${owner ?? ""}/${name}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (!owner) continue;
    selected.push({ name, owner, url: buildRepoUrl(reposCfg, owner, name) });
  }
  return selected;
}

function buildRepoUrl(cfg: RepositoriesConfig, owner: string, name: string): string {
  if (cfg.protocol === "ssh") {
    const host = cfg.base_url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return `git@${host}:${owner}/${name}.git`;
  }
  return `${cfg.base_url}/${owner}/${name}.git`;
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
