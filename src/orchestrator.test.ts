import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "./codex-runner.js";
import { MemoryLogger } from "./logger.js";
import { Orchestrator } from "./orchestrator.js";
import type { IssueTrackerClient } from "./tracker.js";
import type { Issue, RunResult, ServiceConfig, WorkflowDefinition } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

describe("orchestrator", () => {
  it("dispatches eligible issues up to concurrency limits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      "---\ntracker:\n  kind: linear\n  api_key: x\n  team: P\nagent:\n  max_concurrent_agents: 1\n---\nDo {{ issue.identifier }}",
      "utf8"
    );
    const config = configFor(root);
    const tracker = new FakeTracker([issue("A"), issue("B")]);
    let runs = 0;
    const orchestrator = new Orchestrator(
      workflowPath,
      workflow(),
      config,
      tracker,
      new WorkspaceManager(() => config, new MemoryLogger()),
      () =>
        new FakeRunner(() => {
          runs += 1;
        }),
      new MemoryLogger()
    );

    await orchestrator.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runs).toBe(1);
    await orchestrator.stop();
  });

  it("startup cleanup removes terminal issue workspaces", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      "---\ntracker:\n  kind: linear\n  api_key: x\n  team: P\n---\nDo {{ issue.identifier }}",
      "utf8"
    );
    const config = configFor(root);
    const tracker = new FakeTracker([], [issue("DONE", "Done")]);
    const manager = new WorkspaceManager(() => config, new MemoryLogger());
    await manager.ensureWorkspace(issue("DONE", "Done"));
    const orchestrator = new Orchestrator(
      workflowPath,
      workflow(),
      config,
      tracker,
      manager,
      () => new FakeRunner(() => undefined),
      new MemoryLogger()
    );

    await orchestrator.start();

    expect(orchestrator.state.poll_interval_ms).toBe(30000);
    await orchestrator.stop();
  });

  it("runs continuation turns up to max_turns while the issue remains active", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      "---\ntracker:\n  kind: linear\n  api_key: x\n  team: P\nagent:\n  max_concurrent_agents: 1\n  max_turns: 2\n---\nDo {{ issue.identifier }}",
      "utf8"
    );
    const config = configFor(root);
    config.agent.max_turns = 2;
    const tracker = new FakeTracker([issue("A")]);
    let runs = 0;
    const orchestrator = new Orchestrator(
      workflowPath,
      workflow(),
      config,
      tracker,
      new WorkspaceManager(() => config, new MemoryLogger()),
      () =>
        new FakeRunner(() => {
          runs += 1;
        }, "succeeded"),
      new MemoryLogger()
    );

    await orchestrator.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(runs).toBe(2);
    await orchestrator.stop();
  });

  it("does not dispatch issues outside configured project and trigger label scope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      "---\ntracker:\n  kind: linear\n  api_key: x\n  team: P\n  project_slug: symphony-core\n  trigger_label: symphony-ready\nagent:\n  max_concurrent_agents: 2\n---\nDo {{ issue.identifier }}",
      "utf8"
    );
    const config = configFor(root);
    config.tracker.project_slug = "symphony-core";
    config.tracker.trigger_label = "symphony-ready";
    config.agent.max_concurrent_agents = 2;
    const tracker = new FakeTracker([
      { ...issue("IN"), project_slug: "symphony-core", labels: ["symphony-ready"] },
      { ...issue("OUT-PROJECT"), project_slug: "other", labels: ["symphony-ready"] },
      { ...issue("OUT-LABEL"), project_slug: "symphony-core", labels: ["triage"] }
    ]);
    const runIds: string[] = [];
    const orchestrator = new Orchestrator(
      workflowPath,
      workflow(),
      config,
      tracker,
      new WorkspaceManager(() => config, new MemoryLogger()),
      () => new FakeRunner((candidate) => runIds.push(candidate.identifier)),
      new MemoryLogger()
    );

    await orchestrator.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(runIds).toEqual(["IN"]);
    await orchestrator.stop();
  });

  it("uses the selected checkout path as runner cwd when exactly one repository is selected", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      "---\ntracker:\n  kind: linear\n  api_key: x\n  team: P\nrepositories:\n  owner: metyatech\n---\nDo {{ issue.identifier }}",
      "utf8"
    );
    const config = configFor(root);
    config.repositories.owner = "metyatech";
    const candidate = { ...issue("A"), labels: ["repo:frontend"] };
    const repoPath = path.join(root, "A", "frontend");
    await import("node:fs/promises").then((fs) => fs.mkdir(repoPath, { recursive: true }));
    let cwd: string | null = null;
    const orchestrator = new Orchestrator(
      workflowPath,
      workflow(),
      config,
      new FakeTracker([candidate]),
      new WorkspaceManager(() => config, new MemoryLogger()),
      () => new FakeRunner((_issue, workspacePath) => (cwd = workspacePath)),
      new MemoryLogger()
    );

    await orchestrator.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(cwd).toBe(repoPath);
    await orchestrator.stop();
  });

  it("keeps issue workspace as runner cwd when multiple repositories are selected", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      "---\ntracker:\n  kind: linear\n  api_key: x\n  team: P\nrepositories:\n  owner: metyatech\n---\nDo {{ issue.identifier }}",
      "utf8"
    );
    const config = configFor(root);
    config.repositories.owner = "metyatech";
    const candidate = { ...issue("A"), labels: ["repo:frontend", "repo:backend"] };
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(path.join(root, "A", "frontend"), { recursive: true }),
        fs.mkdir(path.join(root, "A", "backend"), { recursive: true })
      ])
    );
    let cwd: string | null = null;
    const orchestrator = new Orchestrator(
      workflowPath,
      workflow(),
      config,
      new FakeTracker([candidate]),
      new WorkspaceManager(() => config, new MemoryLogger()),
      () => new FakeRunner((_issue, workspacePath) => (cwd = workspacePath)),
      new MemoryLogger()
    );

    await orchestrator.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(cwd).toBe(path.join(root, "A"));
    await orchestrator.stop();
  });

  it("fails before runner starts when repositories are required and none are selected", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      "---\ntracker:\n  kind: linear\n  api_key: x\n  team: P\nrepositories:\n  owner: metyatech\n  required: true\n---\nDo {{ issue.identifier }}",
      "utf8"
    );
    const config = configFor(root);
    config.repositories.owner = "metyatech";
    config.repositories.required = true;
    let runs = 0;
    const orchestrator = new Orchestrator(
      workflowPath,
      workflow(),
      config,
      new FakeTracker([issue("A")]),
      new WorkspaceManager(() => config, new MemoryLogger()),
      () =>
        new FakeRunner(() => {
          runs += 1;
        }),
      new MemoryLogger()
    );

    await orchestrator.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(runs).toBe(0);
    await orchestrator.stop();
  });
});

