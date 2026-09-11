# AGENTS.md

Project-level instructions for pi.

- `.pi/extensions/` — pi extensions (TypeScript, one `.ts` file per extension)
- `.pi/scripts/` — standalone scripts used by extensions (`.mjs`/`.ts`, run directly with `node`)
- `.pi/git/` — **read-only** upstream clones for reference: search them, never edit, commit, or build in them

## Extension store symlinks (performance)

To bypass the bind-mount (host 9p/drvfs) I/O bottleneck, **`.pi/npm`** and **`.pi/git/github.com`** are symbolic links to container-native storage (`/opt/pi-npm-store/npm` and `/opt/pi-npm-store/git/github.com`). Extension installs/loads therefore read/write on the container's overlayfs, not through the host mount.

- **Do not replace these with physical directories.** A physical `node_modules` under `.pi` lands on the slow host mount again (a single-commit regression on faster machines — at stake: every extension load + npm install).
- **Do not `rm -rf` them or their contents from the workspace side.** Deleting the link is safe (it never follows into the store; a refresh on next rebuild re-creates it), but the deterministic-reconcile clean belongs in `.devcontainer/setup.sh` via `rm -rf /opt/pi-npm-store/*`.
- Symlinking the *parents* (not `node_modules` itself) is intentional: npm's install engine (arborist) and `git clean -fdx` both delete a symlinked `node_modules`; the parent symlink stays invisible to both and they operate normally inside the store.
- The symlinks are runtime artifacts and must never be committed. `.pi/npm` is ignored via root `.gitignore` and its tracked placeholder `.pi/npm/.gitignore` is marked `skip-worktree` (re-applied by `setup.sh` every build, since the flag is index-local and not cloned). `.pi/git/github.com` is covered by the committed `.pi/git/.gitignore` `*` rule. `git clean -fdx` will remove the symlinks (they're ignored), so setup.sh rebuilt them deterministically anyway.

## Devcontainer healthcheck

`.devcontainer/healthcheck.sh` runs as the devcontainer `postStartCommand` and exits non-zero on any failed check (degraded-container signal in VS Code, does not kill the container; append `|| true` in devcontainer.json to make it advisory). It verifies, standalone (self-locating on the workspace root):

1. Node runtime major matches the `features.node.version` pin in `devcontainer.json`
2. npm CLI present
3. Global `pi` version matches the `@earendil-works/pi-coding-agent` pin in `setup.sh`
4–5. `.pi/npm` and `.pi/git/github.com` are symlinks with existing targets
6. `/opt/pi-npm-store` npm + git trees are non-empty
7. Every `npm:` extension pinned in `.pi/settings.json` resolves to its pinned version under the store
8. Every `git:` extension resolves under the store with HEAD matching the pinned commit/tag
9. `pi list` smoke test (fast, ~1s) — extension resolution end-to-end

On failure, each check prints a one-line FAIL with a fix hint; exit 1 if any hard check fails.

There is no package.json or test suite here. When you change a script, verify it by running it; when you change a doc, verify example commands actually work.

## Tool Use Tips

### File Search

#### `findtree` — directory exploration

`findtree` is a pi **extension** (`.pi/extensions/findtree.ts`) that registers a **tool** the LLM can call and a **slash command** (`/findtree`) the user can invoke. It pipes `find` through `tree --fromfile`, collapsing repeated parent-directory prefixes into a compact ASCII hierarchy — fewer tokens, structure visible at a glance. This is the tool to use for any directory exploration task.

**LLM tool call** — the agent calls the `findtree` tool with `path` and `expressions` parameters, plus optional `from` (skip first N find result paths) and `lines` (paths per page, default 100, max 500). Paging is applied at the input level via `tail | head` so `tree` only processes the current page's paths.

**Slash command** — the user types:
```
/findtree . -type f -name "*.ts" -not -path "*/node_modules/*"
/findtree . -type f -name "*.ts" --from 100 --lines 100
```

**Example** — find all `.ts` files across the project (slash command):
```
/findtree . -type f -name "*.ts" -not -path "*/node_modules/*"
```
Output (collapsed tree, not repeated full paths):
```
.
└── src
    ├── components
    │   └── Button.tsx
    ├── hooks
    │   └── useAuth.tsx
    └── utils
        └── helpers
            └── format.ts
```

> ⚠ **`findtree` is a pi tool, not a shell command.** Do not invoke it via `bash` (e.g. `findtree . ... 2>/dev/null || find . ...`). It is not a CLI binary — calling it from a shell will fail silently (or fall through to `find`, losing tree formatting and paging). Always call it through the pi tool system or the `/findtree` slash command.

**Paging**: When results exceed 100 lines, the output is cropped with a footer indicating how many lines remain and the `--from N` value to use for the next page.

#### `fd` — use for flat listing and piping

Use `fd` when you need a flat list of paths (e.g., to pipe into `xargs`, `wc -l`, or another command). It is faster than `find`, uses simpler glob syntax, and respects `.gitignore` automatically.

**Example** — count all `.ts` files:
```
fd --type f --glob "*.ts" . | wc -l
```

**Example** — delete all `.log` files:
```
fd --type f --glob "*.log" . -X rm
```

If `fd` is not installed, use `findtree` instead.

#### Directory inspection — use `findtree`

For any directory, use `findtree` once to see the full structure in a single read. For a single directory, `ls` is fine.

### Content Search (use `rg`, never `grep -r` by default)

- **`rg` is the default for all content searches.** It is faster on large trees and automatically skips `.gitignore`-d directories.
- **Never use `bash grep -r`** for content searches when `rg` is available. If you catch yourself about to, stop and use `rg` instead.
- **If `grep -r` is unavoidable** (e.g., `rg` missing), scope it narrowly so it doesn't recurse into `.pi/` or `node_modules` and time out — e.g. `grep -rn "TODO" src/ --exclude-dir=node_modules`.

| Goal | Wrong | Right |
|------|-------|-------|
| Search file contents | `grep -r "or-metrics" .` | `rg "or-metrics"` |
| Search specific ext | `grep -r "TODO" --include="*.ts"` | `rg -t ts "TODO"` (also `-g '*.ts'`) |
| Invert match | `grep -rv "debug" .` | `rg -v "debug"` |

### File Editing

#### `edit` — precise replacements (primary for targeted changes)

Use `edit` for targeted text replacement. Multiple disjoint changes in one file go in **one call** as an `edits[]` array — do not make N sequential calls. Each `oldText` must be unique and non-overlapping in the file; if two changes touch the same block or nearby lines, merge them into one edit. Keep `oldText` as small as possible while still unique — don't pad with large unchanged regions.

#### `patch` — apply unified diffs (when you have a diff or want reversibility)

`patch` applies a unified diff file to a target file. It is reversible (`patch -R`), composable, and never silently overwrites content — it applies changes line-by-line and reports conflicts.

**Example** — apply a generated diff:
```bash
patch src/index.ts < changes.patch
```

**Example** — undo a patch:
```bash
patch -R src/index.ts < changes.patch
```

**Example** — generate and apply in one step:
```bash
diff -u original.ts modified.ts > changes.patch && patch original.ts < changes.patch
```

#### `write` — new files or complete rewrites

Use `write` only for new files or complete rewrites. Partial updates should use `edit` or `patch`.

#### `bash` with `sed`/`perl` — bulk or programmatic edits

For 3+ changes in a file, or transformations that are awkward as diffs, use `bash` with `sed`, `perl`, or a node script. These operate on the file directly without the file content entering the token stream.

**Example** — in-place replace across a file:
```bash
sed -i 's/old_string/new_string/g' src/config.ts
```

**Example** — structured transformation with node:
```bash
node -e "const fs=require('fs'); const f=fs.readFileSync('data.json','utf8'); const d=JSON.parse(f); d.key='value'; fs.writeFileSync('data.json',JSON.stringify(d,null,2));"
```

### Other Tool Preferences

- **Never count things by eye** — don't try to compute character, line, token, or occurrence counts from file contents in your context; such estimates are unreliable. Measure indirectly with a tool or command instead — `wc -m` (chars), `wc -c` (bytes), `wc -l` (lines), `rg -c 'pat'` (lines containing a match), `rg -o 'pat' | wc -l` (total matches.
- **Use `read` over `cat`/`sed`** — handles truncation gracefully and supports offset/limit for large files.
- **Check `~/.pi/agent/AGENTS.md`** for global tips that apply across all projects.

### Subagents & orchestration — quick rules

- **Match the prompt to agent tools.** `reviewer` is read-only (it has no shell, so it can't run anything). `scout`/`freshworker` have a shell and are the ones that execute. When a read-only reviewer needs a runtime fact, have it list the exact command a shell-capable agent should run and gate its verdict on that check.
- **Builders self-test as a gate.** A `freshworker` task is done when it has executed the tool and pasted stdout + exit codes for the edge cases in the task. If it hasn't run anything, treat the deliverable as not yet submitted.
- **Two-tier verification.** Executable artifacts get a *static* read-only review (structure, resolve, exit contract) and an *exec smoke* on a shell-capable agent — two separate checks, both bounded.
- **Bound reviewers.** Give a static reviewer a specific file list and a token/turn budget, so it does not wander into vendor internals, source maps, or lockfiles. If a behavior needs running, route that to a separate smoke runner.
- **Orchestrator must decide.** Each workflow's return step lists per strand: ship / needs-loop(reason+exact-feedback). Treat a crashed child as a needs-loop; validate workflow variable names up front to avoid `ReferenceError` loops.
- **Git-destructive actions are gate-kept.** A shell-capable worker must NOT run unapproved git operations that rewrite history or discard working-tree state — `git restore`, `git checkout -- <file>`, `git reset --hard`, `git clean -fdx`, `git stash drop`, `git commit --amend`/`rebase` — unless the orchestrator explicitly authorises them in the task text. `git status`/`git diff`/`git add --dry-run` are always fine. Two rules: (1) never assume a clean working tree — the relevant file may already carry uncommitted changes the orchestrator made; (2) if the worker thinks it must reset a file to some baseline, that is a signal to STOP and ask, not to `git restore`.
  - Default safe play: `cp <file> /tmp/<name>.before` as a backup before editing; use `edit`/`write` on the exact file only; prove scope with `git diff <file>`. In the task text, give the worker the explicit copy of files it may touch and an explicit list of forbidden git commands.
- **Backticks stay literal.** Build child task text as plain-string arrays joined with newlines, not JS template literals — a backtick inside the task (command examples, inline code) would terminate the outer literal and crash the whole `workflowScript` before any child runs.
- **Presence checks**: for "is X installed", check all real candidate paths (nvm global, /usr, /usr/local, ./bin); a single dpkg search can miss a tool installed elsewhere and yields a false negative.
- **Lane machinery contracts**: `resume` and a different `agent` are mutually exclusive (worker→reviewer crosses via task text, not session resume); only give `outputSchema` to agents that return `structured_output` (prose-verdict `reviewer` must not get one); bind the precise field (`worker.structuredOutput.evidence`), not the whole object, or it stringifies to `[object Object]`; reviewer providers can `terminated` mid-run — restart once or split the review into narrower subtasks.
- **Ordering (lean)**: run the worker's known deterministic pass/fail command (`run X → expect exit 1`) as an exec-smoke *first*, then let the static reviewer reason about an already-run artifact; re-smoke only for a genuinely novel command the reviewer declares (`gated-on-<cmd>`). Reserve a heavier two-stage reviewer (read-only stage-1 → bash-capable stage-2) for code with real runtime branching.
- **Trivial-strand exemption**: for a handful of shell lines, a full parallel `reviewer` fanout is overkill — a single cheap static pass plus the bounded exec-smoke worker suffices; save heavy reviewers for real branching.

#### Prompt patterns (ready to paste)

**Static reviewer** (read-only `reviewer`):
```
Your job: inspect the reviewed source and report every concrete blocker you find.
Work from the source file(s) only — read the exact paths you were given and what
they directly depend on; that scope is enough to judge structure and contract.
You cannot execute anything, so if a fact can only be proven by running, say the
exact command a shell-capable agent must run and mark your verdict as
gated-on-that-check.
```

**Builder self-test gate** (shell-capable `freshworker`):
```
MANDATORY SELF-TEST GATE — before declaring done you MUST execute the tool against
the real inputs shown below and paste exact stdout + exit codes for:
  (1) two different files, (2) a file with itself (identical), (3) writing to --out.
If any case fails, keep fixing until all pass. An untested deliverable is a FAILED
deliverable. Also state the one runtime command the user/reviewer will run.
```

## Project Container Workflow (cross-container)

Project code may live in separate project devcontainers (e.g. `congruent_roster`)
rather than inside this harness. Pi operates from the harness container and does
not run inside the project container. See `CROSS-CONTAINER-WORKFLOW.md` for the
full pattern.

**Prereq:** the target project's container must be running (opened in VS Code).

- **Step 1 — read the target repo's root `README.md` BEFORE operating on it.**
  It is the ground truth for that project's toolchain and conventions (is it
  uv-managed, a Node/npm project, a plain venv, a Go/Cargo workspace …?) and
  should orient any agent dropped into the container. Never assume a vanilla
  toolchain from the harness side: e.g. a uv-managed project must be run with
  `pi-run <alias> uv run …`, not by poking its `.venv` directly. When the harness
  needs runtime facts about the container, fold this read into the
  `scout`/`freshworker` task you delegate to that container.
- **To execute commands** (tests, builds, scripts) inside a project container:
  ```bash
  pi-run <project-alias> <command...>
  ```
  Examples:
  ```bash
  pi-run congruent_roster python3 -m pytest
  pi-run congruent_roster uv pip install -e .
  ```
  (project containers expose `python3`, not `python`)
- **Manage registered projects:**
  ```bash
  pi-projects list                 # alias / container / path / running status
  pi-projects list --json          # machine-readable registry
  pi-projects register <alias> <container-name> [/path]
  pi-projects deregister <alias>
  ```
  The registry lives at `.pi/projects.json` (runtime state, not committed).
- **To read or write project files** directly (no container execution needed):
  access the bind-mounted path, e.g. `/workspaces/congruent_roster`. Writes sync
  to the project container instantly.
- **Extensions** can discover registered projects natively from Node:
  ```js
  const { what_projects } = require('/workspaces/base_pi/.pi/scripts/pi-projects.js');
  ```

## Before Finishing

- Re-read your diff: check example commands for typos — tool flags are easy to get wrong (this file has had one).
- If you changed a script in `.pi/scripts/`, run it to confirm it executes.
- Confirm you made no edits under `.pi/git/` (read-only reference).