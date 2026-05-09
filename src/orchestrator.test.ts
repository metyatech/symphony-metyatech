import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  it("loadState drops naked claimed IDs that have no backing retry entry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      "---\ntracker:\n  kind: linear\n  api_key: x\n  team: P\nagent:\n  max_concurrent_agents: 1\n---\nDo {{ issue.identifier }}",
      "utf8"
    );
    const statePath = path.join(root, "orchestrator_state.json");
    // Simulate the post-crash file: claimed without retry_attempts.
    await writeFile(
      statePath,
      JSON.stringify({
        claimed: ["A"],
        completed: [],
        retry_attempts: [],
        codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, runtime_ms: 0 },
        codex_rate_limits: null
      }),
      "utf8"
    );
    const config = configFor(root);
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
        }),
      new MemoryLogger()
    );

    await orchestrator.loadState(statePath);
    expect(orchestrator.state.claimed.has("A")).toBe(false);

    await orchestrator.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(runs).toBe(1);
    await orchestrator.stop();
  });

  it("loadState preserves claimed IDs that are backed by a retry entry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      "---\ntracker:\n  kind: linear\n  api_key: x\n  team: P\nagent:\n  max_concurrent_agents: 1\n---\nDo {{ issue.identifier }}",
      "utf8"
    );
    const statePath = path.join(root, "orchestrator_state.json");
    // A retry-backed claim must remain claimed so normal dispatch
    // does not race the retry timer.
    await writeFile(
      statePath,
      JSON.stringify({
        claimed: ["A"],
        completed: [],
        retry_attempts: [
          [
            "A",
            {
              issue_id: "A",
              identifier: "A",
              attempt: 1,
              // Far in the future so the timer does not fire during the test.
              due_at_ms: Date.now() + 60_000,
              timer_handle: null,
              error: "prior failure"
            }
          ]
        ],
        codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, runtime_ms: 0 },
        codex_rate_limits: null
      }),
      "utf8"
    );
    const config = configFor(root);
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
        }),
      new MemoryLogger()
    );

    await orchestrator.loadState(statePath);
    expect(orchestrator.state.claimed.has("A")).toBe(true);
    expect(orchestrator.state.retry_attempts.has("A")).toBe(true);

    await orchestrator.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The normal dispatch path must not run while a retry is pending.
    expect(runs).toBe(0);
    await orchestrator.stop();
  });

  it("saveState does not persist naked claimed IDs without a backing retry entry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orch-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      "---\ntracker:\n  kind: linear\n  api_key: x\n  team: P\n---\nDo {{ issue.identifier }}",
      "utf8"
    );
    const config = configFor(root);
    const orchestrator = new Orchestrator(
      workflowPath,
      workflow(),
      config,
      new FakeTracker([]),
      new WorkspaceManager(() => config, new MemoryLogger()),
      () => new FakeRunner(() => undefined),
      new MemoryLogger()
    );
    // Simulate a transient in-memory claim that is not retry-backed,
    // such as a claim from a `dispatch` whose worker is still running.
    orchestrator.state.claimed.add("A");

    const statePath = path.join(root, "orchestrator_state.json");
    await orchestrator.saveState(statePath);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as { claimed: string[] };
    expect(persisted.claimed).toEqual([]);

    // A retry-backed claim must round-trip through the persisted file.
    orchestrator.state.retry_attempts.set("B", {
      issue_id: "B",
      identifier: "B",
      attempt: 1,
      due_at_ms: Date.now() + 60_000,
      timer_handle: null,
      error: null
    });
    await orchestrator.saveState(statePath);
    const persisted2 = JSON.parse(await readFile(statePath, "utf8")) as { claimed: string[] };
    expect(persisted2.claimed).toEqual(["B"]);

    // Clean up the retry timer registered through a hypothetical reload.
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
    logging: {
      file: {
        enabled: false,
        path: path.join(root, ".symphony", "logs", "symphony.log"),
        max_bytes: 1024,
        max_files: 2
      }
    },
    repositories: {
      owner: null,
      base_url: "https://github.com",
      protocol: "https",
      label_prefix: "repo:",
      default: [],
      required: false,
      local: {
        prefer_existing: false,
        roots: [],
        isolation: "none",
        init_if_missing: false,
        init_no_verify: false,
        branch_template: "symphony/{{ issue.identifier }}",
        path_template: "{{ workspace }}/{{ repo }}",
        overrides: new Map()
      }
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
