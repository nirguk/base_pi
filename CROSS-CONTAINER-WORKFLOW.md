# Cross-Container Workflow (pi harness ↔ project devcontainers)

The harness container (`base_pi`) runs pi and commands the host Docker daemon via
a mounted socket; project code lives in **separate project containers** (e.g.
`congruent_roster`) that pi never runs inside. pi reads/writes project files over
a shared bind-mount and executes commands inside the project container via
`docker exec`. Each repository keeps its own git history.

## What exists

| Piece | Where / What |
|---|---|
| `pi-run` | `base_pi/.pi/scripts/pi-run` (bash). Executes a command inside a registered project container. Symlinked to `/usr/local/bin/pi-run` by `setup.sh`. Uses `sudo -n docker` (the socket is root-only). Resolves the live container via `resolveContainer()` (see `pi-projects`). |
| `pi-projects` | `base_pi/.pi/scripts/pi-projects.js` (Node, zero deps). Registry CLI: `register \| deregister \| list \| resolve`. Symlinked to `/usr/local/bin/pi-projects`. Exports `what_projects()` and `resolveContainer()` for extensions. |
| Registry | `base_pi/.pi/projects.json` — maps `<alias> → { container, path }`. Runtime state, gitignored. The stored `container` name is a **hint, not authoritative**: Docker assigns a fresh transient name each devcontainer boot, so resolution falls through to the stable image name (below). |
| Image-based resolution | Devcontainer images follow the stable convention `vsc-<alias>-*` (e.g. `vsc-pi-audit-…`). `resolveContainer()` tries the stored name first, then matches a container by that image (preferring a running one). This makes `pi-run`/`list` survive container renames across reboots without re-registering. |
| Bind mount | Project path `/workspaces/<project>` is mounted into both containers; writes from the harness sync instantly. |
| Registered projects | `pi-projects list` for the current set (contains `congruent_roster`). |

## How to use

0. **Read the target repo's root `README.md` first.** It is the authoritative
   source for that project's toolchain and conventions — do NOT assume a vanilla
   setup from the harness side. The core facts that orient any agent (uv-managed?
   Node/npm? plain venv? build system?) belong in that README and should be
   extracted before executing anything. A project-managed venv (e.g. uv) must be
   run via its own tool (`uv run …`), never by invoking its `.venv` binaries
   directly. Check the README (and `pyproject.toml`/`package.json`) to learn the
   toolchain first.
1. **Start a session** — open the project repo in a separate VS Code window (spins up the
   project container), `base_pi` in another (harness). The project container must
   be running before `pi-run` works.
2. **Execute commands inside a project container:**
   ```bash
   pi-run <project-alias> <command...>
   pi-run congruent_roster python3 --version
   ```
   > Project containers currently expose `python3` (not `python`); use `uv run
   > …` if the project has a venv/`uv.lock`.
3. **Manage registered projects:**
   ```bash
   pi-projects list                 # alias / LIVE container / path / running status
   pi-projects list --json          # machine-readable (includes stored + resolved name)
   pi-projects resolve <alias>      # print the live {name, path, resolved, via} for one alias
   pi-projects register <alias> <container-name> [/path]
   pi-projects deregister <alias>
   ```
4. **Edit files** directly at the bind-mounted path (e.g.
   `/workspaces/congruent_roster/…`) — no `pi-run` needed for file I/O.
5. **Extensions** can discover projects natively:
   ```js
   const { what_projects } = require('/workspaces/base_pi/.pi/scripts/pi-projects.js');
   ```

## Adding another project

### Project-side files (required)

Each project repo needs a `.devcontainer/` directory so that VS Code
can build and attach a container when the repo is opened.

**`.devcontainer/devcontainer.json`** — minimum shape:
```json
{
  "name": "<alias>",
  "build": { "context": ".", "dockerfile": "Dockerfile" },
  "remoteUser": "vscode",
  "workspaceFolder": "/workspaces/<project>",
  "runArgs": ["--name=<alias>"]
}
```

**`.devcontainer/Dockerfile`** — minimum shape:
```dockerfile
FROM mcr.microsoft.com/devcontainers/base:ubuntu
```
Swap the base image for whatever the project needs (Node, Python, etc.).

### Harness-side setup

1. Add one bind-mount entry for the host path in
   `base_pi/.devcontainer/devcontainer.json`
   (`"source=${localEnv:HOME}/workspaces/<project>,target=/workspaces/<project>,type=bind"`).
2. `pi-projects register <project> <container-name> /workspaces/<project>`.
3. Use `pi-run <project> <command>`; files at `/workspaces/<project>`.

### Workflow

After the project-side files are in place, open the repo in VS Code
(a separate window from the harness). VS Code builds the container from
the Dockerfile and attaches to it. Once the container is running,
`pi-run <alias> <cmd>` executes commands inside it. The harness bind-
mount means files written from the harness are immediately visible in
the project container, and vice versa.

Container resolution: `pi-run`/`pi-projects` call `resolveContainer(alias)`, which
(1) uses the registry's stored container name if that container is running,
(2) otherwise matches a container by its stable devcontainer image `vsc-<alias>-*`
(preferring a running match), and (3) only if neither resolves, reports the stored
name as not-running. Because Docker assigns a fresh transient name each boot, the
stored name routinely goes stale — the image fallback is what keeps `pi-run`
working without re-registering. Pinning `--name` in the project's devcontainer
runArgs is still a nice-to-have for deterministic names, but is no longer required
for correctness. New aliases still need a registry entry (or an `alias` whose
image follows the `vsc-<alias>-*` convention) and a bind-mount of `/workspaces/<alias>`.

## Troubleshooting

- **`pi-run` says container not running** — the project's devcontainer isn't up;
  open the project window in VS Code first. (Resolution already falls back to the
  `vsc-<alias>-*` image name, so a stale registry name alone is no longer a cause.)
- **Permission denied on docker socket** — `pi-run`/`pi-projects` shell out via
  `sudo -n docker`; the socket stays root-only. Never `chmod`/`chown` it.
- **Files appear empty from inside the container** — host path in the
  `devcontainer.json` mounts entry doesn't match the project's actual location.

## Security note

Mounting the Docker socket gives the harness root-equivalent control over the
host's containers. Deliberate for this personal local harness.

## File ownership

Harness pi runs as `vscode` (uid 1000) — the same uid as project containers' editor
user — so files pi creates on the bind-mount are owned by uid 1000 and editable
from the project window. `setup.sh` re-applies `chown -R vscode:vscode` to the
workspace, `/opt/pi-npm-store`, and `/home/vscode/.pi` on every (re)build.