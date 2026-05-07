import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { lstat, realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { SymphonyError, messageFromUnknown } from "./errors.js";
import { redactSecrets, sanitizedProcessEnv } from "./process-safety.js";
import { renderPrompt } from "./workflow.js";
import { ensureRealDirectoryInsideRoot } from "./workspace.js";
import type {
  Issue,
  Logger,
  LiveSession,
  RepoCheckout,
  RunResult,
  ServiceConfig
} from "./types.js";
import type { IssueTrackerClient } from "./tracker.js";

export interface AgentRunner {
  run(
    issue: Issue,
    workspacePath: string,
    attempt: number | null,
    onSession: (session: LiveSession) => void,
    repositories?: RepoCheckout[]
  ): Promise<RunResult>;
  cancel(reason: string): Promise<void>;
}

interface PendingRequest {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

type TurnOutcome = { kind: "pending" } | { kind: "completed" } | { kind: "failed"; error: Error };

export class CodexRunner implements AgentRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private currentThreadId: string | null = null;
  private currentTurnId: string | null = null;
  private stdoutBuffer = "";
  private turnSettled: ((value: void) => void) | null = null;
  private turnFailed: ((error: Error) => void) | null = null;
  /**
   * Records the most recently observed turn outcome so that an early
   * `turn/completed` (or terminal failure) notification arriving in the same
   * stdout chunk as its preceding response is not lost when
   * {@link waitForTurnCompletion} has not yet registered its listeners.
   */
  private turnOutcome: TurnOutcome = { kind: "pending" };
  private cancelled = false;

  constructor(
    private readonly getConfig: () => ServiceConfig,
    private readonly getPromptTemplate: () => string,
    private readonly logger: Logger,
    private readonly tracker: IssueTrackerClient
  ) {}

  async run(
    issue: Issue,
    workspacePath: string,
    attempt: number | null,
    onSession: (session: LiveSession) => void,
    repositories: RepoCheckout[] = []
  ): Promise<RunResult> {
    const started = Date.now();
    const config = this.getConfig();
    try {
      await ensureAllowedRunnerCwd(config, workspacePath, repositories);
      const prompt = await renderPrompt(this.getPromptTemplate(), issue, attempt, repositories);
      await this.runAppServerTurn(config, workspacePath, prompt, issue, onSession);
      return {
        status: this.cancelled ? "canceled" : "succeeded",
        error: this.cancelled ? "cancelled" : null,
        runtime_ms: Date.now() - started
      };
    } catch (error) {
      const message = messageFromUnknown(error);
      const status = this.cancelled
        ? "canceled"
        : message.includes("timed out")
          ? "timed_out"
          : "failed";
      return { status, error: message, runtime_ms: Date.now() - started };
    } finally {
      await this.stopChild();
    }
  }

  async cancel(reason: string): Promise<void> {
    this.cancelled = true;
    this.logger.warn("runner_cancelled", { reason });
    if (this.currentThreadId && this.currentTurnId) {
      try {
        await this.sendRequest("turn/interrupt", {
          threadId: this.currentThreadId,
          turnId: this.currentTurnId
        });
      } catch (error) {
        this.logger.warn("turn_interrupt_failed", {
          error: redactSecrets(messageFromUnknown(error))
        });
      }
    }
    await this.stopChild();
  }

  private async runAppServerTurn(
    config: ServiceConfig,
    workspacePath: string,
    prompt: string,
    issue: Issue,
    onSession: (session: LiveSession) => void
  ): Promise<void> {
    this.turnOutcome = { kind: "pending" };
    this.turnSettled = null;
    this.turnFailed = null;
    this.spawnAppServer(config, workspacePath, issue.identifier);
    const child = this.requireChild();
    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk, onSession));
    child.stderr.on("data", (chunk: Buffer) => {
      const message = redactSecrets(chunk.toString("utf8").trim());
      if (message) this.logger.warn("codex_stderr", { message });
    });
    child.once("exit", (code) =>
      this.failPending(
        new SymphonyError(
          "codex_runner_error",
          `codex app-server exited with code ${code ?? "null"}`
        )
      )
    );

    await this.sendRequest("initialize", {
      clientInfo: { name: "symphony", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    this.sendNotification("initialized", {});
    const threadResponse = await this.sendRequest("thread/start", {
      cwd: workspacePath,
      title: `${issue.identifier}: ${issue.title}`,
      approvalPolicy: config.codex.approval_policy,
      sandbox: config.codex.thread_sandbox,
      dynamicTools: [
        {
          name: "linear_graphql",
          description: "Execute a GraphQL query or mutation against the Linear API.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "The GraphQL query or mutation string" },
              variables: { type: "object", description: "Variables for the GraphQL query" }
            },
            required: ["query"]
          }
        }
      ]
    });
    this.currentThreadId = extractId(threadResponse, ["threadId", "id"], ["thread"]);
    if (!this.currentThreadId)
      throw new SymphonyError("codex_runner_error", "thread/start did not return a thread id");
    onSession(
      createLiveSession(
        this.currentThreadId,
        "pending",
        child.pid?.toString() ?? null,
        "thread_started",
        `Started ${issue.identifier}`
      )
    );

    const turnResponse = await this.sendRequest("turn/start", {
      threadId: this.currentThreadId,
      cwd: workspacePath,
      input: [{ type: "text", text: prompt }],
      sandboxPolicy: config.codex.turn_sandbox_policy
    });
    this.currentTurnId = extractId(turnResponse, ["turnId", "id"], ["turn"]);
    if (!this.currentTurnId)
      throw new SymphonyError("codex_runner_error", "turn/start did not return a turn id");
    onSession(
      createLiveSession(
        this.currentThreadId,
        this.currentTurnId,
        child.pid?.toString() ?? null,
        "turn_started",
        `Turn started for ${issue.identifier}`
      )
    );

    await Promise.race([
      this.waitForTurnCompletion(),
      delay(config.codex.turn_timeout_ms).then(() => {
        throw new SymphonyError(
          "codex_runner_error",
          `turn timed out after ${config.codex.turn_timeout_ms}ms`
        );
      })
    ]);
  }

  private spawnAppServer(config: ServiceConfig, workspacePath: string, identifier: string): void {
    const command = process.platform === "win32" ? "powershell.exe" : "bash";
    const args =
      process.platform === "win32"
        ? ["-NoProfile", "-NonInteractive", "-Command", config.codex.command]
        : ["-lc", config.codex.command];
    this.child = spawn(command, args, {
      cwd: workspacePath,
      env: sanitizedProcessEnv(),
      windowsHide: true
    });
    this.logger.info("codex_app_server_started", {
      pid: this.child.pid,
      workspace_path: workspacePath,
      issue: identifier
    });
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const child = this.requireChild();
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const timeoutMs = this.getConfig().codex.read_timeout_ms;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SymphonyError("codex_runner_error", `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return promise;
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.requireChild().stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private consumeStdout(chunk: Buffer, onSession: (session: LiveSession) => void): void {
    this.stdoutBuffer += chunk.toString("utf8");
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      this.processMessage(line, onSession);
    }
  }

  private processMessage(line: string, onSession: (session: LiveSession) => void): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emitSession("malformed", redactSecrets(line.slice(0, 1000)), null, onSession);
      return;
    }

    const id = typeof parsed.id === "number" ? parsed.id : null;
    if (id !== null && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if ("error" in parsed)
        pending.reject(new SymphonyError("codex_runner_error", JSON.stringify(parsed.error)));
      else pending.resolve(getRecord(parsed.result));
      return;
    }

    const method = typeof parsed.method === "string" ? parsed.method : "other_message";
    const params = getRecord(parsed.params);

    if (method === "item/tool/call") {
      const msgId =
        typeof parsed.id === "number" || typeof parsed.id === "string" ? parsed.id : null;
      const toolName = getToolName(params.tool);
      const args = readToolArguments(params.arguments);

      if (toolName === "linear_graphql" && msgId !== null) {
        this.handleLinearGraphQLToolCall(msgId, args, "dynamic");
      }
      return;
    }

    if (method === "clientSideToolCall") {
      const msgId =
        typeof parsed.id === "number" || typeof parsed.id === "string" ? parsed.id : null;
      const toolName = typeof params.name === "string" ? params.name : "";
      const args = readToolArguments(params.args ?? params.parameters);

      if (toolName === "linear_graphql" && msgId !== null) {
        this.handleLinearGraphQLToolCall(msgId, args, "legacy");
      }
      return;
    }

    const usage = readUsage(params) ?? readUsage(parsed);
    this.emitSession(
      method,
      redactSecrets(JSON.stringify(parsed).slice(0, 1000)),
      usage,
      onSession
    );
    if (method === "turn/completed") this.completeTurn(params);
    if (
      method === "turn/failed" ||
      method === "turn/cancelled" ||
      method === "turn_ended_with_error"
    ) {
      this.failTurn(
        new SymphonyError("codex_runner_error", `${method}: ${JSON.stringify(params)}`)
      );
    }
  }

  private waitForTurnCompletion(): Promise<void> {
    if (this.turnOutcome.kind === "completed") return Promise.resolve();
    if (this.turnOutcome.kind === "failed") return Promise.reject(this.turnOutcome.error);
    return new Promise((resolve, reject) => {
      this.turnSettled = resolve;
      this.turnFailed = reject;
    });
  }

  private completeTurn(params: Record<string, unknown>): void {
    const status = typeof params.status === "string" ? params.status : "completed";
    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      this.failTurn(
        new SymphonyError("codex_runner_error", `turn completed with status ${status}`)
      );
      return;
    }
    if (this.turnOutcome.kind === "pending") this.turnOutcome = { kind: "completed" };
    const settle = this.turnSettled;
    this.turnSettled = null;
    this.turnFailed = null;
    settle?.();
  }

  private failTurn(error: Error): void {
    if (this.turnOutcome.kind === "pending") this.turnOutcome = { kind: "failed", error };
    const fail = this.turnFailed;
    this.turnSettled = null;
    this.turnFailed = null;
    fail?.(error);
  }

  private emitSession(
    event: string,
    message: string,
    usage: Usage | null,
    onSession: (session: LiveSession) => void
  ): void {
    onSession(
      createLiveSession(
        this.currentThreadId ?? "pending",
        this.currentTurnId ?? "pending",
        this.child?.pid?.toString() ?? null,
        event,
        message,
        usage
      )
    );
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.failTurn(error);
  }

  private handleLinearGraphQLToolCall(
    msgId: number | string,
    args: Record<string, unknown>,
    protocol: "dynamic" | "legacy"
  ): void {
    const query = typeof args.query === "string" ? args.query : "";
    const variables = getRecord(args.variables || {});
    this.tracker
      .executeGraphQL(query, variables)
      .then((result) => {
        if (protocol === "dynamic") {
          this.writeJsonRpcResponse(msgId, {
            success: true,
            contentItems: [{ type: "inputText", text: JSON.stringify(result) }]
          });
          return;
        }
        this.writeJsonRpcResponse(msgId, result);
      })
      .catch((err) => {
        const errorText = redactSecrets(messageFromUnknown(err));
        if (protocol === "dynamic") {
          this.writeJsonRpcResponse(msgId, {
            success: false,
            contentItems: [{ type: "inputText", text: errorText }]
          });
          return;
        }
        this.requireChild().stdin.write(`${JSON.stringify({ id: msgId, error: errorText })}\n`);
      });
  }

  private writeJsonRpcResponse(msgId: number | string, result: unknown): void {
    this.requireChild().stdin.write(`${JSON.stringify({ id: msgId, result })}\n`);
  }

  private requireChild(): ChildProcessWithoutNullStreams {
    if (!this.child)
      throw new SymphonyError("codex_runner_error", "codex app-server is not running");
    return this.child;
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.failPending(new SymphonyError("codex_runner_error", "codex app-server stopped"));
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const exited = once(child, "exit").then(() => undefined);
    await Promise.race([exited, delay(1000).then(() => child.kill("SIGKILL"))]);
  }
}

async function ensureAllowedRunnerCwd(
  config: ServiceConfig,
  workspacePath: string,
  repositories: RepoCheckout[]
): Promise<void> {
  try {
    await ensureRealDirectoryInsideRoot(config.workspace.root, workspacePath);
    return;
  } catch (error) {
    const workspaceReal = await realDirectoryPath(workspacePath);
    for (const repo of repositories) {
      const repoReal = await realDirectoryPath(repo.path);
      if (repoReal === workspaceReal) return;
    }
    throw error;
  }
}

async function realDirectoryPath(target: string): Promise<string> {
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SymphonyError(
      "workspace_safety_error",
      `Runner cwd is not a real directory: ${target}`
    );
  }
  return realpath(target);
}

function readUsage(parsed: Record<string, unknown>): Usage | null {
  const usage = parsed.usage;
  if (typeof usage !== "object" || usage === null) return null;
  const record = usage as Record<string, unknown>;
  return {
    input_tokens: typeof record.input_tokens === "number" ? record.input_tokens : 0,
    output_tokens: typeof record.output_tokens === "number" ? record.output_tokens : 0,
    total_tokens: typeof record.total_tokens === "number" ? record.total_tokens : 0
  };
}

function extractId(
  response: Record<string, unknown>,
  directKeys: string[],
  nestedKeys: string[]
): string | null {
  for (const key of directKeys) {
    if (typeof response[key] === "string") return response[key];
  }
  for (const nestedKey of nestedKeys) {
    const nested = getRecord(response[nestedKey]);
    for (const key of directKeys) if (typeof nested[key] === "string") return nested[key];
  }
  return null;
}

function getToolName(tool: unknown): string {
  if (typeof tool === "string") return tool;
  const record = getRecord(tool);
  return typeof record.name === "string" ? record.name : "";
}

function readToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return getRecord(parsed);
    } catch {
      return {};
    }
  }
  return getRecord(value);
}

function getRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function createLiveSession(
  threadId: string,
  turnId: string,
  pid: string | null,
  event: string,
  message: string,
  usage: Usage | null = null
): LiveSession {
  return {
    session_id: `${threadId}-${turnId}`,
    thread_id: threadId,
    turn_id: turnId,
    codex_app_server_pid: pid,
    last_codex_event: event,
    last_codex_timestamp: new Date().toISOString(),
    last_codex_message: message,
    codex_input_tokens: usage?.input_tokens ?? 0,
    codex_output_tokens: usage?.output_tokens ?? 0,
    codex_total_tokens: usage?.total_tokens ?? 0,
    last_reported_input_tokens: usage?.input_tokens ?? 0,
    last_reported_output_tokens: usage?.output_tokens ?? 0,
    last_reported_total_tokens: usage?.total_tokens ?? 0,
    turn_count: 1
  };
}
