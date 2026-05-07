import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { MemoryLogger } from "./logger.js";
import type { Issue, ServiceConfig } from "./types.js";
import {
  buildHookEnv,
  ensureInsideRoot,
  sanitizeWorkspaceKey,
  WorkspaceManager
} from "./workspace.js";

describe("workspace management", () => {
  it("sanitizes issue identifiers for workspace keys", () => {
    expect(sanitizeWorkspaceKey("ABC/123 hello:world")).toBe("ABC_123_hello_world");
  });

  it("rejects paths outside the workspace root", () => {
    expect(() => ensureInsideRoot("/tmp/root", "/tmp/root/child")).not.toThrow();
    expect(() => ensureInsideRoot("/tmp/root", "/tmp/other")).toThrow(/escapes/);
  });

  it("runs after_create only when the directory is new", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "symphony-workspaces-"));
    const root = path.join(parent, "missing-root");
    const marker = path.join(root, "ABC-1", "created.txt");
    const markerForScript = marker.replaceAll("\\", "\\\\");
    const config = configFor(
      root,
      `node -e "require('fs').writeFileSync('${markerForScript}', 'created')"`
    );
    const manager = new WorkspaceManager(() => config, new MemoryLogger());

    const first = await manager.ensureWorkspace(makeIssue("ABC-1"));
    const second = await manager.ensureWorkspace(makeIssue("ABC-1"));

    await expect(access(marker)).resolves.toBeUndefined();
    expect(first.created_now).toBe(true);
    expect(second.created_now).toBe(false);
  });

  it("rejects existing symlink or junction workspace directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-workspaces-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "symphony-outside-"));
    await symlink(
      outside,
      path.join(root, "ABC-3"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const manager = new WorkspaceManager(() => configFor(root, null), new MemoryLogger());

    await expect(manager.ensureWorkspace(makeIssue("ABC-3"))).rejects.toThrow(/Workspace path/);
  });

  it("ignores before_remove hook failures and removes the directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-workspaces-"));
    const config = configFor(root, null);
    config.hooks.before_remove = "exit 7";
    const manager = new WorkspaceManager(() => config, new MemoryLogger());
    const workspace = await manager.ensureWorkspace(makeIssue("ABC-2"));
    await writeFile(path.join(workspace.path, "file.txt"), "x", "utf8");

    await manager.removeWorkspace(makeIssue("ABC-2"));

    await expect(access(workspace.path)).rejects.toThrow();
  });

  it("ignores removal for missing terminal workspaces", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-workspaces-"));
    const manager = new WorkspaceManager(() => configFor(root, null), new MemoryLogger());

    await expect(manager.removeWorkspace(makeIssue("MISSING-1"))).resolves.toBeUndefined();
  });

  it("exposes issue and workspace metadata to hooks via SYMPHONY_* environment variables", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "symphony-workspaces-"));
    const root = path.join(parent, "root");
    const marker = path.join(parent, "hook-env.json");
    const markerForScript = marker.replaceAll("\\", "\\\\");
    const script =
      `node -e "require('fs').writeFileSync('${markerForScript}', JSON.stringify({` +
      "hook: process.env.SYMPHONY_HOOK_NAME," +
      "workflow_dir: process.env.SYMPHONY_WORKFLOW_DIR," +
      "workspace_path: process.env.SYMPHONY_WORKSPACE_PATH," +
      "workspace_key: process.env.SYMPHONY_WORKSPACE_KEY," +
      "workspace_created_now: process.env.SYMPHONY_WORKSPACE_CREATED_NOW," +
      "id: process.env.SYMPHONY_ISSUE_ID," +
      "identifier: process.env.SYMPHONY_ISSUE_IDENTIFIER," +
      "title: process.env.SYMPHONY_ISSUE_TITLE," +
      "state: process.env.SYMPHONY_ISSUE_STATE," +
      "priority: process.env.SYMPHONY_ISSUE_PRIORITY," +
      "branch_name: process.env.SYMPHONY_ISSUE_BRANCH_NAME," +
      "url: process.env.SYMPHONY_ISSUE_URL," +
      "labels: process.env.SYMPHONY_ISSUE_LABELS," +
      `description: process.env.SYMPHONY_ISSUE_DESCRIPTION}))"`;
    const config = configFor(root, script);
    const manager = new WorkspaceManager(() => config, new MemoryLogger());

    const issue: Issue = {
      id: "issue-123",
      identifier: "FE-7",
      title: "Replace homepage hero",
      description: "long description",
      priority: 2,
      state: "Todo",
      branch_name: "fe/hero",
      url: "https://linear.app/x/FE-7",
      labels: ["repo:frontend-repo", "area:hero"],
      project_slug: null,
      blocked_by: [],
      created_at: null,
      updated_at: null
    };

    const workspace = await manager.ensureWorkspace(issue);
    const captured = JSON.parse(await readFile(marker, "utf8")) as Record<string, string>;

    expect(captured).toMatchObject({
      hook: "after_create",
      workflow_dir: config.workflowDir,
      workspace_path: workspace.path,
      workspace_key: "FE-7",
      workspace_created_now: "true",
      id: "issue-123",
      identifier: "FE-7",
      title: "Replace homepage hero",
      state: "Todo",
      priority: "2",
      branch_name: "fe/hero",
      url: "https://linear.app/x/FE-7",
      labels: "repo:frontend-repo,area:hero",
      description: "long description"
    });
  });

  it("exports SYMPHONY_REPOS and per-repo env slots when the workspace has repository checkouts", () => {
    const root = "/tmp/symphony-root";
    const config = configFor(root, null);
    const workspace = {
      path: path.join(root, "FE-7"),
      workspace_key: "FE-7",
      created_now: true,
      repositories: [
        {
          name: "frontend",
          path: path.join(root, "FE-7", "frontend"),
          url: "https://github.com/metyatech/frontend.git",
          created_now: true
        },
        {
          name: "shared-lib",
          path: path.join(root, "FE-7", "shared-lib"),
          url: "https://github.com/metyatech/shared-lib.git",
          created_now: false
        }
      ]
    };
    const env = buildHookEnv(
      "after_create",
      config,
      {
        ...makeIssue("FE-7"),
        labels: ["repo:frontend", "repo:shared-lib"]
      },
      workspace
    );

    expect(env.SYMPHONY_REPOS).toBe("frontend,shared-lib");
    expect(env.SYMPHONY_REPO_FRONTEND_NAME).toBe("frontend");
    expect(env.SYMPHONY_REPO_FRONTEND_PATH).toBe(workspace.repositories[0]?.path);
    expect(env.SYMPHONY_REPO_FRONTEND_CREATED_NOW).toBe("true");
    expect(env.SYMPHONY_REPO_SHARED_LIB_CREATED_NOW).toBe("false");
    expect(env.SYMPHONY_REPO_SHARED_LIB_URL).toBe("https://github.com/metyatech/shared-lib.git");
  });

  it("does not leak parent-process secrets into the hook environment", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "symphony-workspaces-"));
    const root = path.join(parent, "root");
    const marker = path.join(parent, "hook-secret.json");
    const markerForScript = marker.replaceAll("\\", "\\\\");
    const script =
      `node -e "require('fs').writeFileSync('${markerForScript}', JSON.stringify({` +
      "linear: process.env.LINEAR_API_KEY ?? null," +
      "token: process.env.GITHUB_TOKEN ?? null," +
      `marker: process.env.SYMPHONY_HOOK_MARKER ?? null}))"`;
    const config = configFor(root, script);
    const manager = new WorkspaceManager(() => config, new MemoryLogger());

    const previous = {
      linear: process.env.LINEAR_API_KEY,
      token: process.env.GITHUB_TOKEN,
      marker: process.env.SYMPHONY_HOOK_MARKER
    };
    process.env.LINEAR_API_KEY = "lin_api_should_not_leak";
    process.env.GITHUB_TOKEN = "ghp_should_not_leak";
    process.env.SYMPHONY_HOOK_MARKER = "non-secret-passes-through";

    try {
      await manager.ensureWorkspace(makeIssue("SEC-1"));
      const captured = JSON.parse(await readFile(marker, "utf8")) as Record<string, string | null>;
      expect(captured.linear).toBeNull();
      expect(captured.token).toBeNull();
      expect(captured.marker).toBe("non-secret-passes-through");
    } finally {
      restoreEnv("LINEAR_API_KEY", previous.linear);
      restoreEnv("GITHUB_TOKEN", previous.token);
      restoreEnv("SYMPHONY_HOOK_MARKER", previous.marker);
    }
  });

  it("prefers an existing local Git checkout over cloning into the issue workspace", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "symphony-local-repos-"));
    const root = path.join(parent, "workspaces");
    const localRoot = path.join(parent, "local");
    const localRepo = path.join(localRoot, "frontend");
    await initGitRepo(localRepo);
    const config = configFor(root, null);
    config.repositories.owner = "metyatech";
    config.repositories.local = { prefer_existing: true, roots: [localRoot] };
    const manager = new WorkspaceManager(() => config, new MemoryLogger());

    const workspace = await manager.ensureWorkspace({
      ...makeIssue("FE-10"),
      labels: ["repo:frontend"]
    });

    expect(workspace.repositories).toHaveLength(1);
    expect(workspace.repositories[0]).toMatchObject({
      name: "frontend",
      path: await realpath(localRepo),
      url: "https://github.com/metyatech/frontend.git",
      created_now: false
    });
    await expect(access(path.join(workspace.path, "frontend"))).rejects.toThrow();
  });

  it("falls back to cloning into the issue workspace when no local checkout exists", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "symphony-local-repos-"));
    const root = path.join(parent, "workspaces");
    const originRoot = path.join(parent, "origins");
    const origin = path.join(originRoot, "metyatech", "frontend.git");
    await initBareGitRepo(origin);
    const config = configFor(root, null);
    config.repositories.owner = "metyatech";
    config.repositories.base_url = pathToFileURL(originRoot).href;
    config.repositories.local = {
      prefer_existing: true,
      roots: [path.join(parent, "missing-local")]
    };
    const manager = new WorkspaceManager(() => config, new MemoryLogger());

    const workspace = await manager.ensureWorkspace({
      ...makeIssue("FE-11"),
      labels: ["repo:frontend"]
    });

    const workspaceRepo = path.join(workspace.path, "frontend");
    expect(workspace.repositories).toHaveLength(1);
    expect(workspace.repositories[0]).toMatchObject({
      name: "frontend",
      path: workspaceRepo,
      url: `${pathToFileURL(originRoot).href}/metyatech/frontend.git`,
      created_now: true
    });
    await expect(access(path.join(workspaceRepo, ".git"))).resolves.toBeUndefined();
  });

  it("ignores a local candidate that is only nested inside another Git checkout", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "symphony-local-repos-"));
    const root = path.join(parent, "workspaces");
    const localRoot = path.join(parent, "local-root");
    const nestedCandidate = path.join(localRoot, "frontend");
    const originRoot = path.join(parent, "origins");
    const origin = path.join(originRoot, "metyatech", "frontend.git");
    await initGitRepo(localRoot);
    await mkdir(nestedCandidate, { recursive: true });
    await initBareGitRepo(origin);
    const config = configFor(root, null);
    config.repositories.owner = "metyatech";
    config.repositories.base_url = pathToFileURL(originRoot).href;
    config.repositories.local = { prefer_existing: true, roots: [localRoot] };
    const manager = new WorkspaceManager(() => config, new MemoryLogger());

    const workspace = await manager.ensureWorkspace({
      ...makeIssue("FE-12"),
      labels: ["repo:frontend"]
    });

    expect(workspace.repositories[0]?.path).toBe(path.join(workspace.path, "frontend"));
    expect(workspace.repositories[0]?.created_now).toBe(true);
  });
});

