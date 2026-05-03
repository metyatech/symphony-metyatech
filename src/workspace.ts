import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { SymphonyError, messageFromUnknown } from "./errors.js";
import { sanitizedProcessEnv } from "./process-safety.js";
import { selectRepositoriesForIssue } from "./workflow.js";
import type { Issue, Logger, RepoCheckout, ServiceConfig, Workspace } from "./types.js";

export type HookName = "after_create" | "before_run" | "after_run" | "before_remove";

export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function ensureInsideRoot(workspaceRoot: string, workspacePath: string): void {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(workspacePath);
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new SymphonyError("workspace_safety_error", `Workspace path escapes root: ${target}`);
}

export async function ensureRealDirectoryInsideRoot(
  workspaceRoot: string,
  workspacePath: string
): Promise<void> {
  ensureInsideRoot(workspaceRoot, workspacePath);
  const rootReal = await realpath(workspaceRoot);
  const stat = await lstat(workspacePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SymphonyError(
      "workspace_safety_error",
      `Workspace path is not a real directory: ${workspacePath}`
    );
  }
  const targetReal = await realpath(workspacePath);
  ensureInsideRoot(rootReal, targetReal);
}

/**
 * Build the environment exposed to a workspace hook script. Issue and
 * workspace metadata are exported under the `SYMPHONY_*` namespace so that
 * hooks can decide which repository to clone, which branch to check out, and
 * how to wire the workspace without parsing the workspace directory name.
 *
 * Secret-named variables from the parent process (api keys, tokens, etc.)
 * are stripped via {@link sanitizedProcessEnv} before being merged.
 */
export function buildHookEnv(
  hookName: HookName,
  config: ServiceConfig,
  issue: Issue,
  workspace: Workspace
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...sanitizedProcessEnv(),
    SYMPHONY_HOOK_NAME: hookName,
    SYMPHONY_WORKFLOW_DIR: config.workflowDir,
    SYMPHONY_WORKSPACE_ROOT: config.workspace.root,
    SYMPHONY_WORKSPACE_PATH: workspace.path,
    SYMPHONY_WORKSPACE_KEY: workspace.workspace_key,
    SYMPHONY_WORKSPACE_CREATED_NOW: workspace.created_now ? "true" : "false",
    SYMPHONY_ISSUE_ID: issue.id,
    SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
    SYMPHONY_ISSUE_TITLE: issue.title,
    SYMPHONY_ISSUE_STATE: issue.state,
    SYMPHONY_ISSUE_PRIORITY: issue.priority === null ? "" : String(issue.priority),
    SYMPHONY_ISSUE_BRANCH_NAME: issue.branch_name ?? "",
    SYMPHONY_ISSUE_URL: issue.url ?? "",
    SYMPHONY_ISSUE_LABELS: issue.labels.join(","),
    SYMPHONY_ISSUE_DESCRIPTION: issue.description ?? "",
    SYMPHONY_REPOS: workspace.repositories.map((repo) => repo.name).join(",")
  };
  for (const repo of workspace.repositories) {
    const slot = repoEnvSlot(repo.name);
    env[`SYMPHONY_REPO_${slot}_NAME`] = repo.name;
    env[`SYMPHONY_REPO_${slot}_PATH`] = repo.path;
    env[`SYMPHONY_REPO_${slot}_URL`] = repo.url;
    env[`SYMPHONY_REPO_${slot}_CREATED_NOW`] = repo.created_now ? "true" : "false";
  }
  return env;
}

