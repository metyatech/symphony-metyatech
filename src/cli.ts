#!/usr/bin/env node
try {
  process.loadEnvFile();
} catch (error) {
  // ignore missing .env file
}

import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { CodexRunner } from "./codex-runner.js";
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
const logger = new JsonLogger(options.quiet ?? false);

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
  const orchestratorRef: { current: Orchestrator | null } = { current: null };
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
        logger
      ),
    logger
  );
  orchestratorRef.current = orchestrator;
  const stop = () => void orchestrator.stop().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await orchestrator.start();
} catch (error) {
  logger.error("startup_failed", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
