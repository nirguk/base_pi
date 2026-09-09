# Cross-Container Action Plan: Pi Harness ↔ `congruent_roster`

**Status:** EXECUTING — Phases 1–4 landed; Phase 5 (human checkpoint) pending
**Owner:** pi agent (me) + human (checkpointed)

### Execution log

- **2025-09-09:** Phases 1–2 landed and committed to `base_pi` (docs revision, docker CLI
  in harness Dockerfile, `pi-run` + `pi-projects` tooling + setup.sh symlinks + `AGENTS.md`
  section; `projects.json` gitignored as runtime state).
- **2025-09-09:** Phase 4 landed — `congruent_roster` scaffolded, committed, and image
  pre-built (`congruent-roster-project:latest`) after a human rebuild that bind-mounted
  the sibling path. Deviation: base image already ships `vscode` user (uid 1000), so the
  doc's `developer` user creation was dropped in favor of the built-in user.
- **pending:** Phase 5 — human opens `/workspaces/congruent_roster` in VS Code (second
  window); then Phase 6 E2E verification (`pi-projects register`, `pi-run`, mount sync).
**Input doc:** `CROSS-CONTAINER-WORKFLOW.md` (concept, reviewed below)
**Target project name:** `congruent_roster` (does not exist yet — will be scaffolded)

---

## 1. Objective

Stand up the cross-container workflow described in `CROSS-CONTAINER-WORKFLOW.md`:

- The **harness container** (`base_pi`, current container id `4bfd956c8004…`) runs
  pi and commands the host Docker daemon via a mounted socket.
- A **project container** (`congruent_roster`) provides a clean Python-only runtime
  (no pi, no Node).
- pi reads/writes project files through a shared bind-mount and executes commands
  inside the project container via `docker exec`.
- Interfacing goes through a small toolchain: `pi-run` (exec) + `pi-projects`
  (registry: `register|deregister|list`), with a Node-native `what_projects()`
  API for extensions.

Execution order is staged so that **nothing breaks until the human rebuilds the
harness**, and everything from the agent side is reversible.

---

## 2. Pre-flight findings

Verified against the live environment (host `4bfd956c8004…`, devcontainer
`Ubuntu & Node`, Docker Desktop running on host).

### Environment facts

| Fact | Value |
|---|---|
| Root inside harness? | yes (`uid=0`) |
| Docker CLI inside harness | **absent** (no `docker` binary, no socket at `/var/run/docker.sock`) |
| `/workspaces/` writable from harness | **yes** (verified by probe) — agent can scaffold the sibling repo |
| Existing sibling repos | `base_pi` (harness; git clean), `pi-retry-from-thoughts` (in-flight feature, **not** a target container) |
| Node version | v26.8.1 |

### Doc vs reality (drive the revision)

| # | Doc claim | Reality | Action |
|---|---|---|---|
| G1 | Step 2 implies harness has a `docker` CLI | None installed; Dockerfile installs only curl/unzip/bash | **Add docker CLI to harness Dockerfile** (doc omits this) |
| G2 | Socket mount + bind mounts in harness `devcontainer.json` | Actually `"mounts": []`, `"runArgs": []`, no `DOCKER_HOST` | Implement (takes effect on rebuild) |
| G3 | `AGENTS.md` project-container section; `pi-run` / `pi-projects`; setup symlinks | Absent | Implement (works now, no rebuild) |
| G4 | Hardcoded `my-project`, `--network=host`, `/workspaces/my-project` | Project will be `congruent_roster`; `--network=host` is legacy cruft | Parameterize doc to `congruent_roster` |

### Design calls (agent-side review)

1. **Keep** the registry-based design: `pi-projects.js` (Node, zero deps) as CLI +
   `what_projects()` module; `pi-run` resolves `alias → (container, path)` from
   `projects.json`, falls back to `alias`/`/workspaces/<alias>`.
2. **Drop** `--network=host` from the naive suggestion (legacy; keep devcontainer
   defaults, or make it an explicit note with justification if needed).
3. **Extend** the doc's `setup.sh` symlink step with the healthcheck footnote:
   `healthcheck.sh` currently has no docker checks — add an optional one once
   the toolchain lands (see §7 Risks).
4. **Security note stays**: socket mount = root-equivalent host control.
   Deliberate, personal-harness trade-off; document it.

---

## 3. Ordered steps

Legend: **[E]** = agent executes · **[H]** = human executes.

### Phase 1 — Review & revise the doc (no rebuild)
1. **[E]** Revise `CROSS-CONTAINER-WORKFLOW.md`:
   - Parameterize project (`my-project` → `congruent_roster`).
   - Add missing **docker CLI install** step to the harness build (Step 2 addition).
   - Mark `--network=host` optional/removed.
   - Add a "Current status vs doc" section referencing this plan.
2. **[E]** Add `docker.io` (cli only) to `.devcontainer/Dockerfile`.
   - Frees the harness to talk to the mounted socket after rebuild.
   - (No effect until rebuild.)