function repoEnvSlot(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

export class WorkspaceManager {
  constructor(
    private readonly getConfig: () => ServiceConfig,
    private readonly logger: Logger
  ) {}

  workspaceFor(identifier: string): { path: string; workspace_key: string } {
    const config = this.getConfig();
    const workspace_key = sanitizeWorkspaceKey(identifier);
    const workspacePath = path.resolve(config.workspace.root, workspace_key);
    return { path: workspacePath, workspace_key };
  }

  async ensureWorkspace(issue: Issue): Promise<Workspace> {
    const config = this.getConfig();
    const { path: workspacePath, workspace_key } = this.workspaceFor(issue.identifier);
    ensureInsideRoot(config.workspace.root, workspacePath);
    await mkdir(config.workspace.root, { recursive: true });
    let created = false;
    try {
      await mkdir(workspacePath, { recursive: false });
      created = true;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
    await ensureRealDirectoryInsideRoot(config.workspace.root, workspacePath);
    const repositories = await this.ensureRepoCheckouts(issue, workspacePath);
    const workspace: Workspace = {
      path: workspacePath,
      workspace_key,
      created_now: created,
      repositories
    };
    if (created && config.hooks.after_create) {
      await this.runHook("after_create", config.hooks.after_create, issue, workspace, true);
    }
    return workspace;
  }

  /**
   * Resolve the repositories selected for `issue`, then for each one ensure
   * `<workspace>/<repo>/` is a real Git checkout pointing at `origin`. New
   * directories are cloned; existing directories are reused unchanged so the
   * agent's in-progress branches and uncommitted edits survive across runs.
   * Throws when `repositories.required` is set but selection is empty.
   */
  private async ensureRepoCheckouts(issue: Issue, workspacePath: string): Promise<RepoCheckout[]> {
    const config = this.getConfig();
    const selections = selectRepositoriesForIssue(config, issue);
    if (selections.length === 0) {
      if (config.repositories.required) {
        throw new SymphonyError(
          "repositories_selection_empty",
          `no repositories matched issue ${issue.identifier}; configure labels prefixed with ${config.repositories.label_prefix} or repositories.default`
        );
      }
      return [];
    }
    const checkouts: RepoCheckout[] = [];
    for (const selection of selections) {
      const repoPath = path.resolve(workspacePath, selection.name);
      ensureInsideRoot(workspacePath, repoPath);
      const exists = await pathExists(repoPath);
      if (!exists) {
        await mkdir(path.dirname(repoPath), { recursive: true });
        await runShell(
          `git clone ${shellEscape(selection.url)} ${shellEscape(repoPath)}`,
          workspacePath,
          config.hooks.timeout_ms
        );
        this.logger.info("repo_cloned", {
          repo: selection.name,
          url: selection.url,
          path: repoPath,
          identifier: issue.identifier
        });
      }
      checkouts.push({
        name: selection.name,
        path: repoPath,
        url: selection.url,
        created_now: !exists
      });
    }
    return checkouts;
  }

  async beforeRun(issue: Issue, workspace: Workspace): Promise<void> {
    const hook = this.getConfig().hooks.before_run;
    if (hook) await this.runHook("before_run", hook, issue, workspace, true);
  }

  async afterRun(issue: Issue, workspace: Workspace): Promise<void> {
    const hook = this.getConfig().hooks.after_run;
    if (hook) await this.runHook("after_run", hook, issue, workspace, false);
  }

  async removeWorkspace(issue: Issue): Promise<void> {
    const config = this.getConfig();
    const { path: workspacePath, workspace_key } = this.workspaceFor(issue.identifier);
    if (!(await pathExists(workspacePath))) return;
    await ensureRealDirectoryInsideRoot(config.workspace.root, workspacePath);
    const workspace: Workspace = {
      path: workspacePath,
      workspace_key,
      created_now: false,
      repositories: []
    };
    if (config.hooks.before_remove) {
      await this.runHook("before_remove", config.hooks.before_remove, issue, workspace, false);
    }
    await rm(workspacePath, { recursive: true, force: true });
    this.logger.info("workspace_removed", {
      workspace_path: workspacePath,
      identifier: issue.identifier
    });
  }

  private async runHook(
    name: HookName,
    script: string,
    issue: Issue,
    workspace: Workspace,
    fatal: boolean
  ): Promise<void> {
    this.logger.info("hook_started", { hook: name, cwd: workspace.path });
    try {
      const config = this.getConfig();
      await ensureRealDirectoryInsideRoot(config.workspace.root, workspace.path);
      const env = buildHookEnv(name, config, issue, workspace);
      await runShell(script, workspace.path, config.hooks.timeout_ms, env);
      this.logger.info("hook_finished", { hook: name, cwd: workspace.path });
    } catch (error) {
      this.logger.warn("hook_failed", {
        hook: name,
        cwd: workspace.path,
        error: messageFromUnknown(error)
      });
      if (fatal) throw new SymphonyError("hook_failed", `${name} hook failed`, error);
    }
  }
}

export function runShell(
  script: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = sanitizedProcessEnv()
): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? "powershell.exe" : "sh";
    const args =
      process.platform === "win32" ? ["-NoProfile", "-Command", script] : ["-lc", script];
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "ignore",
      windowsHide: true
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`hook timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`hook exited with code ${code ?? "null"}`));
    });
  });
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function shellEscape(value: string): string {
  if (process.platform === "win32") {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
