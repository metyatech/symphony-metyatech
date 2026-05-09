import http from "http";
import { spawn } from "child_process";

function request(baseUrl, path, method = "GET") {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode, data }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function runTest() {
  console.log("Starting symphony server...");
  const child = spawn("node", ["dist/cli.js", "--workflow", "../WORKFLOW.md"], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  // Make sure to kill child on exit
  process.on("exit", () => child.kill());
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  console.log("Waiting for dashboard URL...");
  try {
    const dashboardUrl = await waitForDashboardUrl(child);
    console.log("Dashboard URL:", dashboardUrl);

    const status = await request(dashboardUrl, "/status");
    console.log("/status:", status);

    const state = await request(dashboardUrl, "/state");
    console.log("/state:", state);

    const stopResponse = await request(dashboardUrl, "/stop", "POST");
    console.log("/stop:", stopResponse);

    console.log("Success!");
    child.kill();
    process.exit(0);
  } catch (err) {
    console.error("Test failed:", err);
    child.kill();
    process.exit(1);
  }
}

function waitForDashboardUrl(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for dashboard_api_started"));
    }, 30000);

    const onData = (chunk) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === "dashboard_api_started" && typeof event.url === "string") {
            cleanup();
            resolve(event.url);
          }
        } catch {
          // Ignore non-JSON output from child processes.
        }
      }
    };

    const onExit = (code) => {
      cleanup();
      reject(new Error(`Symphony exited before dashboard startup: ${code ?? "unknown"}`));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

runTest();