### Phase 2 — Harness tooling (works now, no rebuild)

3. **[E]** Write `.pi/scripts/pi-run` — bash, registry-aware (the *revised* Step 7
   version, not the hardcoded Step 3 version); same usage
   `pi-run <alias> <cmd…>`; reads `projects.json` via `node`.
4. **[E]** Write `.pi/scripts/pi-projects.js` — Node CLI
   (`register|deregister|list [--json]`) + `module.exports.what_projects()`.
   - Registry file: `/workspaces/base_pi/.pi/projects.json`.
5. **[E]** Wire into `.devcontainer/setup.sh`:
   - `ln -sf …/pi-run /usr/local/bin/pi-run`
   - `ln -sf …/pi-projects.js /usr/local/bin/pi-projects`
6. **[E]** Append "Project Container Workflow" section to `AGENTS.md`,
   adapted to `congruent_roster` (command = `pi-run congruent_roster …`,
   files at `/workspaces/congruent_roster/`).

### Phase 3 — Harness config that gates on rebuild

7. **[E]** Edit `base_pi/.devcontainer/devcontainer.json`:
   - `mounts`: docker.sock bind + `${localEnv:HOME}/workspaces/congruent_roster`.
   - Add `"DOCKER_HOST": "unix:///var/run/docker.sock"` to `containerEnv`.
   - Keep every existing env key; do **not** add `--network=host`.
   - **Effect only after harness rebuild (Phase 5).**

### Phase 4 — Scaffold the project side

8. **[E]** Create `/workspaces/congruent_roster/` (sibling on host via writable mount):
   - `.devcontainer/Dockerfile` — python3, python3-venv, pip, git, bash; non-root
     user `developer`; `WORKDIR /workspaces/congruent_roster`.
   - `.devcontainer/devcontainer.json` — remoteUser `developer`, workspaceFolder,
     `PYTHONPATH`, no pi / no Node / no base_pi refs.
   - `README.md`, `.gitignore` (Python + runtime), `git init` (empty initial commit).
   - **Does nothing until opened; container boots when the human opens it (Step 9).**

### Phase 5 — 🕳️ HUMAN CHECKPOINT (you-only block)

9. **[H]** In VS Code:
   - **Rebuild the `base_pi` container**: Command Palette → "Dev Containers:
     Rebuild Container". (Picks up socket mount, bind mount, docker CLI.)
   - Open `/workspaces/congruent_roster` in a **second** VS Code window
     ("File → Open Folder" → the sibling path). This spins up the **Python
     project container** (name e.g. `congruent_roster-devcontainer`).
   - Return to the agent; confirm both containers are up.

### Phase 6 — End-to-end verification (agent, on return)

10. **[E]** Harness-side checks:
   - `docker ps` works from harness; socket mounted.
   - `docker inspect` on the project container → running.
   - `pi-projects register congruent_roster <container-id> /workspaces/congruent_roster`
     → `list` shows **green "Running"**.
   - `pi-run congruent_roster python3 --version` prints the Python version.
   - Bind-mount sync: write a file from harness at `/workspaces/congruent_roster/…`,
     read it from inside the container; and the reverse.
11. **[E]** Optionally demo `what_projects()` in a tiny throwaway extension;
   if it lands nicely, document in `DEVELOPING-EXTENSIONS.md`.
12. **[E]** Final review: `git status` clean reconciliation; commit doc revision +
   tooling + plan. Optionally add an opt-in healthcheck check for the socket/CLI.

---

## 4. Risks & notes

- **Socket == root on host.** Intentional for a personal local harness; note in doc.
- **Rebuild is the only structural change.** Steps 1–8 can all land without
  restarting the harness; only Step 7 requires the rebuild to actually mount.
- **`projects.json` & the scripts live in `.pi/`** which is partly gitignored —
  decide whether to track the scripts + example registry (`projects.json` stays
  gitignored as runtime state). Scripts under `.pi/scripts/` are already covered
  by the AGENTS.md tooling convention.
- **Host path** on the mount line must match the actual sibling location on the
  Host filesystem (`${localEnv:HOME}/workspaces/congruent_roster`); verify at
  Phase 6.
- **Docker CLI install** (`docker.io`) only adds the client; the socket does the
  talking. If the host is Docker Desktop/WSL, confirm where the socket lives on
  rebuild (Phase 6 check).

---

## 5. Definition of done

1. `CROSS-CONTAINER-WORKFLOW.md` revised (parameterized, docker-CLI step, status
   note) — commited.
2. Harness has `pi-run` + `pi-projects` on PATH (both `chmod +x`, symlinks in
   setup.sh), registered in `AGENTS.md`.
3. Harness `devcontainer.json` mounts socket + project dir, `DOCKER_HOST` set.
4. `congruent_roster` repo exists with py devcontainer + scaffolding; opens in a
   second window.
5. `pi-run congruent_roster python3 --version` succeeds from the harness.
6. Registry lists `congruent_roster` with `Running` status; file sync verified
   both directions.
7. Repo committed; plan file tracked.