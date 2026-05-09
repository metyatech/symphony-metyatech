import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it } from "vitest";
import {
  dashboardApiDiscoveryPath,
  removeDashboardApiDiscovery,
  startDashboardApi
} from "./dashboard-api.js";
import { MemoryLogger } from "./logger.js";

describe("dashboard API startup", () => {
  it("binds auto mode to an actual port, logs the URL, and writes discovery metadata", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-dashboard-"));
    const logger = new MemoryLogger();
    const app = express();
    const startedAt = new Date("2026-01-02T03:04:05.000Z");

    const handle = await startDashboardApi({
      app,
      port: "auto",
      workspaceRoot,
      logger,
      pid: 12345,
      now: () => startedAt
    });

    try {
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.url).toBe(`http://localhost:${handle.port}`);
      expect(handle.discoveryPath).toBe(dashboardApiDiscoveryPath(workspaceRoot));
      expect(boundAddress(handle)).toBe("127.0.0.1");
      expect(logger.entries).toContainEqual({
        level: "info",
        event: "dashboard_api_started",
        fields: { port: handle.port, url: handle.url }
      });

      const metadata: unknown = JSON.parse(await readFile(handle.discoveryPath, "utf8"));
      expect(metadata).toEqual({
        pid: 12345,
        port: handle.port,
        url: handle.url,
        started_at: startedAt.toISOString()
      });
    } finally {
      await handle.close();
    }
  });

  it("binds an explicit fixed port and reports the same URL and discovery metadata", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-dashboard-"));
    const logger = new MemoryLogger();
    const app = express();
    const fixedPort = await reserveAvailableTcpPort();

    const handle = await startDashboardApi({ app, port: fixedPort, workspaceRoot, logger });

    try {
      expect(handle.port).toBe(fixedPort);
      expect(handle.url).toBe(`http://localhost:${fixedPort}`);
      expect(boundAddress(handle)).toBe("127.0.0.1");
      const metadata: unknown = JSON.parse(await readFile(handle.discoveryPath, "utf8"));
      expect(metadata).toMatchObject({ port: fixedPort, url: handle.url });
    } finally {
      await handle.close();
    }
  });

  it("removes discovery metadata on normal shutdown", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-dashboard-"));
    const logger = new MemoryLogger();
    const app = express();

    const handle = await startDashboardApi({ app, port: "auto", workspaceRoot, logger });
    await handle.close();

    await expect(access(handle.discoveryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes stale discovery metadata when the dashboard API is disabled", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-dashboard-"));
    const discoveryPath = dashboardApiDiscoveryPath(workspaceRoot);
    await mkdir(path.dirname(discoveryPath), { recursive: true });
    await writeFile(discoveryPath, "{}\n", "utf8");

    await removeDashboardApiDiscovery(workspaceRoot);

    await expect(access(discoveryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function boundAddress(handle: {
  server: { address(): AddressInfo | string | null };
}): string | null {
  const address = handle.server.address();
  return typeof address === "object" && address !== null ? address.address : null;
}

function reserveAvailableTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close(() => reject(new Error("Unable to reserve a TCP port")));
        return;
      }
      const port = address.port;
      server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}