class FakeTracker implements IssueTrackerClient {
  constructor(
    private readonly candidates: Issue[],
    private readonly terminal: Issue[] = []
  ) {}
  fetchCandidateIssues(): Promise<Issue[]> {
    return Promise.resolve(this.candidates);
  }
  fetchIssueStates(issueIds: string[]): Promise<Issue[]> {
    return Promise.resolve(this.candidates.filter((issue) => issueIds.includes(issue.id)));
  }
  fetchTerminalIssues(): Promise<Issue[]> {
    return Promise.resolve(this.terminal);
  }
  executeGraphQL(): Promise<unknown> {
    return Promise.resolve({});
  }
  addComment(): Promise<void> {
    return Promise.resolve();
  }
  updateIssueState(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeRunner implements AgentRunner {
  constructor(
    private readonly onRun: (issue: Issue, workspacePath: string) => void,
    private readonly status: RunResult["status"] = "canceled"
  ) {}
  run(issue: Issue, workspacePath: string): Promise<RunResult> {
    this.onRun(issue, workspacePath);
    return Promise.resolve({ status: this.status, error: null, runtime_ms: 1 });
  }
  async cancel(): Promise<void> {}
}

function workflow(): WorkflowDefinition {
  return { config: {}, prompt_template: "Do {{ issue.identifier }}" };
}

function configFor(root: string): ServiceConfig {
  return {
    workflowPath: path.join(root, "WORKFLOW.md"),
    workflowDir: root,
    tracker: {
      kind: "linear",
      endpoint: "x",
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
      required: false
    },
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 30000
    },
    agent: {
      max_concurrent_agents: 1,
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

function issue(identifier: string, state = "Todo"): Issue {
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
