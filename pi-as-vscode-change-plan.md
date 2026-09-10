# Change Plan: Run Pi Harness as `vscode` (UID 1000), sudo for Docker

**Goal:** Fix the cross-container file-ownership mismatch at the source. Harness pi
writes to the shared bind-mount as root today → project files land `root:root` →
the project container's editor user (`vscode`, uid 1000) cannot edit them.
Plan: run the harness agent as uid 1000 so created files match the editor user;
keep root privileges via passwordless sudo only for Docker/socket ops.

**Status: EXECUTING — Phases A+B landed (working tree, committed as `pi-as-vscode`).
Phase C (human rebuild) + D (verify) pending.**

---

## Verified facts (sourced)

| Fact | Value | Source |
|---|---|---|
| Harness pi runs as | `root` (remoteUser:"root") | devcontainer.json |
| Harness `vscode` user | uid/gid 1000, `vscode ALL=(root) NOPASSWD:ALL` | sudoers.d |
| `sudo -n docker exec` as vscode | **works** (tested) | live |
| Docker socket | `/var/run/docker.sock` `srw-rw---- root root` (group root) | live |
| **Lifecycle scripts run as `remoteUser`** | "The user to use for spawning processes in the container **including lifecycle scripts**" | containers.dev spec |
| postCreateCommand execution | `docker exec -w <folder> -u <REMOTE_USER> <ctr> /bin/sh -c <CMD>` | vscode-remote-release#2201 |
| setup.sh invocation | via `postCreateCommand` (`./.devcontainer/setup.sh`); **NOT a Dockerfile RUN**; Dockerfile has no USER → container defaults to root | devcontainer.json, Dockerfile |
| Extension store | `/opt/pi-npm-store` root-owned; wiped+recreated by setup.sh every build | AGENTS.md, setup.sh |

**Consequence (reviewer-caught):** flipping `remoteUser` to `vscode` makes
setup.sh run as `vscode` → apt/npm -g/chown/store population all break.
**Fix applied:** self-elevating guard at the top of setup.sh
(`if [ "$(id -u)" != "0" ]; then exec sudo -n <abs path>; fi`) — context-proof
under Dockerfile RUN (root), postCreate/vscode (sudo re-exec), or manual run.

## Design decisions (locked)

1. `remoteUser` → `"vscode"` in `base_pi/.devcontainer/devcontainer.json`.
2. **Do NOT touch the Docker socket** perms/chown (chmod 666 = host-root for
   every host process; chown mutates the host inode via bind-mount). Docker
   stays behind `sudo -n` (wrapper added to the 2 docker call sites).
3. Ownership via chown — one-time now + deterministic in `setup.sh` (cheap,
   no daemon, no ACL/SGID which were rejected after testing).
4. No inotify, no ACL/SGID, no socket mutation.

## Steps

### Phase A — Code (DONE, committed)
- [x] A1. `devcontainer.json`: `"remoteUser": "root"` → `"vscode"`.
- [x] A2. `setup.sh`: self-elevation guard (top) + UID-1000 alignment block
      (bottom: migrate /root/.pi → /home/vscode/.pi; chown $WS, /opt/pi-npm-store,
      /home/vscode/.pi, /usr/local/bin/pi-run|pi-projects, /home/vscode).
- [x] A3. `pi-run`: `sudo -n docker inspect` + `sudo -n docker exec`.
- [x] A4. `pi-projects.js`: `sudo -n docker inspect` in `list`.
- [x] A5. Wire the ownership note into `CROSS-CONTAINER-WORKFLOW.md` (short).

### Phase B — One-time chowns (DONE, live)
- [x] B1. `chown -R vscode:vscode /workspaces/congruent_roster` (unblocks edits now).
- [x] B2. `chown -R vscode:vscode /workspaces/base_pi /opt/pi-npm-store`.
- [x] B3. Git intact (only expected churn: safe.directory notices from the
      root session — resolved via `git config --global --add safe.directory`).

### Phase C — Rebuild (HUMAN)
- [ ] C1. VS Code "Dev Containers: Rebuild Container" on `base_pi`.
      (Project container `congruent_roster` can stay up.)

### Phase D — Verify (agent, after rebuild)
- [ ] D1. pi session `whoami` = `vscode`.
- [ ] D2. `pi-projects list` shows `congruent_roster` Running (exercises `sudo -n docker`).
- [ ] D3. `pi-run congruent_roster python3 --version` works.
- [ ] D4. Extensions load; healthcheck `pi list` smoke test green.
- [ ] D5. pi creates a file in `/workspaces/congruent_roster` → owner = `vscode`
      from inside the project container; user edits it in VS Code.
- [ ] D6. `.devcontainer/healthcheck.sh` exits 0.

## Risks / notes
- **Root-owned caches** (`/root/.npm`) become irrelevant; `$HOME` → `/home/vscode`;
  global npm self-update may need sudo (acceptable).
- **Extension store** is recreated root-owned every build → the setup.sh chown
  is what keeps ownership deterministic (not one-time).
- Do **not** chmod/chown the docker socket in any path (host footgun).
- `git safe.directory` — only the *root* session needs it; post-rebuild vscode
  owns both repos and needs nothing.

## Definition of done
Pi session = vscode; docker via pi-run works (sudo); pi-created project files
are vscode-owned and editable from the project container's VS Code; healthcheck green.