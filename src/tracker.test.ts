import { describe, expect, it } from "vitest";
import {
  isIssueInTrackerScope,
  LinearClient,
  passesBlockerRule,
  sortCandidates
} from "./tracker.js";
import type { Issue, ServiceConfig } from "./types.js";

describe("tracker helpers", () => {
  it("sorts by priority, oldest creation time, then identifier", () => {
    expect(
      sortCandidates([
        issue("B", 2, "2024-01-01"),
        issue("C", 1, "2025-01-01"),
        issue("A", 1, "2024-01-01")
      ]).map((item) => item.identifier)
    ).toEqual(["A", "C", "B"]);
  });

  it("blocks Todo issues with non-terminal blockers", () => {
    const config = { tracker: { terminal_states: ["Done"] } } as ServiceConfig;
    const blocked = issue("A", 1, "2024-01-01");
    blocked.blocked_by = [{ id: "2", identifier: "B", state: "Todo" }];
    expect(passesBlockerRule(blocked, config)).toBe(false);
    blocked.blocked_by = [{ id: "2", identifier: "B", state: "Done" }];
    expect(passesBlockerRule(blocked, config)).toBe(true);
  });

  it("filters Linear candidate queries by configured project slug and trigger label", async () => {
    const config = configForScope("symphony-core", "symphony-ready");
    let capturedQuery = "";
    let capturedVariables: Record<string, unknown> = {};
    class CapturingLinearClient extends LinearClient {
      override executeGraphQL(query: string, variables: Record<string, unknown>): Promise<unknown> {
        capturedQuery = query;
        capturedVariables = variables;
        return Promise.resolve({
          issues: {
            nodes: [
              linearIssue("A", "symphony-core", ["symphony-ready"]),
              linearIssue("B", "other-project", ["symphony-ready"]),
              linearIssue("C", "symphony-core", ["triage"])
            ]
          }
        });
      }
    }

    const issues = await new CapturingLinearClient(() => config).fetchCandidateIssues();

    expect(capturedQuery).toContain("project: { slugId: { eq: $projectSlug } }");
    expect(capturedQuery).toContain("labels: { name: { eq: $triggerLabel } }");
    expect(capturedVariables).toMatchObject({
      teamKey: "DEMO",
      states: ["Todo"],
      projectSlug: "symphony-core",
      triggerLabel: "symphony-ready"
    });
    expect(issues.map((item) => item.identifier)).toEqual(["A"]);
  });

  it("omits project and trigger label query variables when scope fields are not configured", async () => {
    const config = configForScope(null, null);
    let capturedQuery = "";
    let capturedVariables: Record<string, unknown> = {};
    class CapturingLinearClient extends LinearClient {
      override executeGraphQL(query: string, variables: Record<string, unknown>): Promise<unknown> {
        capturedQuery = query;
        capturedVariables = variables;
        return Promise.resolve({ issues: { nodes: [] } });
      }
    }

    await new CapturingLinearClient(() => config).fetchCandidateIssues();

    expect(capturedQuery).not.toContain("$projectSlug");
    expect(capturedQuery).not.toContain("$triggerLabel");
    expect(capturedVariables).toEqual({ teamKey: "DEMO", states: ["Todo"] });
  });

  it("keeps local issue eligibility inside configured project and trigger label scope", () => {
    const config = configForScope("symphony-core", "symphony-ready");

    expect(
      isIssueInTrackerScope(
        {
          ...issue("A", 1, "2024-01-01"),
          project_slug: "SYMPHONY-CORE",
          labels: ["Symphony-Ready"]
        },
        config
      )
    ).toBe(true);
    expect(
      isIssueInTrackerScope(
        { ...issue("B", 1, "2024-01-01"), project_slug: "other", labels: ["Symphony-Ready"] },
        config
      )
    ).toBe(false);
    expect(
      isIssueInTrackerScope(
        { ...issue("C", 1, "2024-01-01"), project_slug: "symphony-core", labels: ["triage"] },
        config
      )
    ).toBe(false);
  });
});

function issue(identifier: string, priority: number | null, created_at: string): Issue {
  return {
    id: identifier,
    identifier,
    title: identifier,
    description: null,
    priority,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: [],
    project_slug: null,
    blocked_by: [],
    created_at,
    updated_at: null
  };
}

function configForScope(project_slug: string | null, trigger_label: string | null): ServiceConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    workflowDir: "/tmp",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      api_key: "x",
      team: "DEMO",
      project_slug,
      trigger_label,
      active_states: ["Todo"],
      terminal_states: ["Done"]
    },
    polling: { interval_ms: 30000 },
    server: { port: null },
    workspace: { root: "/tmp/workspaces" },
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
      max_concurrent_agents: 10,
      max_turns: 20,
      max_retries: 3,
      max_retry_backoff_ms: 300000,
      max_concurrent_agents_by_state: new Map()
    },
    codex: {
      command: "codex app-server",
      approval_policy: undefined,
      thread_sandbox: undefined,
      turn_sandbox_policy: undefined,
      turn_timeout_ms: 1000,
      read_timeout_ms: 5000,
      stall_timeout_ms: 300000
    }
  };
}

function linearIssue(identifier: string, projectSlug: string, labels: string[]): unknown {
  return {
    id: identifier,
    identifier,
    title: identifier,
    description: null,
    priority: 1,
    state: { name: "Todo" },
    branchName: null,
    url: null,
    project: { slugId: projectSlug },
    labels: { nodes: labels.map((name) => ({ name })) },
    relations: { nodes: [] },
    createdAt: "2024-01-01",
    updatedAt: null
  };
}
