# AGENTS.md

Project-level instructions for pi.

- `.pi/extensions/` — pi extensions (TypeScript, one `.ts` file per extension)
- `.pi/scripts/` — standalone scripts used by extensions (`.mjs`/`.ts`, run directly with `node`)
- `.pi/git/` — **read-only** upstream clones for reference: search them, never edit, commit, or build in them

## Voice — chat and docs

Write to people like a colleague across the desk, not a report or an automated system: short sentences, plain words, and no project shorthand unless you unpack it in the same breath. This binds everything that leaves the keyboard — chat, notes, commits, docs. Internal reasoning stays free; only your output is governed.

The failure mode to watch for is compression into shorthand that needs translating. Same facts, both sides; the identifier stays (it is the thing being discussed, not jargon); everything else is said plainly. Four validated contrasts:

*Rather than:* "The seam decision is flagged in the handover — `_check_units` returns only a label set today; alignment needs parent edges."
*Say:* "Per the handover, we have `_check_units`, the earlier guard phase, and an alignment phase that completes the guard."

*Rather than:* "F-13 is deliberately not a blocker — alignment is structure-only, a day-sized, gate-green milestone that also gives the week-one 'structure validated' beat."
*Say:* "F-13 is an open question about how we count residents when we get to disclosure. It's about counting, not tree structure, so it doesn't hold up the alignment phase."

*Rather than:* "Here's my draft for you to knife."
*Say:* "Here's my draft for you to criticise."

*Rather than:* "The sentence is armour, not content."
*Say:* "The sentence is defensive rather than informative."

All four pairs carry identical facts; only the vocabulary differs. Plain talk is not brevity — a good sentence runs as long as it needs to. Where a project carries its own voice rules, follow those first.

Self-check before you send or commit: if you'd have to apologise for a word to the person reading it, rewrite the sentence.

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

`findtree` is a pi **extension** (`.pi/extensions/findtree.ts`) that registers a **tool** the LLM can call and a **slash command** (`/findtree`) the user can invoke. It pipes `fd` through `tree --fromfile`, collapsing repeated parent-directory prefixes into a compact ASCII hierarchy — fewer tokens, structure visible at a glance. This is the tool to use for any directory exploration task. `fd` is provisioned by pi itself (`.pi/bin/fd`); it walks in parallel and respects `.gitignore`, so it stays fast on trees with heavy `node_modules` folders.

**LLM tool call** — the agent calls the `findtree` tool with `path` and `args` (native `fd` arguments) parameters, plus optional `from` (skip first N result paths) and `lines` (paths per page, default 100, max 500). Paging is applied at the input level via `tail | head` so `tree` only processes the current page's paths. Hidden files are included; gitignored files are skipped unless `--no-ignore` is passed.

**Slash command** — the user types:
```
/findtree . --type f --glob "*.ts" --exclude node_modules
/findtree . --type f --glob "*.ts" --from 100 --lines 100
```

**Common `fd` flags** (what goes in `args`): `--type f` (files) / `--type d` (dirs), `--glob "*.ts"` (glob match), `--exclude node_modules` (skip a dir, repeatable), `-d 3` (max depth), `--no-ignore` (include gitignored files), `--hidden` is already on.

