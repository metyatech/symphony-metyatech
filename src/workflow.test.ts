import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadServiceConfig,
  loadWorkflow,
  renderPrompt,
  validateDispatchConfig
} from "./workflow.js";

describe("workflow loading", () => {
  it("parses optional YAML front matter and trims the prompt body", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
    const workflow = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflow,
      "---\ntracker:\n  kind: linear\n  project_slug: DEMO\nworkspace:\n  root: work\n---\nHello {{ issue.identifier }}\n",
      "utf8"
    );

    const loaded = await loadWorkflow(workflow);

    expect(loaded.config.tracker).toEqual({ kind: "linear", project_slug: "DEMO" });
    expect(loaded.prompt_template).toBe("Hello {{ issue.identifier }}");
  });

  it("resolves env-backed API keys and relative workspace roots", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
    const workflow = path.join(dir, "WORKFLOW.md");
    process.env.SYMPHONY_TEST_LINEAR_KEY = "lin_test";
    await writeFile(
      workflow,
      "---\ntracker:\n  kind: linear\n  api_key: $SYMPHONY_TEST_LINEAR_KEY\n  project_slug: DEMO\nworkspace:\n  root: work\n---\n",
      "utf8"
    );

    const { config } = await loadServiceConfig(workflow);

    expect(config.tracker.api_key).toBe("lin_test");
    expect(config.workspace.root).toBe(path.resolve(dir, "work"));
    expect(() => validateDispatchConfig(config)).not.toThrow();
  });

  it("requires tracker.kind for dispatch validation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
    const workflow = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflow,
      "---\ntracker:\n  api_key: literal\n  project_slug: DEMO\n---\n",
      "utf8"
    );

    const { config } = await loadServiceConfig(workflow);

    expect(config.tracker.kind).toBeNull();
    expect(() => validateDispatchConfig(config)).toThrow(/tracker.kind/);
  });

  it("fails strict prompt rendering for unknown variables", async () => {
    await expect(renderPrompt("{{ missing.value }}", issue(), null)).rejects.toThrow(/template/i);
  });
});

function issue() {
  return {
    id: "1",
    identifier: "ABC-1",
    title: "Title",
    description: null,
    priority: null,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null
  };
}
