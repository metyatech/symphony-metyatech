import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { LogFileConfig, Logger } from "./types.js";

export class JsonLogger implements Logger {
  private fileQueue: Promise<void> = Promise.resolve();
  private fileWarningEmitted = false;

  constructor(
    private readonly quiet = false,
    private readonly fileConfig: LogFileConfig | null = null
  ) {}

  info(event: string, fields: Record<string, unknown> = {}): void {
    if (!this.quiet) this.write("info", event, fields);
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.write("error", event, fields);
  }

  async flush(): Promise<void> {
    await this.fileQueue;
  }

  private write(level: string, event: string, fields: Record<string, unknown>): void {
    const line = `${JSON.stringify({ level, event, timestamp: new Date().toISOString(), ...fields })}\n`;
    process.stderr.write(line);
    this.persistEmittedLine(line);
  }

  private persistEmittedLine(line: string): void {
    if (this.fileConfig?.enabled !== true) return;
    const config = this.fileConfig;
    this.fileQueue = this.fileQueue
      .then(() => appendBoundedLogLine(config, line))
      .catch((error: unknown) => {
        this.emitPersistenceWarning(error);
      });
  }

  private emitPersistenceWarning(error: unknown): void {
    if (this.fileWarningEmitted) return;
    this.fileWarningEmitted = true;
    const warning = {
      level: "warn",
      event: "log_file_persistence_failed",
      timestamp: new Date().toISOString(),
      error: "Unable to persist Symphony log file",
      error_code: safeErrorCode(error)
    };
    try {
      process.stderr.write(`${JSON.stringify(warning)}\n`);
    } catch (writeError) {
      void writeError;
    }
  }
}

async function appendBoundedLogLine(config: LogFileConfig, line: string): Promise<void> {
  await mkdir(dirname(config.path), { recursive: true });
  await rotateBeforeAppend(config, Buffer.byteLength(line, "utf8"));
  await appendFile(config.path, line, "utf8");
}

async function rotateBeforeAppend(config: LogFileConfig, incomingBytes: number): Promise<void> {
  let currentBytes = 0;
  try {
    const active = await stat(config.path);
    currentBytes = active.size;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (currentBytes === 0 || currentBytes + incomingBytes <= config.max_bytes) return;
  await rotateLogFiles(config.path, config.max_files);
}

async function rotateLogFiles(activePath: string, maxFiles: number): Promise<void> {
  if (maxFiles <= 1) {
    await rm(activePath, { force: true });
    return;
  }
  const lastRetainedIndex = maxFiles - 1;
  await rm(rotatedPath(activePath, lastRetainedIndex), { force: true });
  for (let index = lastRetainedIndex - 1; index >= 1; index -= 1) {
    await moveIfPresent(rotatedPath(activePath, index), rotatedPath(activePath, index + 1));
  }
  await moveIfPresent(activePath, rotatedPath(activePath, 1));
}

async function moveIfPresent(source: string, target: string): Promise<void> {
  await rm(target, { force: true });
  try {
    await rename(source, target);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) return;
    throw error;
  }
}

function rotatedPath(activePath: string, index: number): string {
  return `${activePath}.${index}`;
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  if (!(error instanceof Error)) return false;
  return (error as Error & { code?: unknown }).code === code;
}

function safeErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : undefined;
}

export class MemoryLogger implements Logger {
  readonly entries: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.entries.push({ level: "info", event, fields });
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.entries.push({ level: "warn", event, fields });
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.entries.push({ level: "error", event, fields });
  }
}
