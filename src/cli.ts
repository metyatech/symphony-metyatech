#!/usr/bin/env node
try {
  process.loadEnvFile();
} catch (error) {
  void error;
  // ignore missing .env file
}

import { Command } from "commander";
import { unlinkSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDashboardApi } from "./api.js";
import { CodexRunner } from "./codex-runner.js";
import {
  removeDashboardApiDiscovery,
  startDashboardApi,
  type DashboardApiHandle
} from "./dashboard-api.js";
import { JsonLogger } from "./logger.js";
import { Orchestrator } from "./orchestrator.js";
import { LinearClient } from "./tracker.js";
import { loadServiceConfig, validateDispatchConfig } from "./workflow.js";
import { WorkspaceManager } from "./workspace.js";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8")
) as { version: string };

const program = new Command();
program
  .name("symphony")
  .description("Run a Symphony service that dispatches Linear issues to Codex app-server agents.")
  .version(packageJson.version, "-V, --version")
  .option("-w, --workflow <path>", "path to WORKFLOW.md", "WORKFLOW.md")
  .option("--check", "load and validate configuration without starting the service")
  .option("--json", "emit machine-readable check output")
  .option("--quiet", "suppress informational logs")
  .addHelpText(
    "after",
    `

Examples:
  $ symphony --workflow ./WORKFLOW.md --check
  $ LINEAR_API_KEY=lin_api_xxx symphony --workflow ./WORKFLOW.md

Command-specific help:
  $ symphony -h`
  );

program.parse();
const options = program.opts<{
  workflow: string;
  check?: boolean;
  json?: boolean;
  quiet?: boolean;
}>();
let logger = new JsonLogger(options.quiet ?? false);
let dashboardApi: DashboardApiHandle | null = null;

try {
  const loaded = await loadServiceConfig(options.workflow);
  validateDispatchConfig(loaded.config);
  if (options.check) {
    const payload = {
      ok: true,
      workflowPath: loaded.config.workflowPath,
      workspaceRoot: loaded.config.workspace.root,
      pollIntervalMs: loaded.config.polling.interval_ms
    };
    process.stdout.write(
      options.json
        ? `${JSON.stringify(payload)}\n`
        : `Symphony configuration is valid: ${payload.workflowPath}\n`
    );
    process.exit(0);
  }
  logger = new JsonLogger(options.quiet ?? false, loaded.config.logging.file);
  const orchestratorRef: { current: Orchestrator | null } = { current: null };
  const workspaceRoot = loaded.config.workspace.root;
  const pidFile = join(workspaceRoot, ".symphony.pid");

  await mkdir(workspaceRoot, { recursive: true });

  let pidFileExists = false;
  try {
    await access(pidFile);
    pidFileExists = true;
  } catch (error) {
    void error;
    // pid file does not exist yet
  }

  if (pidFileExists) {
    const existingPid = (await readFile(pidFile, "utf8")).trim();
    let isRunning = false;
    try {
      process.kill(Number(existingPid), 0);
      isRunning = true;
    } catch (error) {
      void error;
      // stale pid file from a previous crash
    }
    if (isRunning) {
      logger.error("startup_failed", {
        error: `Another instance of Symphony is already running for this workspace (PID: ${existingPid})`
      });
      await logger.flush();
      process.exit(1);
    }
  }

  await writeFile(pidFile, String(process.pid), "utf8");

  const removePidFile = (): void => {
    try {
      unlinkSync(pidFile);
    } catch (error) {
      void error;
      // ignore cleanup errors
    }
  };
  process.on("exit", removePidFile);

  const tracker = new LinearClient(() => orchestratorRef.current?.getConfig() ?? loaded.config);
  const workspaceManager = new WorkspaceManager(
    () => orchestratorRef.current?.getConfig() ?? loaded.config,
    logger
  );
  const currentOrchestrator = (): Orchestrator => {
    if (!orchestratorRef.current) throw new Error("orchestrator is not initialized");
    return orchestratorRef.current;
  };
  const orchestrator = new Orchestrator(
    loaded.config.workflowPath,
    loaded.workflow,
    loaded.config,
    tracker,
    workspaceManager,
    () =>
      new CodexRunner(
        () => currentOrchestrator().getConfig(),
        () => currentOrchestrator().getPromptTemplate(),
        logger,
        tracker
      ),
    logger
  );
  orchestratorRef.current = orchestrator;

  const stateFile = join(workspaceRoot, "orchestrator_state.json");
  await orchestrator.loadState(stateFile);

  // Auto-save state periodically
  setInterval(() => {
    orchestrator.saveState(stateFile).catch((error: unknown) => {
      void error;
    });
  }, 10000);

  if (loaded.config.server.port !== null) {
    const apiApp = createDashboardApi(orchestrator);
    dashboardApi = await startDashboardApi({
      app: apiApp,
      port: loaded.config.server.port,
      workspaceRoot,
      logger
    });
  } else {
    await removeDashboardApiDiscovery(workspaceRoot);
  }

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    logger.info("service_stopping", {});
    void orchestrator
      .stop()
      .finally(() => dashboardApi?.close())
      .then(() => orchestrator.saveState(stateFile))
      .then(() => logger.flush())
      .then(() => process.exit(0))
      .catch(async (shutdownError: unknown) => {
        logger.error("shutdown_failed", { error: messageFromUnknown(shutdownError) });
        await logger.flush();
        process.exit(1);
      });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await orchestrator.start();
} catch (error) {
  if (dashboardApi !== null) {
    try {
      await dashboardApi.close();
    } catch (cleanupError) {
      logger.warn("dashboard_api_cleanup_failed", { error: messageFromUnknown(cleanupError) });
    }
  }
  logger.error("startup_failed", { error: messageFromUnknown(error) });
  await logger.flush();
  process.exit(1);
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
