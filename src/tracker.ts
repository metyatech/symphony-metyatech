import { SymphonyError } from "./errors.js";
import { normalizeState } from "./workflow.js";
import type { Issue, ServiceConfig } from "./types.js";

export interface IssueTrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssueStates(issueIds: string[]): Promise<Issue[]>;
  fetchTerminalIssues(): Promise<Issue[]>;
}

export class LinearClient implements IssueTrackerClient {
  constructor(private readonly getConfig: () => ServiceConfig) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.queryIssues(this.getConfig().tracker.active_states);
  }

  async fetchIssueStates(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return [];
    const query = `query SymphonyIssues($ids: [String!]!) { issues(filter: { id: { in: $ids } }) { nodes { id identifier title description priority state { name } branchName url labels { nodes { name } } relations { nodes { type relatedIssue { id identifier state { name } } } } createdAt updatedAt } } }`;
    return this.executeIssueQuery(query, { ids: issueIds });
  }

  async fetchTerminalIssues(): Promise<Issue[]> {
    return this.queryIssues(this.getConfig().tracker.terminal_states);
  }

  private async queryIssues(states: string[]): Promise<Issue[]> {
    const query = `query SymphonyIssues($projectSlug: String!, $states: [String!]!) { issues(filter: { project: { slug: { eq: $projectSlug } }, state: { name: { in: $states } } }) { nodes { id identifier title description priority state { name } branchName url labels { nodes { name } } relations { nodes { type relatedIssue { id identifier state { name } } } } createdAt updatedAt } } }`;
    return this.executeIssueQuery(query, {
      projectSlug: this.getConfig().tracker.project_slug,
      states
    });
  }

  private async executeIssueQuery(
    query: string,
    variables: Record<string, unknown>
  ): Promise<Issue[]> {
    const config = this.getConfig();
    if (!config.tracker.api_key)
      throw new SymphonyError("tracker_error", "Linear API key is missing");
    const response = await fetch(config.tracker.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: config.tracker.api_key },
      body: JSON.stringify({ query, variables })
    });
    if (!response.ok)
      throw new SymphonyError(
        "tracker_error",
        `Linear request failed with HTTP ${response.status}`
      );
    const body = (await response.json()) as LinearResponse;
    if (body.errors?.length)
      throw new SymphonyError("tracker_error", body.errors.map((item) => item.message).join("; "));
    return (body.data?.issues?.nodes ?? [])
      .map(normalizeLinearIssue)
      .filter((issue): issue is Issue => issue !== null);
  }
}

export function isActiveIssue(issue: Issue, config: ServiceConfig): boolean {
  const state = normalizeState(issue.state);
  const active = new Set(config.tracker.active_states.map(normalizeState));
  const terminal = new Set(config.tracker.terminal_states.map(normalizeState));
  return active.has(state) && !terminal.has(state);
}

export function isTerminalIssue(issue: Issue, config: ServiceConfig): boolean {
  return new Set(config.tracker.terminal_states.map(normalizeState)).has(
    normalizeState(issue.state)
  );
}

export function sortCandidates(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const priorityA = a.priority ?? Number.POSITIVE_INFINITY;
    const priorityB = b.priority ?? Number.POSITIVE_INFINITY;
    if (priorityA !== priorityB) return priorityA - priorityB;
    const createdA = a.created_at ?? "9999-12-31T23:59:59.999Z";
    const createdB = b.created_at ?? "9999-12-31T23:59:59.999Z";
    if (createdA !== createdB) return createdA.localeCompare(createdB);
    return a.identifier.localeCompare(b.identifier);
  });
}

export function passesBlockerRule(issue: Issue, config: ServiceConfig): boolean {
  if (normalizeState(issue.state) !== "todo") return true;
  const terminal = new Set(config.tracker.terminal_states.map(normalizeState));
  return issue.blocked_by.every(
    (blocker) => blocker.state !== null && terminal.has(normalizeState(blocker.state))
  );
}

interface LinearResponse {
  data?: { issues?: { nodes?: LinearIssue[] } };
  errors?: Array<{ message: string }>;
}

interface LinearIssue {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  state?: { name?: unknown };
  branchName?: unknown;
  url?: unknown;
  labels?: { nodes?: Array<{ name?: unknown }> };
  relations?: {
    nodes?: Array<{
      type?: unknown;
      relatedIssue?: { id?: unknown; identifier?: unknown; state?: { name?: unknown } };
    }>;
  };
  createdAt?: unknown;
  updatedAt?: unknown;
}

function normalizeLinearIssue(input: LinearIssue): Issue | null {
  if (
    typeof input.id !== "string" ||
    typeof input.identifier !== "string" ||
    typeof input.title !== "string" ||
    typeof input.state?.name !== "string"
  )
    return null;
  return {
    id: input.id,
    identifier: input.identifier,
    title: input.title,
    description: typeof input.description === "string" ? input.description : null,
    priority: typeof input.priority === "number" ? input.priority : null,
    state: input.state.name,
    branch_name: typeof input.branchName === "string" ? input.branchName : null,
    url: typeof input.url === "string" ? input.url : null,
    labels: (input.labels?.nodes ?? []).flatMap((label) =>
      typeof label.name === "string" ? [label.name.toLowerCase()] : []
    ),
    blocked_by: (input.relations?.nodes ?? [])
      .filter((relation) => relation.type === "blocks")
      .map((relation) => ({
        id: typeof relation.relatedIssue?.id === "string" ? relation.relatedIssue.id : null,
        identifier:
          typeof relation.relatedIssue?.identifier === "string"
            ? relation.relatedIssue.identifier
            : null,
        state:
          typeof relation.relatedIssue?.state?.name === "string"
            ? relation.relatedIssue.state.name
            : null
      })),
    created_at: typeof input.createdAt === "string" ? input.createdAt : null,
    updated_at: typeof input.updatedAt === "string" ? input.updatedAt : null
  };
}