**Example** — find all `.ts` files across the project (slash command):
```
/findtree . --type f --glob "*.ts" --exclude node_modules
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

If `fd` is not installed, install it (pi provisions `.pi/bin/fd` automatically; otherwise `apt install fd-find` / `brew install fd`) — `findtree` needs it as its search engine.

#### Directory inspection — use `findtree`

For any directory, use `findtree` once to see the full structure in a single read. For a single directory, `ls` is fine.

### File Editing

#### `fuzzy_edit` — file edits (default, supersedes `edit`)

Use `fuzzy_edit` for targeted text replacement. Same parameter shape as the built-in `edit` tool (`{file, edits:[{oldText, newText}]}`, plus optional `threshold?` and `dry_run?`), so anything written for `edit` works unchanged. Exact matches apply immediately; only misses fall through to tolerant matching, which heals differences in spacing or indentation. Multiple disjoint changes in one file go in **one call** as an `edits[]` array — do not make N sequential calls. Each `oldText` must be unique and non-overlapping in the file; if two changes touch the same block or nearby lines, merge them into one edit. Keep `oldText` as small as possible while still unique — don't pad with large unchanged regions.

- Edits are **atomic** (all or nothing, including on timeout — the file is restored to its pre-call bytes), report match type + confidence + matched text per edit, and write an undo backup under `.hk/` (gitignored runtime artifact). `dry_run: true` previews without touching the file.
- `oldText` guidance: keep it exact, unique, compact. **Beyond ~300 chars only whitespace drift is healed** — a large block that matches nowhere is refused fast with a re-read instruction, deliberately: harnesskit's fuzzy stages are quadratic (a ~500-char miss measures 60s+), and a large content-drifted block is a wrong-block signal, not drift — re-read and resubmit exact text.
- Use the built-in `edit` only for large blocks you hold byte-exact (over ~300 chars). If any edit call fails once, do not retry the same tool with tweaks — switch tools instead.
- If `fuzzy_edit` misbehaves or is absent, run `uv sync` in this repo root (the venv lives on container-native storage at `/opt/base-pi-venv`, symlinked from `.venv`).

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
- **Never gate a commit on piped output** — `ruff check ... | tail -1` exits clean whatever ruff says, so lint failures sail into the commit. Run gates unpiped and check the exit code (`... && git commit`), or `set -o pipefail` first. Logged 20 Sep 2026 after a treatments commit landed with five E501s.
- **Check `~/.pi/agent/AGENTS.md`** for global tips that apply across all projects.

### Subagents & orchestration — quick rules

- **Match the prompt to agent tools.** `reviewer` is read-only (it has no shell, so it can't run anything). `scout`/`freshworker` have a shell and are the ones that execute. When a read-only reviewer needs a runtime fact, have it list the exact command a shell-capable agent should run and gate its verdict on that check.
- **Background by default.** Launch subagents with `async: true` unless the next step genuinely needs the result first. The owner prefers background: the session stays open for questions and steering while a child runs, and the child reports back when it finishes or needs attention. Foreground (`async: false`) is the exception for tight chains like builder-then-reviewer on one ticket.
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

#### `pi-research-pair` — two-agent research pipeline

A reusable research pattern: `pi-researcher` gathers a **raw**, `pi-condenser` folds it into a **narrative `-x`** (human-reviewable without raw), with a **deterministic structural gate** (`check-research.mjs`). For stages where research must be reproducible and content kept out of main model context.

**Invoke with:** `run the pi-research-pair for stage <N>`

**The usable assets all live in this repo (base_pi):**

- **Living spec** (what / why / decision-log): `.pi/research-pair/RESEARCH_PAIR.md` — maintain the pattern **there**, not here.
- **Runbook** (run-enable + placeholders): `.pi/research-pair/README.md`
- **Gate + scaffold**: `.pi/research-pair/bin/check-research.mjs`, `.pi/research-pair/bin/run-stage.mjs`
- **Prompt templates**: `.pi/research-pair/prompts/researcher.md`, `condenser.md`, `example-stage-08.md`
- **Agents** (in this dir): `.pi/agents/pi-researcher.md`, `.pi/agents/pi-condenser.md`

Run the gate/scaffold from the **project root** whose `research/` dir has the stage files (scripts resolve `research/` against `process.cwd()`), e.g. `cd /workspaces/<project> && node /workspaces/base_pi/.pi/research-pair/bin/run-stage.mjs 08 --gate-only`. A project repo may carry `check-research.mjs` / `run-stage.mjs` / `prompts/` as **symlinks** onto these canonical copies so its local docs keep working.

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

- **When asked to attend to a named project, announce the session.** Say which project you are joining, then run a light-touch check via `container_exec` (e.g. `pwd`) so the session name shows and the user sees the link is live.

- **Step 1 — read the target repo's root `README.md` BEFORE operating on it.**
  It is the ground truth for that project's toolchain and conventions (is it
  uv-managed, a Node/npm project, a plain venv, a Go/Cargo workspace …?) and
  should orient any agent dropped into the container. Never assume a vanilla
  toolchain from the harness side: e.g. a uv-managed project must be run with
  `pi-run <alias> uv run …`, not by poking its `.venv` directly. When the harness
  needs runtime facts about the container, fold this read into the
  `scout`/`freshworker` task you delegate to that container.
- **To execute commands** (tests, builds, scripts) inside a project container,
  use the `container_exec` tool (`.pi/extensions/container_exec.ts`). It shares
  its resolver with `pi-run`, so the two cannot drift apart. It names the
  session after the alias on first use, so cross-container work is easy to
  find in `/resume`. Fall back to `pi-run` in bash only outside a session
  (terminal, script, cron) or when the tool is unavailable:
  ```bash
  pi-run <project-alias> [--user <user>] [--env KEY=VAL ...] <command...>
  ```
  Examples:
  ```bash
  pi-run congruent_roster python3 -m pytest
  pi-run congruent_roster uv pip install -e .
  ```
  Commands run **as root by default** (`HOME=/root`). Pass `--user`/`--env`
  **before** the command when tooling keys off the dev user's home or needs
  variable overrides (e.g. DSH profiles live in the dev user's `$HOME/.dsh`;
  a root-shell `dsh web` silently boots a fresh empty profile):
  ```bash
  pi-run dsh_cv --user vscode bash -c 'echo $HOME'       # /home/vscode
  pi-run dsh_cv --env DSH_HOME=/home/vscode/.dsh node …  # env passthrough
  ```
  Options are parsed until the first non-option token; `--` ends option parsing.
  (project containers expose `python3`, not `python`)

  **`container_exec` requires an explicit `user` — there is no default.**
  Pass `user: "vscode"` (or `pi-run --user vscode`) for anything that writes
  to the project working tree, because files written as container root land
  root-owned on the host mount and lock the dev user out of them. Use
  `user: "root"` only when elevated access is genuinely required.
- **Manage registered projects:**
  ```bash
  pi-projects list                 # alias / container / path / running status
  pi-projects list --json          # machine-readable registry
  pi-projects resolve <alias>      # print the live container/path for one alias
  pi-projects register <alias> <container-name> [/path]
  pi-projects deregister <alias>
  ```
  The registry lives at `.pi/projects.json` (runtime state, not committed).

  **Container names are transient.** Docker assigns a fresh random name to each
  devcontainer boot (e.g. `pi-audit` was `beautiful_jang`, then `admiring_mahavira`),
  so the name stored in `projects.json` routinely goes stale. `pi-run` and
  `pi-projects list` don't trust the stored name — `resolveContainer(alias)` tries
  it first, then matches a container by its stable devcontainer image `vsc-<alias>-*`
  (preferring a running match), and only reports the stored name when nothing
  resolves. You do NOT need to re-register after a rebuild/rename; the image
  fallback handles it.
- **To read or write project files** directly (no container execution needed):
  access the bind-mounted path, e.g. `/workspaces/congruent_roster`. Writes sync
  to the project container instantly.
- **Keep project worktrees inside the bind mount.** A worktree created beside
  the checkout (e.g. `/workspaces/<repo>-suffix`) lives on container-only
  storage: agents can use it, but the host (Windows/macOS) never sees its
  files, so built pages and reports look missing from the user's side. Create
  worktrees under the mirrored tree instead, e.g.
  `/workspaces/<repo>/.worktrees/<name>`, and keep the parent clean with a
  local `.git/info/exclude` entry for `.worktrees/` (no repo commit needed).
  `git worktree move` cannot cross the mount boundary (invalid cross-device
  link) — if a worktree already sits outside, re-register it: fresh
  `git worktree add` at the inside path, copy back everything except `.git`,
  point `.venv` at the container-native store (symlink, never a real dir on
  the mount), and `rm -rf` the old tree. Bulk copies across the boundary are
  slow (9p): copy only what cannot be rebuilt (`shared_in/`, fixtures),
  regenerate the rest, and never `cp -a` a real `.venv` directory.
- **Extensions** can discover registered projects natively from Node:
  ```js
  const { what_projects } = require('/workspaces/base_pi/.pi/scripts/pi-projects.js');
  ```

## Before Finishing

- Re-read your diff: check example commands for typos — tool flags are easy to get wrong (this file has had one).
- If you changed a script in `.pi/scripts/`, run it to confirm it executes.
- Confirm you made no edits under `.pi/git/` (read-only reference).