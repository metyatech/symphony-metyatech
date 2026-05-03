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
      "---\ntracker:\n  kind: linear\n  api_key: x\n  project_slug: P\nagent:\n  max_concurrent_agents: 1\n---\nDo {{ issue.identifier }}",
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
      "---\ntracker:\n  kind: linear\n  api_key: x\n  project_slug: P\n---\nDo {{ issue.identifier }}",
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
      "---\ntracker:\n  kind: linear\n  api_key: x\n  project_slug: P\nagent:\n  max_concurrent_agents: 1\n  max_turns: 2\n---\nDo {{ issue.identifier }}",
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
}

class FakeRunner implements AgentRunner {
  constructor(
    private readonly onRun: () => void,
    private readonly status: RunResult["status"] = "canceled"
  ) {}
  run(): Promise<RunResult> {
    this.onRun();
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
      project_slug: "P",
      active_states: ["Todo"],
      terminal_states: ["Done"]
    },
    polling: { interval_ms: 30000 },
    workspace: { root },
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
    blocked_by: [],
    created_at: null,
    updated_at: null
  };
}
