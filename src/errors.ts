export type SymphonyErrorCode =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map"
  | "template_parse_error"
  | "template_render_error"
  | "config_validation_error"
  | "workspace_safety_error"
  | "mwt_branch_reuse_conflict"
  | "mwt_config_missing"
  | "mwt_template_error"
  | "mwt_worktree_branch_mismatch"
  | "mwt_worktree_path_mismatch"
  | "mwt_worktree_path_occupied"
  | "hook_failed"
  | "tracker_error"
  | "codex_runner_error"
  | "repositories_selection_empty";

export class SymphonyError extends Error {
  constructor(
    readonly code: SymphonyErrorCode,
    message: string,
    readonly causeValue?: unknown
  ) {
    super(message);
    this.name = "SymphonyError";
  }
}

export function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
