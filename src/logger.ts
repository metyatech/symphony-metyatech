import type { Logger } from "./types.js";

export class JsonLogger implements Logger {
  constructor(private readonly quiet = false) {}

  info(event: string, fields: Record<string, unknown> = {}): void {
    if (!this.quiet) this.write("info", event, fields);
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.write("error", event, fields);
  }

  private write(level: string, event: string, fields: Record<string, unknown>): void {
    process.stderr.write(
      `${JSON.stringify({ level, event, timestamp: new Date().toISOString(), ...fields })}\n`
    );
  }
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
