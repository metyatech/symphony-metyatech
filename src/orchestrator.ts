import { watch, type FSWatcher } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { messageFromUnknown } from "./errors.js";
import {
  isActiveIssue,
  isTerminalIssue,
  passesBlockerRule,
  sortCandidates,
  type IssueTrackerClient
} from "./tracker.js";
import { loadServiceConfig, normalizeState, validateDispatchConfig } from "./workflow.js";
import type { AgentRunner } from "./codex-runner.js";
import type {
  Issue,
  Logger,
  OrchestratorState,
  RetryEntry,
  RunResult,
  ServiceConfig,
  WorkflowDefinition
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

export type RunnerFactory = () => AgentRunner;

export class Orchestrator {
  readonly state: OrchestratorState;
  private tickTimer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private runningLoop = false;

  constructor(
    private workflowPath: string,
    private workflow: WorkflowDefinition,
    private config: ServiceConfig,
    private readonly tracker: IssueTrackerClient,
    private readonly workspaceManager: WorkspaceManager,
    private readonly runnerFactory: RunnerFactory,
    private readonly logger: Logger
  ) {
    this.state = {
      poll_interval_ms: config.polling.interval_ms,
      max_concurrent_agents: config.agent.max_concurrent_agents,
      running: new Map(),
      claimed: new Set(),
      retry_attempts: new Map(),
      completed: new Set(),
      codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, runtime_ms: 0 },
      codex_rate_limits: null
    };
  }

  getConfig(): ServiceConfig {
    return this.config;
  }

  async saveState(filePath: string): Promise<void> {
    try {
      const stateObj = {
        claimed: Array.from(this.state.claimed),
        completed: Array.from(this.state.completed),
        retry_attempts: Array.from(this.state.retry_attempts.entries()).map(([id, entry]) => [
          id,
          { ...entry, timer_handle: null }
        ]),
        codex_totals: this.state.codex_totals,
        codex_rate_limits: this.state.codex_rate_limits
      };
      await writeFile(filePath, JSON.stringify(stateObj, null, 2), "utf8");
    } catch (error) {
      this.logger.error("save_state_failed", { error: messageFromUnknown(error) });
    }
  }

  async loadState(filePath: string): Promise<void> {
    try {
      const content = await readFile(filePath, "utf8");
      const stateObj = JSON.parse(content) as {
        claimed?: string[];
        completed?: string[];
        retry_attempts?: Array<[string, RetryEntry]>;
        codex_totals?: OrchestratorState["codex_totals"];
        codex_rate_limits?: unknown;
      };

      if (Array.isArray(stateObj.claimed)) {
        this.state.claimed = new Set(stateObj.claimed);
      }
      if (Array.isArray(stateObj.completed)) {
        this.state.completed = new Set(stateObj.completed);
      }
      if (Array.isArray(stateObj.retry_attempts)) {
        this.state.retry_attempts = new Map();
        for (const [id, entry] of stateObj.retry_attempts) {
          const delayMs = Math.max(0, entry.due_at_ms - Date.now());
          const newEntry: RetryEntry = {
            ...entry,
            timer_handle: setTimeout(() => void this.retry(id), delayMs)
          };
          this.state.retry_attempts.set(id, newEntry);
        }
      }
      if (stateObj.codex_totals) {
        this.state.codex_totals = stateObj.codex_totals;
      }
      if (stateObj.codex_rate_limits !== undefined) {
        this.state.codex_rate_limits = stateObj.codex_rate_limits;
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        this.logger.error("load_state_failed", { error: messageFromUnknown(error) });
      }
    }
  }

  getPromptTemplate(): string {
    return this.workflow.prompt_template;
  }

  async start(): Promise<void> {
    validateDispatchConfig(this.config);
    await this.startupCleanup();
    this.watchWorkflow();
    await this.tick();
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = null;
    this.watcher?.close();
    this.watcher = null;
    for (const running of this.state.running.values())
      await running.worker.cancel("service stopping");
    for (const retry of this.state.retry_attempts.values())
      if (retry.timer_handle) clearTimeout(retry.timer_handle);
  }

  async tick(): Promise<void> {
    if (this.runningLoop) return;
    this.runningLoop = true;
    try {
      const reloaded = await this.reloadWorkflow(false);
      await this.reconcileRunning();
      if (!reloaded) {
        this.logger.error("dispatch_preflight_failed", { error: "workflow reload failed" });
        return;
      }
      try {
        validateDispatchConfig(this.config);
      } catch (error) {
        this.logger.error("dispatch_preflight_failed", { error: messageFromUnknown(error) });
        return;
      }
      const candidates = sortCandidates(await this.tracker.fetchCandidateIssues());
      for (const issue of candidates) {
        if (this.availableSlots() <= 0) break;
        if (this.isEligible(issue)) this.dispatch(issue, null);
      }
    } finally {
      this.runningLoop = false;
      this.scheduleNextTick();
    }
  }

  private dispatch(issue: Issue, attempt: number | null): void {
    this.state.claimed.add(issue.id);
    const runner = this.runnerFactory();
    const started = Date.now();
    const runningEntry = {
      issue,
      started_at_ms: started,
      worker: runner,
      live_session: null,
      workspace_path: ""
    };
    this.state.running.set(issue.id, runningEntry);
    void this.runWorker(issue, attempt, runner).then(
      (result) => this.handleWorkerExit(issue, result, attempt),
      (error) =>
        this.handleWorkerExit(
          issue,
          {
            status: "failed",
            error: messageFromUnknown(error),
            runtime_ms: Date.now() - started
          },
          attempt
        )
    );
  }

  private async runWorker(
    issue: Issue,
    attempt: number | null,
    runner: AgentRunner
  ): Promise<RunResult> {
    const workspace = await this.workspaceManager.ensureWorkspace(issue);
    const running = this.state.running.get(issue.id);
    if (running) running.workspace_path = workspace.path;
    let currentIssue = issue;
    let lastResult: RunResult = { status: "succeeded", error: null, runtime_ms: 0 };
    for (let turn = 0; turn < this.config.agent.max_turns; turn += 1) {
      await this.workspaceManager.beforeRun(currentIssue, workspace);
      try {
        lastResult = await runner.run(
          currentIssue,
          workspace.path,
          turn === 0 ? attempt : turn,
          (session) => {
            const current = this.state.running.get(issue.id);
            if (current) current.live_session = session;
            this.state.codex_totals.input_tokens += session.last_reported_input_tokens;
            this.state.codex_totals.output_tokens += session.last_reported_output_tokens;
            this.state.codex_totals.total_tokens += session.last_reported_total_tokens;
          },
          workspace.repositories
        );
      } finally {
        await this.workspaceManager.afterRun(currentIssue, workspace);
      }
      if (lastResult.status !== "succeeded") return lastResult;
      const refreshed = await this.tracker.fetchIssueStates([issue.id]);
      const nextIssue = refreshed.find((candidate) => candidate.id === issue.id);
      if (!nextIssue || !isActiveIssue(nextIssue, this.config)) return lastResult;
      currentIssue = nextIssue;
      const runningNow = this.state.running.get(issue.id);
      if (runningNow) runningNow.issue = nextIssue;
    }
    return lastResult;
  }

  private handleWorkerExit(issue: Issue, result: RunResult, attempt: number | null): void {
    this.state.running.delete(issue.id);
    this.state.codex_totals.runtime_ms += result.runtime_ms;
    if (result.status === "succeeded") {
      this.state.completed.add(issue.id);
      this.scheduleRetry(issue, 1, 1000, "continuation check");
    } else if (result.status !== "canceled") {
      const nextAttempt = (attempt ?? 0) + 1;
      const delay = Math.min(
        10000 * 2 ** (nextAttempt - 1),
        this.config.agent.max_retry_backoff_ms
      );
      this.scheduleRetry(issue, nextAttempt, delay, result.error);
    } else {
      if (!this.state.retry_attempts.has(issue.id)) this.release(issue.id);
    }
    this.logger.info("worker_exit", {
      issue: issue.identifier,
      status: result.status,
      error: result.error
    });
  }

  private scheduleRetry(
    issue: Issue,
    attempt: number,
    delayMs: number,
    error: string | null
  ): void {
    if (attempt > this.config.agent.max_turns) {
      this.logger.error("max_retries_exceeded", { issue: issue.identifier, attempt });
      this.release(issue.id);
      return;
    }
    const existing = this.state.retry_attempts.get(issue.id);
    if (existing?.timer_handle) clearTimeout(existing.timer_handle);
    const entry: RetryEntry = {
      issue_id: issue.id,
      identifier: issue.identifier,
      attempt,
      due_at_ms: Date.now() + delayMs,
      timer_handle: null,
      error
    };
    entry.timer_handle = setTimeout(() => void this.retry(issue.id), delayMs);
    this.state.retry_attempts.set(issue.id, entry);
    this.state.claimed.add(issue.id);
    this.logger.info("retry_scheduled", {
      issue: issue.identifier,
      attempt,
      delay_ms: delayMs,
      error
    });
  }

  private async retry(issueId: string): Promise<void> {
    const entry = this.state.retry_attempts.get(issueId);
    if (!entry) return;
    this.state.retry_attempts.delete(issueId);
    const issue = (await this.tracker.fetchCandidateIssues()).find(
      (candidate) => candidate.id === issueId
    );
    if (!issue || !this.isEligible(issue, true)) {
      this.release(issueId);
      return;
    }
    if (this.availableSlots() <= 0) {
      this.scheduleRetry(
        issue,
        entry.attempt + 1,
        Math.min(10000 * 2 ** entry.attempt, this.config.agent.max_retry_backoff_ms),
        "no available orchestrator slots"
      );
      return;
    }
    this.dispatch(issue, entry.attempt);
  }

  private async reconcileRunning(): Promise<void> {
    await this.detectStalls();
    const runningIds = [...this.state.running.keys()];
    if (runningIds.length === 0) return;
    let refreshed: Issue[];
    try {
      refreshed = await this.tracker.fetchIssueStates(runningIds);
    } catch (error) {
      this.logger.warn("reconciliation_refresh_failed", { error: messageFromUnknown(error) });
      return;
    }
    const byId = new Map(refreshed.map((issue) => [issue.id, issue]));
    for (const [issueId, running] of this.state.running.entries()) {
      const issue = byId.get(issueId);
      if (!issue) continue;
      if (isTerminalIssue(issue, this.config)) {
        await running.worker.cancel("issue terminal");
        await this.workspaceManager.removeWorkspace(issue);
        this.release(issueId);
      } else if (isActiveIssue(issue, this.config)) {
        running.issue = issue;
      } else {
        await running.worker.cancel("issue no longer active");
        this.release(issueId);
      }
    }
  }

  private async detectStalls(): Promise<void> {
    if (this.config.codex.stall_timeout_ms <= 0) return;
    for (const [issueId, running] of this.state.running.entries()) {
      const base = running.live_session?.last_codex_timestamp
        ? Date.parse(running.live_session.last_codex_timestamp)
        : running.started_at_ms;
      if (Date.now() - base > this.config.codex.stall_timeout_ms) {
        await running.worker.cancel("stalled");
        this.state.running.delete(issueId);
        
        const existingAttempt = this.state.retry_attempts.get(issueId)?.attempt ?? 0;
        const nextAttempt = existingAttempt + 1;
        const delay = Math.min(10000 * 2 ** (nextAttempt - 1), this.config.agent.max_retry_backoff_ms);
        
        this.scheduleRetry(running.issue, nextAttempt, delay, "stalled");
      }
    }
  }

  private async startupCleanup(): Promise<void> {
    try {
      const terminalIssues = await this.tracker.fetchTerminalIssues();
      for (const issue of terminalIssues) await this.workspaceManager.removeWorkspace(issue);
    } catch (error) {
      this.logger.warn("startup_cleanup_failed", { error: messageFromUnknown(error) });
    }
  }

  private isEligible(issue: Issue, allowRetryClaim = false): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    if (!isActiveIssue(issue, this.config)) return false;
    if (this.state.running.has(issue.id)) return false;
    if (this.state.claimed.has(issue.id) && !allowRetryClaim) return false;
    if (!passesBlockerRule(issue, this.config)) return false;
    const stateLimit =
      this.config.agent.max_concurrent_agents_by_state.get(normalizeState(issue.state)) ??
      this.config.agent.max_concurrent_agents;
    const runningInState = [...this.state.running.values()].filter(
      (entry) => normalizeState(entry.issue.state) === normalizeState(issue.state)
    ).length;
    return this.availableSlots() > 0 && runningInState < stateLimit;
  }

  private availableSlots(): number {
    return Math.max(this.config.agent.max_concurrent_agents - this.state.running.size, 0);
  }

  private release(issueId: string): void {
    this.state.claimed.delete(issueId);
    this.state.retry_attempts.delete(issueId);
    this.state.running.delete(issueId);
  }

  private watchWorkflow(): void {
    try {
      this.watcher = watch(this.workflowPath, () => void this.reloadWorkflow(true));
    } catch (error) {
      this.logger.warn("workflow_watch_failed", { error: messageFromUnknown(error) });
    }
  }

  private async reloadWorkflow(logInvalid: boolean): Promise<boolean> {
    try {
      const loaded = await loadServiceConfig(this.workflowPath);
      this.workflow = loaded.workflow;
      this.config = loaded.config;
      this.state.poll_interval_ms = this.config.polling.interval_ms;
      this.state.max_concurrent_agents = this.config.agent.max_concurrent_agents;
      return true;
    } catch (error) {
      if (logInvalid)
        this.logger.error("workflow_reload_failed", { error: messageFromUnknown(error) });
      return false;
    }
  }

  private scheduleNextTick(): void {
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => void this.tick(), this.state.poll_interval_ms);
  }
}
