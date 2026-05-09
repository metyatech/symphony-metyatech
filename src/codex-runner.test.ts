import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexRunner } from "./codex-runner.js";
import { MemoryLogger } from "./logger.js";
import type { IssueTrackerClient } from "./tracker.js";
import type { Issue, ServiceConfig } from "./types.js";

describe("CodexRunner", () => {
  it("waits for app-server thread and turn protocol completion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-runner-"));
    const workspace = path.join(root, "ABC-1");
    await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
    const config = configFor(root);
    const fakeServer = await writeFakeServer(root, false);
    config.codex.command = `node "${fakeServer}"`;
    const sessions: string[] = [];
    const result = await new CodexRunner(
      () => config,
      () => "Work on {{ issue.identifier }}",
      new MemoryLogger(),
      fakeTracker()
    ).run(issue(), workspace, null, (session) => sessions.push(session.session_id));

    expect(result.status).toBe("succeeded");
    expect(sessions).toContain("thread-real-turn-real");
  });

  it("does not treat early app-server exit as success", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-runner-"));
    const workspace = path.join(root, "ABC-1");
    await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
    const config = configFor(root);
    config.codex.command = 'node -e "process.exit(0)"';

    const result = await new CodexRunner(
      () => config,
      () => "Work on {{ issue.identifier }}",
      new MemoryLogger(),
      fakeTracker()
    ).run(issue(), workspace, null, () => undefined);

    expect(result.status).toBe("failed");
  });

  it("redacts secrets emitted on stderr", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-runner-"));
    const workspace = path.join(root, "ABC-1");
    await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
    const config = configFor(root);
    const fakeServer = await writeFakeServer(root, true);
    config.codex.command = `node "${fakeServer}"`;
    const logger = new MemoryLogger();

    await new CodexRunner(
      () => config,
      () => "Work on {{ issue.identifier }}",
      logger,
      fakeTracker()
    ).run(issue(), workspace, null, () => undefined);

    expect(JSON.stringify(logger.entries)).not.toContain("lin_api_secret");
    expect(JSON.stringify(logger.entries)).toContain("[REDACTED]");
  });

  it("negotiates dynamic tools and answers item tool calls with Linear GraphQL results", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-runner-"));
    const workspace = path.join(root, "ABC-1");
    await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
    const config = configFor(root);
    const query = "query LinearIssue($id: String!) { issue(id: $id) { id title } }";
    const variables = { id: "ABC-1" };
    const linearResult = { data: { issue: { id: "issue-1", title: "GraphQL Title" } } };
    const fakeServer = await writeDynamicToolServer(root, query, variables, linearResult);
    config.codex.command = `node "${fakeServer}"`;

    const result = await new CodexRunner(
      () => config,
      () => "Work on {{ issue.identifier }}",
      new MemoryLogger(),
      fakeTracker({ query, variables, result: linearResult })
    ).run(issue(), workspace, null, () => undefined);

    expect(result.status).toBe("succeeded");
    expect(result.error).toBeNull();
  });

  it("allows a selected repository checkout outside the workspace root as runner cwd", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "symphony-runner-"));
    const root = path.join(parent, "workspaces");
    const localRepo = path.join(parent, "local", "frontend");
    await import("node:fs/promises").then((fs) => fs.mkdir(localRepo, { recursive: true }));
    const config = configFor(root);
    const fakeServer = await writeFakeServer(parent, false);
    config.codex.command = `node "${fakeServer}"`;

    const result = await new CodexRunner(
      () => config,
      () => "Work on {{ issue.identifier }}",
      new MemoryLogger(),
      fakeTracker()
    ).run(issue(), localRepo, null, () => undefined, [
      {
        name: "frontend",
        path: localRepo,
        url: "https://github.com/metyatech/frontend.git",
        created_now: false
      }
    ]);

    expect(result.status).toBe("succeeded");
  });

  it("rejects a runner cwd outside the workspace root when it is not a selected checkout", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "symphony-runner-"));
    const root = path.join(parent, "workspaces");
    const localRepo = path.join(parent, "local", "frontend");
    await import("node:fs/promises").then((fs) => fs.mkdir(localRepo, { recursive: true }));
    const config = configFor(root);
    const fakeServer = await writeFakeServer(parent, false);
    config.codex.command = `node "${fakeServer}"`;

    const result = await new CodexRunner(
      () => config,
      () => "Work on {{ issue.identifier }}",
      new MemoryLogger(),
      fakeTracker()
    ).run(issue(), localRepo, null, () => undefined, []);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Workspace path escapes root");
  });
});

