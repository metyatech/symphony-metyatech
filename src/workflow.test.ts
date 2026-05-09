import { access, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadServiceConfig,
  loadWorkflow,
  renderPrompt,
  selectRepositoriesForIssue,
  validateDispatchConfig
} from "./workflow.js";

describe("workflow loading", () => {
  it("parses optional YAML front matter and trims the prompt body", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
    const workflow = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflow,
      "---\ntracker:\n  kind: linear\n  team: DEMO\nworkspace:\n  root: work\n---\nHello {{ issue.identifier }}\n",
      "utf8"
    );

    const loaded = await loadWorkflow(workflow);

    expect(loaded.config.tracker).toEqual({ kind: "linear", team: "DEMO" });
    expect(loaded.prompt_template).toBe("Hello {{ issue.identifier }}");
  });

  it("resolves env-backed API keys and relative workspace roots", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
    const workflow = path.join(dir, "WORKFLOW.md");
    process.env.SYMPHONY_TEST_LINEAR_KEY = "lin_test";
    await writeFile(
      workflow,
      "---\ntracker:\n  kind: linear\n  api_key: $SYMPHONY_TEST_LINEAR_KEY\n  team: DEMO\nworkspace:\n  root: work\n---\n",
      "utf8"
    );

    const { config } = await loadServiceConfig(workflow);

    expect(config.tracker.api_key).toBe("lin_test");
    expect(config.workspace.root).toBe(path.resolve(dir, "work"));
    expect(() => validateDispatchConfig(config)).not.toThrow();
  });

  it("uses top-level workspaces_root relative to WORKFLOW.md when workspace.root is absent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
    const workflow = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflow,
      "---\ntracker:\n  kind: linear\n  api_key: x\n  team: DEMO\nworkspaces_root: ./workspaces\n---\n",
      "utf8"
    );

    const { config } = await loadServiceConfig(workflow);

    expect(config.workspace.root).toBe(path.resolve(dir, "workspaces"));
  });

  it("keeps workspace.root precedence over top-level workspaces_root", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
    const workflow = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflow,
      [
        "---",
        "tracker:",
        "  kind: linear",
        "  api_key: x",
        "  team: DEMO",
        "workspaces_root: ./workspaces",
        "workspace:",
        "  root: ./explicit-workspaces",
        "---"
      ].join("\n"),
      "utf8"
    );

    const { config } = await loadServiceConfig(workflow);

    expect(config.workspace.root).toBe(path.resolve(dir, "explicit-workspaces"));
  });
  it("defaults file logging under workspace.root with bounded retention", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
    const workflow = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflow,
      "---\ntracker:\n  kind: linear\n  api_key: x\n  team: DEMO\nworkspace:\n  root: ./work\n---\n",
      "utf8"
    );

    const { config } = await loadServiceConfig(workflow);

    expect(config.logging.file).toEqual({
      enabled: true,
      path: path.resolve(dir, "work", ".symphony", "logs", "symphony.log"),
      max_bytes: 10 * 1024 * 1024,
      max_files: 5
    });
  });

  it("parses file logging opt-out and retention tuning", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
    const workflow = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflow,
      [
        "---",
        "tracker:",
        "  kind: linear",
        "  api_key: x",
        "  team: DEMO",
        "workspace:",
        "  root: ./work",
        "logging:",
        "  file:",
        "    enabled: false",
        "    path: logs/custom.log",
        "    max_bytes: 2048",
        "    max_files: 7",
        "---"
      ].join("\n"),
      "utf8"
    );

    const { config } = await loadServiceConfig(workflow);

    expect(config.logging.file).toEqual({
      enabled: false,
      path: path.resolve(dir, "work", "logs", "custom.log"),
      max_bytes: 2048,
      max_files: 7
    });
  });

  it.each([
    ["max_bytes", 0, /logging\.file\.max_bytes/],
    ["max_bytes", -1, /logging\.file\.max_bytes/],
    ["max_files", 0, /logging\.file\.max_files/],
    ["max_files", -1, /logging\.file\.max_files/]
  ])("rejects invalid logging.file.%s bounds during validation", async (field, value, message) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
    const workflow = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflow,
      [
        "---",
        "tracker:",
        "  kind: linear",
        "  api_key: x",
        "  team: DEMO",
        "logging:",
        "  file:",
        `    ${field}: ${value}`,
        "---"
      ].join("\n"),
      "utf8"
    );

    const { config } = await loadServiceConfig(workflow);

    expect(() => validateDispatchConfig(config)).toThrow(message);
  });

  it("validates config without creating log directories or files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
    const workflow = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflow,
      "---\ntracker:\n  kind: linear\n  api_key: x\n  team: DEMO\nworkspace:\n  root: ./work\n---\n",
      "utf8"
    );

    const { config } = await loadServiceConfig(workflow);
    validateDispatchConfig(config);

    await expect(access(path.dirname(config.logging.file.path))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(access(config.logging.file.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("parses normalized tracker project slug and trigger label", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
    const workflow = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflow,
      "---\ntracker:\n  kind: linear\n  api_key: x\n  team: DEMO\n  project_slug: ' Demo.Project '\n  trigger_label: ' Symphony Ready '\n---\n",
      "utf8"
    );

    const { config } = await loadServiceConfig(workflow);

    expect(config.tracker.project_slug).toBe("demo.project");
    expect(config.tracker.trigger_label).toBe("symphony ready");
  });

  it("requires tracker.kind for dispatch validation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
    const workflow = path.join(dir, "WORKFLOW.md");
    await writeFile(workflow, "---\ntracker:\n  api_key: literal\n  team: DEMO\n---\n", "utf8");

    const { config } = await loadServiceConfig(workflow);

    expect(config.tracker.kind).toBeNull();
    expect(() => validateDispatchConfig(config)).toThrow(/tracker.kind/);
  });

  it("fails strict prompt rendering for unknown variables", async () => {
    await expect(renderPrompt("{{ missing.value }}", issue(), null)).rejects.toThrow(/template/i);
  });

  it("selects repositories from issue labels and defaults, deduplicating and skipping invalid names", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
    const workflow = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflow,
      [
        "---",
        "tracker:",
        "  kind: linear",
        "  api_key: x",
        "  team: DEMO",
        "repositories:",
        "  owner: metyatech",
        "  default:",
        "    - shared-config",
        "---",
        "Work on {{ issue.identifier }}."
      ].join("\n"),
      "utf8"
    );
    const { config } = await loadServiceConfig(workflow);
    const candidate = {
      ...issue(),
      labels: [
        "repo:frontend",
        "repo:backend",
        "repo:other-org/lib",
        "area:hero",
        "repo:bad name",
        "repo:frontend"
      ]
    };

    const selected = selectRepositoriesForIssue(config, candidate);

    expect(selected.map((repo) => `${repo.owner}/${repo.name}`)).toEqual([
      "metyatech/frontend",
      "metyatech/backend",
      "other-org/lib",
      "metyatech/shared-config"
    ]);
    expect(selected[0]?.url).toBe("https://github.com/metyatech/frontend.git");
  });

  it("parses local repository preference roots relative to the workflow file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
    const workflow = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflow,
      [
        "---",
        "tracker:",
        "  kind: linear",
        "  api_key: x",
        "  team: DEMO",
        "repositories:",
        "  owner: metyatech",
        "  local:",
        "    prefer_existing: true",
        "    roots:",
        "      - .",
        "      - ../shared-workspace",
        "---",
        "Work on {{ issue.identifier }}."
      ].join("\n"),
      "utf8"
    );

    const { config } = await loadServiceConfig(workflow);

    expect(config.repositories.local).toEqual({
      prefer_existing: true,
      roots: [path.resolve(dir), path.resolve(dir, "../shared-workspace")],
      isolation: "none",
      init_if_missing: false,
      init_no_verify: false,
      branch_template: "symphony/{{ issue.identifier }}",
      path_template: "{{ workspace }}/{{ repo }}",
      overrides: new Map()
    });
  });

  it("parses mwt local isolation settings and repository default-branch overrides", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
    const workflow = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflow,
      [
        "---",
        "tracker:",
        "  kind: linear",
        "  api_key: x",
        "  team: DEMO",
        "repositories:",
        "  owner: Verseday",
        "  local:",
        "    prefer_existing: true",
        "    isolation: mwt",
        "    init_if_missing: true",
        "    init_no_verify: true",
        "    branch_template: 'work/{{ issue.identifier }}'",
        "    path_template: '{{ workspace }}/repos/{{ repo }}'",
        "    overrides:",
        "      XroidVerse:",
        "        default_branch: main",
        "      Verseday/XroidVerse:",
        "        default_branch: develop",
        "---",
        "Work on {{ issue.identifier }}."
      ].join("\n"),
      "utf8"
    );

    const { config } = await loadServiceConfig(workflow);

    expect(config.repositories.local.isolation).toBe("mwt");
    expect(config.repositories.local.init_if_missing).toBe(true);
    expect(config.repositories.local.init_no_verify).toBe(true);
    expect(config.repositories.local.branch_template).toBe("work/{{ issue.identifier }}");
    expect(config.repositories.local.path_template).toBe("{{ workspace }}/repos/{{ repo }}");
    expect(config.repositories.local.overrides.get("XroidVerse")?.default_branch).toBe("main");
    expect(config.repositories.local.overrides.get("Verseday/XroidVerse")?.default_branch).toBe(
      "develop"
    );
  });

  it("rejects unsupported local repository isolation modes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-test-"));
    const workflow = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflow,
      "---\ntracker:\n  kind: linear\n  api_key: x\n  team: DEMO\nrepositories:\n  local:\n    isolation: symlink\n---\n",
      "utf8"
    );

    await expect(loadServiceConfig(workflow)).rejects.toThrow(/repositories\.local\.isolation/);
  });

  it("renders the prompt with the repos array provided to renderPrompt", async () => {
    const repos = [
      {
        name: "frontend",
        path: "/tmp/work/frontend",
        url: "https://github.com/metyatech/frontend.git",
        created_now: true
      }
    ];
    const rendered = await renderPrompt(
      "Repos: {% for r in repos %}{{ r.name }}={{ r.path }}{% endfor %}",
      issue(),
      null,
      repos
    );
    expect(rendered).toBe("Repos: frontend=/tmp/work/frontend");
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
    project_slug: null,
    blocked_by: [],
    created_at: null,
    updated_at: null
  };
}
