# Symphony

Symphony is a TypeScript implementation of the draft OpenAI Symphony service specification. It runs as a long-lived CLI service that polls Linear, creates one workspace per issue, and launches a Codex app-server worker in that issue workspace.

## Supported Environment

- Node.js 22 or newer
- npm 11 or newer
- A Linear API key
- A `codex app-server` executable compatible with the targeted Codex app-server protocol

## Install and Build

```sh
npm install
npm run build
```

## Usage

Create a repository-owned `WORKFLOW.md`:

```md
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: DEMO
workspace:
  root: ./.symphony-workspaces
codex:
  command: codex app-server
---

Work on {{ issue.identifier }}: {{ issue.title }}.
```

Validate configuration without starting the daemon:

```sh
LINEAR_API_KEY=lin_api_xxx symphony --workflow ./WORKFLOW.md --check
```

Start the service:

```sh
LINEAR_API_KEY=lin_api_xxx symphony --workflow ./WORKFLOW.md
```

Machine-readable validation output:

```sh
LINEAR_API_KEY=lin_api_xxx symphony --workflow ./WORKFLOW.md --check --json
```

## Configuration

`WORKFLOW.md` supports optional YAML front matter and a strict Liquid-compatible prompt body. Unknown template variables and filters fail the affected run attempt. Relative `workspace.root` values resolve relative to the workflow file directory, and `$VAR_NAME` indirection is resolved only where the spec allows it.

Required dispatch fields are `tracker.kind`, `tracker.api_key`, `tracker.project_slug`, and `codex.command`. Defaults follow the upstream Symphony specification for polling interval, active and terminal states, hook timeout, concurrency, retry backoff, and Codex timeouts.

## Multi-Repository Workspaces

A single workflow can drive work that spans many repositories. Configure a
`repositories:` block in `WORKFLOW.md` and Symphony clones the right repos
into each issue workspace before the agent starts.

```yaml
repositories:
  owner: metyatech # default GitHub owner for repo:<name> labels
  base_url: https://github.com # default
  protocol: https # https or ssh
  label_prefix: "repo:" # how repos are picked from issue labels
  default: [] # repos to always clone, e.g. ["shared-config"]
  required: false # set true to fail when no repos are selected
```

Repositories are selected from issue labels matching `label_prefix` and from
`repositories.default`. A label of `repo:frontend` resolves to
`metyatech/frontend`; a label of `repo:other-org/lib` overrides the owner.
Selected repos are cloned into `<workspace>/<name>/` on first run and reused
unchanged on subsequent runs so the agent's branches and uncommitted edits
survive across continuation turns.

The Liquid prompt template receives a `repos` array alongside `issue` and
`attempt`, so a single template can address every selected repo:

```md
You are working on {{ issue.identifier }}.

Available repositories:
{% for repo in repos %}- {{ repo.name }} at {{ repo.path }}
{% endfor %}
```

Hooks receive the same information through `SYMPHONY_REPOS` (a comma-separated
list of selected repo names) and per-repo env slots
`SYMPHONY_REPO_<NAME>_PATH`, `SYMPHONY_REPO_<NAME>_URL`,
`SYMPHONY_REPO_<NAME>_NAME`, `SYMPHONY_REPO_<NAME>_CREATED_NOW`. The slot is
the repo name uppercased with non-alphanumeric characters replaced by `_`
(e.g. `shared-lib` becomes `SYMPHONY_REPO_SHARED_LIB_PATH`).

When no `repositories:` block is present, Symphony stays in single-repo
(legacy) mode: nothing is cloned automatically, `repos` is an empty array,
and hook scripts are responsible for any workspace population.

## Workspace Hooks

Symphony creates and reuses per-issue directories under `workspace.root` but does not clone or reset repositories by itself. Each hook (`after_create`, `before_run`, `after_run`, `before_remove`) is a shell snippet executed with the issue workspace as the current working directory. The same script is invoked on Windows via `powershell.exe -NoProfile -Command` and on POSIX via `sh -lc`.

The following environment variables are exported to every hook so that a single workflow can target many repositories without parsing the workspace directory name:

| Variable                         | Description                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `SYMPHONY_HOOK_NAME`             | One of `after_create`, `before_run`, `after_run`, `before_remove`.           |
| `SYMPHONY_WORKFLOW_DIR`          | Absolute directory containing `WORKFLOW.md`.                                 |
| `SYMPHONY_WORKSPACE_ROOT`        | Absolute path of the configured `workspace.root`.                            |
| `SYMPHONY_WORKSPACE_PATH`        | Absolute path of the issue workspace (also the hook `cwd`).                  |
| `SYMPHONY_WORKSPACE_KEY`         | Sanitized directory name derived from the issue identifier.                  |
| `SYMPHONY_WORKSPACE_CREATED_NOW` | `true` when this hook run accompanies workspace creation, `false` otherwise. |
| `SYMPHONY_ISSUE_ID`              | Tracker-internal issue id.                                                   |
| `SYMPHONY_ISSUE_IDENTIFIER`      | Human identifier such as `FE-7`.                                             |
| `SYMPHONY_ISSUE_TITLE`           | Issue title.                                                                 |
| `SYMPHONY_ISSUE_STATE`           | Current tracker state name.                                                  |
| `SYMPHONY_ISSUE_PRIORITY`        | Numeric priority or empty string.                                            |
| `SYMPHONY_ISSUE_BRANCH_NAME`     | Tracker-suggested branch name or empty string.                               |
| `SYMPHONY_ISSUE_URL`             | Tracker URL or empty string.                                                 |
| `SYMPHONY_ISSUE_LABELS`          | Comma-separated label names.                                                 |
| `SYMPHONY_ISSUE_DESCRIPTION`     | Issue description (may contain newlines).                                    |

For most multi-repo workflows the `repositories:` block above is the
recommended path: Symphony clones the selected repos for you and the hook
only needs to perform repo-specific setup (install dependencies, fetch
branches, etc.). The example below uses `SYMPHONY_REPOS` to install
dependencies for every cloned repo:

```yaml
hooks:
  after_create: |
    set -e
    IFS=',' read -ra REPOS <<< "$SYMPHONY_REPOS"
    for repo in "${REPOS[@]}"; do
      slot=$(printf '%s' "$repo" | tr '[:lower:]-' '[:upper:]_' | tr -dc 'A-Z0-9_')
      eval path=\$SYMPHONY_REPO_${slot}_PATH
      (cd "$path" && [ -f package.json ] && npm install) || true
    done
```

Hook failures in `after_create` and `before_run` fail the affected run; `after_run` and `before_remove` failures are logged at `warn` level and do not block teardown.

## Implementation-Defined Policy

This implementation uses structured JSON logs on stderr as the status surface. It does not provide a web UI. It treats Codex approval, thread sandbox, and turn sandbox values as pass-through fields from workflow configuration. User-input-required events are not satisfied by Symphony; runs rely on the configured Codex app-server behavior and fail on process errors, turn timeouts, or cancellation.

Child processes (hooks and Codex) receive a scrubbed environment that removes parent-process variables whose names look secret-like (`api_key`, `token`, `secret`, `password`, `credential`, `authorization`). Issue fields exported via `SYMPHONY_*` are not redacted; do not place secrets in tracker fields. Codex stderr and runtime messages are redacted before they are written to structured logs.

## Development Commands

```sh
npm run format
npm run lint
npm run build
npm test
npm run verify
```

## Release

This package is not yet published. Before publishing, run `npm run verify`, bump `package.json`, tag the same version, and publish from a clean checkout.