async function writeFakeServer(root: string, leakSecret: boolean): Promise<string> {
  const script = path.join(root, leakSecret ? "fake-server-secret.mjs" : "fake-server.mjs");
  await writeFile(
    script,
    `import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
${leakSecret ? "process.stderr.write('token lin_api_secret\\n');" : ""}
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ id: msg.id, result: {} });
  if (msg.method === 'thread/start') send({ id: msg.id, result: { threadId: 'thread-real' } });
  if (msg.method === 'turn/start') {
    send({ id: msg.id, result: { turnId: 'turn-real' } });
    send({ method: 'turn/completed', params: { status: 'completed', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } });
    setTimeout(() => process.exit(0), 20);
  }
});
`,
    "utf8"
  );
  return script;
}

async function writeDynamicToolServer(
  root: string,
  query: string,
  variables: Record<string, unknown>,
  linearResult: unknown
): Promise<string> {
  const script = path.join(root, "fake-server-dynamic-tools.mjs");
  await writeFile(
    script,
    `import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const expectedQuery = ${JSON.stringify(query)};
const expectedVariables = ${JSON.stringify(variables)};
const expectedResultText = ${JSON.stringify(JSON.stringify(linearResult))};
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function fail(message) { process.stderr.write(message + '\\n'); process.exit(1); }
function assert(condition, message) { if (!condition) fail(message); }
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    assert(msg.params?.capabilities?.experimentalApi === true, 'initialize missing experimentalApi capability');
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'initialized') return;
  if (msg.method === 'thread/start') {
    const tools = msg.params?.dynamicTools;
    assert(Array.isArray(tools), 'thread/start missing dynamicTools');
    const linearTool = tools.find((tool) => tool?.name === 'linear_graphql');
    assert(linearTool, 'thread/start missing linear_graphql dynamic tool');
    assert(linearTool.inputSchema?.type === 'object', 'linear_graphql missing object inputSchema');
    assert(linearTool.inputSchema?.properties?.query?.type === 'string', 'linear_graphql missing query schema');
    assert(linearTool.inputSchema?.properties?.variables?.type === 'object', 'linear_graphql missing variables schema');
    assert(linearTool.inputSchema?.required?.includes('query'), 'linear_graphql schema must require query');
    send({ id: msg.id, result: { threadId: 'thread-real' } });
    return;
  }
  if (msg.method === 'turn/start') {
    send({ id: msg.id, result: { turnId: 'turn-real' } });
    send({
      id: 'tool-request-1',
      method: 'item/tool/call',
      params: {
        tool: 'linear_graphql',
        arguments: {
          query: expectedQuery,
          variables: expectedVariables
        },
        callId: 'linear-call-1',
        threadId: 'thread-real',
        turnId: 'turn-real'
      }
    });
    return;
  }
  if (msg.id === 'tool-request-1') {
    const result = msg.result;
    assert(result?.success === true, 'dynamic tool response must report success');
    assert(Array.isArray(result.contentItems), 'dynamic tool response missing contentItems');
    assert(result.contentItems.length === 1, 'dynamic tool response must contain one content item');
    const contentItem = result.contentItems[0];
    assert(contentItem?.type === 'inputText', 'dynamic tool response item must be inputText');
    assert(contentItem.text === expectedResultText, 'dynamic tool response text must contain Linear result');
    assert(sameJson(JSON.parse(contentItem.text), JSON.parse(expectedResultText)), 'dynamic tool response text must parse as Linear result');
    send({ method: 'turn/completed', params: { status: 'completed', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } });
    setTimeout(() => process.exit(0), 20);
    return;
  }
  fail('unexpected message: ' + line);
});
`,
    "utf8"
  );
  return script;
}

interface FakeTrackerOptions {
  query?: string;
  variables?: Record<string, unknown>;
  result?: unknown;
}

function fakeTracker(options: FakeTrackerOptions = {}): IssueTrackerClient {
  return {
    fetchCandidateIssues() {
      return Promise.resolve([]);
    },
    fetchIssueStates() {
      return Promise.resolve([]);
    },
    fetchTerminalIssues() {
      return Promise.resolve([]);
    },
    executeGraphQL(query: string, variables: Record<string, unknown>) {
      if (options.query !== undefined) expect(query).toBe(options.query);
      if (options.variables !== undefined) expect(variables).toEqual(options.variables);
      return Promise.resolve(options.result ?? { ok: true });
    },
    addComment() {
      return Promise.resolve();
    },
    updateIssueState() {
      return Promise.resolve();
    }
  };
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

function issue(): Issue {
  return {
    id: "1",
    identifier: "ABC-1",
    title: "Title",
    description: null,
    priority: null,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: [],
    project_slug: null,
    blocked_by: [],
    created_at: null,
    updated_at: null
  };
}