function makeIssue(identifier: string, state = "Todo"): Issue {
  return {
    id: identifier,
    identifier,
    title: identifier,
    description: null,
    priority: null,
    state,
    branch_name: null,
    url: null,
    labels: [],
    project_slug: null,
    blocked_by: [],
    created_at: null,
    updated_at: null
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function configFor(root: string, afterCreate: string | null): ServiceConfig {
  return {
    workflowPath: path.join(root, "WORKFLOW.md"),
    workflowDir: root,
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      api_key: "x",
      team: "P",
      project_slug: null,
      trigger_label: null,
      active_states: ["Todo"],
      terminal_states: ["Done"]
    },
    polling: { interval_ms: 30000 },
    server: { port: null },
    workspace: { root },
    repositories: {
      owner: null,
      base_url: "https://github.com",
      protocol: "https",
      label_prefix: "repo:",
      default: [],
      required: false,
      local: { prefer_existing: false, roots: [] }
    },
    hooks: {
      after_create: afterCreate,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 30000
    },
    agent: {
      max_concurrent_agents: 10,
      max_turns: 20,
      max_retries: 3,
      max_retry_backoff_ms: 300000,
      max_concurrent_agents_by_state: new Map()
    },
    codex: {
      command: 'node -e "process.exit(0)"',
      approval_policy: undefined,
      thread_sandbox: undefined,
      turn_sandbox_policy: undefined,
      turn_timeout_ms: 1000,
      read_timeout_ms: 5000,
      stall_timeout_ms: 300000
    }
  };
}

async function initGitRepo(repoPath: string): Promise<void> {
  await mkdir(repoPath, { recursive: true });
  await runGit(["init", "--quiet"], repoPath);
}

async function initBareGitRepo(repoPath: string): Promise<void> {
  await mkdir(path.dirname(repoPath), { recursive: true });
  await runGit(["init", "--bare", "--quiet", repoPath], path.dirname(repoPath));
}

function runGit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git exited with code ${code ?? "null"}`));
    });
  });
}
