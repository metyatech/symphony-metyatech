import { access, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonLogger } from "./logger.js";
import type { LogFileConfig } from "./types.js";

describe("JsonLogger file persistence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appends the same emitted structured log lines to stderr and the configured file", async () => {
    const stderr = captureStderr();
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-logs-"));
    const logPath = path.join(dir, "nested", "symphony.log");
    const logger = new JsonLogger(false, fileConfig(logPath));

    logger.info("service_started", { answer: 42 });
    logger.warn("service_warning", {});
    await logger.flush();

    const fileContent = await readFile(logPath, "utf8");
    expect(fileContent).toBe(stderr.join(""));
    const lines = readLinesFromString(fileContent);
    expect(lines).toHaveLength(2);
    expect(parseLogLine(lines[0])).toMatchObject({
      level: "info",
      event: "service_started",
      answer: 42
    });
    expect(parseLogLine(lines[1])).toMatchObject({
      level: "warn",
      event: "service_warning"
    });
  });

  it("does not create a log file when file persistence is disabled", async () => {
    captureStderr();
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-logs-"));
    const logPath = path.join(dir, "disabled", "symphony.log");
    const logger = new JsonLogger(false, fileConfig(logPath, { enabled: false }));

    logger.warn("visible_warning", {});
    await logger.flush();

    await expect(access(logPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rotates before append and keeps only the configured retained files", async () => {
    captureStderr();
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-logs-"));
    const logPath = path.join(dir, "symphony.log");
    const logger = new JsonLogger(false, fileConfig(logPath, { max_bytes: 1, max_files: 3 }));

    logger.warn("first", {});
    logger.warn("second", {});
    logger.warn("third", {});
    logger.warn("fourth", {});
    await logger.flush();

    const files = (await readdir(dir)).filter((name) => name.startsWith("symphony.log")).sort();
    expect(files).toEqual(["symphony.log", "symphony.log.1", "symphony.log.2"]);
    expect(parseLogLine((await readLines(logPath))[0]).event).toBe("fourth");
    expect(parseLogLine((await readLines(`${logPath}.1`))[0]).event).toBe("third");
    expect(parseLogLine((await readLines(`${logPath}.2`))[0]).event).toBe("second");
  });

  it("persists only warn and error lines when quiet suppresses info", async () => {
    const stderr = captureStderr();
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-logs-"));
    const logPath = path.join(dir, "symphony.log");
    const logger = new JsonLogger(true, fileConfig(logPath));

    logger.info("hidden_info", {});
    logger.warn("visible_warning", {});
    logger.error("visible_error", {});
    await logger.flush();

    const fileLines = await readLines(logPath);
    const stderrLines = readLinesFromString(stderr.join(""));
    expect(fileLines).toHaveLength(2);
    expect(stderrLines).toHaveLength(2);
    expect(fileLines.map((line) => parseLogLine(line).event)).toEqual([
      "visible_warning",
      "visible_error"
    ]);
    expect(fileLines).toEqual(stderrLines);
  });

  it("warns once on file persistence failure without suppressing stderr JSON logs", async () => {
    const stderr = captureStderr();
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-logs-"));
    const blocker = path.join(dir, "not-a-directory");
    await writeFile(blocker, "block", "utf8");
    const logger = new JsonLogger(false, fileConfig(path.join(blocker, "symphony.log")));

    logger.warn("first_warning", {});
    logger.error("second_warning", {});
    await logger.flush();

    const entries = readLinesFromString(stderr.join("")).map(parseLogLine);
    expect(entries.map((entry) => entry.event)).toEqual([
      "first_warning",
      "second_warning",
      "log_file_persistence_failed"
    ]);
    const persistenceWarnings = entries.filter(
      (entry) => entry.event === "log_file_persistence_failed"
    );
    expect(persistenceWarnings).toHaveLength(1);
    expect(persistenceWarnings[0]).toMatchObject({
      level: "warn",
      error: "Unable to persist Symphony log file"
    });
  });
});

function fileConfig(logPath: string, overrides: Partial<LogFileConfig> = {}): LogFileConfig {
  return {
    enabled: overrides.enabled ?? true,
    path: logPath,
    max_bytes: overrides.max_bytes ?? 1024 * 1024,
    max_files: overrides.max_files ?? 3
  };
}

function captureStderr(): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return writes;
}

async function readLines(filePath: string): Promise<string[]> {
  return readLinesFromString(await readFile(filePath, "utf8"));
}

function readLinesFromString(content: string): string[] {
  const trimmed = content.trimEnd();
  return trimmed === "" ? [] : trimmed.split("\n");
}

function parseLogLine(line: string | undefined): Record<string, unknown> {
  if (line === undefined) throw new Error("Expected a log line");
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) throw new Error("Expected a JSON log object");
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
