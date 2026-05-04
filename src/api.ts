import express from "express";
import { Orchestrator } from "./orchestrator.js";

export function createDashboardApi(orchestrator: Orchestrator) {
  const app = express();
  app.use(express.json());

  app.get("/status", (req, res) => {
    res.json({
      status: "ok",
      version: "0.1.0"
    });
  });

  app.get("/state", (req, res) => {
    res.json({
      running: Array.from(orchestrator.state.running.keys()),
      claimed: Array.from(orchestrator.state.claimed),
      completed: Array.from(orchestrator.state.completed),
      retry_attempts: Array.from(orchestrator.state.retry_attempts.keys()),
      codex_totals: orchestrator.state.codex_totals
    });
  });

  const stopHandler = (req: express.Request, res: express.Response) => {
    void orchestrator.stop().then(() => {
      res.json({ status: "stopped" });
    });
  };

  const startHandler = (req: express.Request, res: express.Response) => {
    void orchestrator.start().then(() => {
      res.json({ status: "started" });
    });
  };

  app.post("/stop", stopHandler);
  app.post("/start", startHandler);
  app.post("/control/stop", stopHandler);
  app.post("/control/start", startHandler);

  return app;
}
