import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { SymphonyError, messageFromUnknown } from "./errors.js";
import { defaultMwtClient, type MwtClient } from "./mwt-adapter.js";
import { sanitizedProcessEnv } from "./process-safety.js";
import { selectRepositoriesForIssue } from "./workflow.js";
import type { Issue, Logger, RepoCheckout, ServiceConfig, Workspace } from "./types.js";

export type HookName = "after_create" | "before_run" | "after_run" | "before_remove";
type SelectedRepository = ReturnType<typeof selectRepositoriesForIssue>[number];

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
    private readonly logger: Logger,
    private readonly mwt: MwtClient = defaultMwtClient
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
   * Resolve the repositories selected for `issue`, then for each one prefer a
   * configured local checkout when it already exists. Repositories with no
   * local checkout are cloned into `<workspace>/<repo>/`; existing workspace
   * checkouts are reused unchanged so the agent's in-progress branches and
   * uncommitted edits survive across runs.
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
      const localPath = await this.findLocalCheckout(selection.name);
      if (localPath) {
        if (config.repositories.local.isolation === "mwt") {
          checkouts.push(await this.ensureMwtCheckout(selection, issue, workspacePath, localPath));
        } else {
          checkouts.push({
            name: selection.name,
            path: localPath,
            url: selection.url,
            created_now: false
          });
          this.logger.info("repo_local_checkout_selected", {
            repo: selection.name,
            url: selection.url,
            path: localPath,
            identifier: issue.identifier
          });
        }
        continue;
      }
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

  private async ensureMwtCheckout(
    selection: SelectedRepository,
    issue: Issue,
    workspacePath: string,
    seedPath: string
  ): Promise<RepoCheckout> {
    const branch = renderMwtBranchTemplate(
      this.getConfig().repositories.local.branch_template,
      selection,
      issue,
      workspacePath
    );
    const repoPath = renderMwtPathTemplate(
      this.getConfig().repositories.local.path_template,
      selection,
      issue,
      workspacePath
    );

    await this.ensureMwtSeedConfigured(seedPath, selection);

    const reusable = await this.findReusableMwtWorktree(seedPath, repoPath, branch);
    if (reusable) {
      this.logger.info("repo_mwt_worktree_reused", {
        repo: selection.name,
        owner: selection.owner,
        url: selection.url,
        seed_path: seedPath,
        path: reusable,
        branch,
        identifier: issue.identifier
      });
      return { name: selection.name, path: reusable, url: selection.url, created_now: false };
    }

    if (await pathExists(repoPath)) {
      throw new SymphonyError(
        "mwt_worktree_path_occupied",
        `Rendered mwt worktree path is occupied by an unmanaged directory: ${repoPath}`
      );
    }

    const defaultBranch = this.repositoryDefaultBranch(selection);
    const createOptions: {
      base?: string;
      target?: string;
      createdBy: string;
      pathTemplate: string;
      branchTemplate: string;
      allowNonSiblingWorktreePath: boolean;
      reuseExistingBranch: boolean;
      yes: boolean;
    } = {
      createdBy: "symphony",
      pathTemplate: repoPath,
      branchTemplate: branch,
      allowNonSiblingWorktreePath: true,
      reuseExistingBranch: true,
      yes: true
    };
    if (defaultBranch) {
      createOptions.base = defaultBranch;
      createOptions.target = defaultBranch;
    }
    const created = await this.mwt.createTaskWorktree(seedPath, issue.identifier, createOptions);
    const createdPath = path.resolve(created.worktreePath);
    ensureInsideRoot(workspacePath, createdPath);
    if (!sameRealPath(path.resolve(repoPath), createdPath)) {
      throw new SymphonyError(
        "mwt_worktree_path_mismatch",
        `mwt created ${createdPath} instead of requested path ${repoPath}`
      );
    }
    if (created.branch !== branch) {
      throw new SymphonyError(
        "mwt_worktree_branch_mismatch",
        `mwt created branch ${created.branch} instead of requested branch ${branch}`
      );
    }
    this.logger.info("repo_mwt_worktree_created", {
      repo: selection.name,
      owner: selection.owner,
      url: selection.url,
      seed_path: seedPath,
      path: createdPath,
      branch,
      identifier: issue.identifier
    });
    return { name: selection.name, path: createdPath, url: selection.url, created_now: true };
  }

  private async ensureMwtSeedConfigured(
    seedPath: string,
    selection: SelectedRepository
  ): Promise<void> {
    const configPath = path.join(seedPath, ".mwt", "config.toml");
    if (await pathExists(configPath)) {
      await this.mwt.loadConfig(seedPath);
      return;
    }

    const localConfig = this.getConfig().repositories.local;
    if (!localConfig.init_if_missing) {
      throw new SymphonyError(
        "mwt_config_missing",
        `mwt config is missing for ${seedPath}; set repositories.local.init_if_missing to initialize it`
      );
    }

    const defaultBranch = this.repositoryDefaultBranch(selection);
    const initOptions: { base?: string; noVerify?: boolean } = {};
    if (defaultBranch) initOptions.base = defaultBranch;
    if (await this.shouldInitializeWithoutVerify(seedPath)) initOptions.noVerify = true;
    await this.mwt.initializeRepository(seedPath, initOptions);
    this.logger.info("mwt_seed_initialized", {
      repo: selection.name,
      owner: selection.owner,
      seed_path: seedPath,
      default_branch: defaultBranch,
      no_verify: initOptions.noVerify === true
    });
  }

  /**
   * managed-worktree-system 2.3.0 exposes create/list operations rather than an
   * idempotent get-or-create call. Symphony therefore reuses only a managed task
   * worktree whose branch and rendered path both match; the same branch at a
   * different path is rejected instead of being reset or recreated.
   */
  private async findReusableMwtWorktree(
    seedPath: string,
    repoPath: string,
    branch: string
  ): Promise<string | null> {
    const target = await canonicalPath(repoPath);
    let branchPath: string | null = null;
    const worktrees = await this.mwt.listWorktrees(seedPath, { kind: "task" });
    for (const worktree of worktrees) {
      if (worktree.kind !== "task" || worktree.branch !== branch) continue;
      const candidate = await canonicalPath(worktree.path);
      if (sameRealPath(candidate, target)) return candidate;
      branchPath = candidate;
    }
    if (branchPath) {
      throw new SymphonyError(
        "mwt_branch_reuse_conflict",
        `mwt branch ${branch} already exists at ${branchPath}; refusing to recreate it for ${repoPath}`
      );
    }
    return null;
  }

  private repositoryDefaultBranch(selection: SelectedRepository): string | null {
    const overrides = this.getConfig().repositories.local.overrides;
    const keys = selection.owner
      ? [`${selection.owner}/${selection.name}`, selection.name]
      : [selection.name];
    for (const key of keys) {
      const exact = overrides.get(key)?.default_branch ?? null;
      if (exact) return exact;
      const insensitive = [...overrides.entries()].find(
        ([candidate]) => candidate.toLowerCase() === key.toLowerCase()
      );
      if (insensitive?.[1].default_branch) return insensitive[1].default_branch;
    }
    return null;
  }

  private async shouldInitializeWithoutVerify(seedPath: string): Promise<boolean> {
    if (!this.getConfig().repositories.local.init_no_verify) return false;
    let raw: string;
    try {
      raw = await readFile(path.join(seedPath, "package.json"), "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return !(await hasSupportedVerifyWrapper(seedPath));
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return false;
    }
    if (!isRecord(parsed)) return false;
    const scripts = isRecord(parsed.scripts) ? parsed.scripts : {};
    const verify = scripts.verify;
    return typeof verify !== "string" || verify.trim() === "";
  }

  private async findLocalCheckout(name: string): Promise<string | null> {
    const config = this.getConfig();
    if (!config.repositories.local.prefer_existing) return null;
    for (const root of config.repositories.local.roots) {
      const candidate = path.resolve(root, name);
      if (await isGitCheckoutRoot(candidate)) return realpath(candidate);
    }
    return null;
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
    if (config.repositories.local.isolation === "mwt") {
      try {
        const retained = this.plannedMwtWorktreePaths(issue, workspacePath);
        if (retained.length > 0) {
          for (const repo of retained) {
            this.logger.warn("mwt_worktree_retained", {
              repo: repo.name,
              path: repo.path,
              workspace_path: workspacePath,
              identifier: issue.identifier
            });
          }
          this.logger.warn("workspace_cleanup_retained", {
            workspace_path: workspacePath,
            identifier: issue.identifier,
            reason: "repositories.local.isolation=mwt retains managed worktrees"
          });
          return;
        }
      } catch (error) {
        this.logger.warn("workspace_cleanup_retained", {
          workspace_path: workspacePath,
          identifier: issue.identifier,
          error: messageFromUnknown(error),
          reason: "could not safely enumerate mwt worktrees"
        });
        return;
      }
    }
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

  private plannedMwtWorktreePaths(
    issue: Issue,
    workspacePath: string
  ): Array<{ name: string; path: string }> {
    return selectRepositoriesForIssue(this.getConfig(), issue).map((selection) => ({
      name: selection.name,
      path: renderMwtPathTemplate(
        this.getConfig().repositories.local.path_template,
        selection,
        issue,
        workspacePath
      )
    }));
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

function renderMwtBranchTemplate(
  template: string,
  selection: SelectedRepository,
  issue: Issue,
  workspacePath: string
): string {
  const rendered = renderMwtTemplate(template, selection, issue, workspacePath).trim();
  if (!rendered) {
    throw new SymphonyError(
      "mwt_template_error",
      "repositories.local.branch_template rendered empty"
    );
  }
  return rendered;
}

function renderMwtPathTemplate(
  template: string,
  selection: SelectedRepository,
  issue: Issue,
  workspacePath: string
): string {
  const rendered = renderMwtTemplate(template, selection, issue, workspacePath).trim();
  if (!rendered) {
    throw new SymphonyError(
      "mwt_template_error",
      "repositories.local.path_template rendered empty"
    );
  }
  const resolved = path.resolve(
    path.isAbsolute(rendered) ? rendered : path.join(workspacePath, rendered)
  );
  ensureInsideRoot(workspacePath, resolved);
  return resolved;
}

function renderMwtTemplate(
  template: string,
  selection: SelectedRepository,
  issue: Issue,
  workspacePath: string
): string {
  const values = new Map<string, string>([
    ["issue.id", issue.id],
    ["issue.identifier", issue.identifier],
    ["issue.title", issue.title],
    ["owner", selection.owner ?? ""],
    ["repo", selection.name],
    ["workspace", workspacePath]
  ]);
  return template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_match, key: string) => {
    const value = values.get(key);
    if (value === undefined) {
      throw new SymphonyError(
        "mwt_template_error",
        `Unknown repositories.local template key: ${key}`
      );
    }
    return value;
  });
}

async function canonicalPath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return path.resolve(target);
    }
    throw error;
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

async function hasSupportedVerifyWrapper(seedPath: string): Promise<boolean> {
  for (const relativePath of [
    "scripts/verify.mjs",
    "scripts/verify.js",
    "scripts/verify.cjs",
    "scripts/verify.ps1",
    "scripts/verify.cmd",
    "scripts/verify.sh"
  ]) {
    if (await pathExists(path.join(seedPath, relativePath))) return true;
  }
  return false;
}

async function isGitCheckoutRoot(target: string): Promise<boolean> {
  try {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const topLevel = (
      await runGit(["-C", target, "rev-parse", "--show-toplevel"], target, 10000)
    ).trim();
    if (!topLevel) return false;
    return sameRealPath(await realpath(topLevel), await realpath(target));
  } catch {
    return false;
  }
}

function runGit(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const child = spawn("git", args, {
      cwd,
      env: sanitizedProcessEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`git timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`git exited with code ${code ?? "null"}`));
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameRealPath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
