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

export interface MwtClient {
  loadConfig(seedRoot: string): Promise<Record<string, unknown>>;
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
  initializeRepository,
  createTaskWorktree,
  listWorktrees
};
