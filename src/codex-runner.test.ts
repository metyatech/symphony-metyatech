import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexRunner } from "./codex-runner.js";
import { MemoryLogger } from "./logger.js";
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
      new MemoryLogger()
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
      new MemoryLogger()
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
      logger
    ).run(issue(), workspace, null, () => undefined);

    expect(JSON.stringify(logger.entries)).not.toContain("lin_api_secret");
    expect(JSON.stringify(logger.entries)).toContain("[REDACTED]");
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

function configFor(root: string): ServiceConfig {
  return {
    workflowPath: path.join(root, "WORKFLOW.md"),
    workflowDir: root,
    tracker: {
      kind: "linear",
      endpoint: "x",
      api_key: "x",
      team: "P",
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
      max_concurrent_agents: 10,
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
    blocked_by: [],
    created_at: null,
    updated_at: null
  };
}
