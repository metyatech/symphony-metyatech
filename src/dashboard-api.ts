import { mkdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Application } from "express";
import { SymphonyError } from "./errors.js";
import type { DashboardApiPort, Logger } from "./types.js";

type ActiveDashboardApiPort = Exclude<DashboardApiPort, null>;
const DASHBOARD_API_HOST = "127.0.0.1";

export interface DashboardApiHandle {
  server: Server;
  port: number;
  url: string;
  discoveryPath: string;
  close(): Promise<void>;
}

export interface StartDashboardApiOptions {
  app: Application;
  port: ActiveDashboardApiPort;
  workspaceRoot: string;
  logger: Logger;
  pid?: number;
  now?: () => Date;
}

export function dashboardApiDiscoveryPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".symphony", "dashboard-api.json");
}

export async function removeDashboardApiDiscovery(workspaceRoot: string): Promise<void> {
  await rm(dashboardApiDiscoveryPath(workspaceRoot), { force: true });
}

export async function startDashboardApi(
  options: StartDashboardApiOptions
): Promise<DashboardApiHandle> {
  const discoveryPath = dashboardApiDiscoveryPath(options.workspaceRoot);
  await removeDashboardApiDiscovery(options.workspaceRoot);

  const server = await listen(options.app, options.port === "auto" ? 0 : options.port);
  try {
    const port = boundTcpPort(server);
    const url = `http://localhost:${port}`;
    const metadata = {
      pid: options.pid ?? process.pid,
      port,
      url,
      started_at: (options.now ?? (() => new Date()))().toISOString()
    };
    await mkdir(path.dirname(discoveryPath), { recursive: true });
    await writeFile(discoveryPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    options.logger.info("dashboard_api_started", { port, url });
    return {
      server,
      port,
      url,
      discoveryPath,
      close: async () => {
        await closeDashboardServer(server, options.workspaceRoot);
      }
    };
  } catch (error) {
    await closeDashboardServer(server, options.workspaceRoot);
    throw error;
  }
}

function listen(app: Application, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, DASHBOARD_API_HOST);
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

function boundTcpPort(server: Server): number {
  const address = server.address();
  if (isAddressInfo(address) && Number.isInteger(address.port) && address.port > 0) {
    return address.port;
  }
  throw new SymphonyError("dashboard_api_start_failed", "Dashboard API did not bind to a TCP port");
}

function isAddressInfo(address: AddressInfo | string | null): address is AddressInfo {
  return typeof address === "object" && address !== null;
}

async function closeDashboardServer(server: Server, workspaceRoot: string): Promise<void> {
  try {
    await closeServer(server);
  } finally {
    await removeDashboardApiDiscovery(workspaceRoot);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
