import { spawn } from "node:child_process";
import {
  createTaskWorktree,
  initializeRepository,
  listWorktrees,
  loadConfig
} from "@metyatech/managed-worktree-system";
import type {
  CreateTaskWorktreeOptions,
  CreateTaskWorktreeResult,
  InitializeRepositoryOptions,
  InitResult,
  WorktreeListItem
} from "@metyatech/managed-worktree-system";
import { sanitizedProcessEnv } from "./process-safety.js";

export interface MwtClient {
  loadConfig(seedRoot: string): Promise<Record<string, unknown>>;
  localBranchExists(seedRoot: string, branch: string): Promise<boolean>;
  initializeRepository(
    seedRoot: string,
    options?: InitializeRepositoryOptions
  ): Promise<InitResult>;
  createTaskWorktree(
    seedRoot: string,
    taskName: string,
    options?: CreateTaskWorktreeOptions
  ): Promise<CreateTaskWorktreeResult>;
  listWorktrees(seedRoot: string, options?: Record<string, unknown>): Promise<WorktreeListItem[]>;
}

export const defaultMwtClient: MwtClient = {
  loadConfig,
  localBranchExists,
  initializeRepository,
  createTaskWorktree,
  listWorktrees
};

function localBranchExists(seedRoot: string, branch: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["-C", seedRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      {
        cwd: seedRoot,
        env: sanitizedProcessEnv(),
        stdio: "ignore",
        windowsHide: true
      }
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(true);
      else if (code === 1) resolve(false);
      else reject(new Error(`git show-ref exited with code ${code ?? "null"}`));
    });
  });
}
