# Cross-Container Workflow (pi harness ↔ project devcontainers)

The harness container (`base_pi`) runs pi and commands the host Docker daemon via
a mounted socket; project code lives in **separate project containers** (e.g.
`congruent_roster`) that pi never runs inside. pi reads/writes project files over
a shared bind-mount and executes commands inside the project container via
`docker exec`. Each repository keeps its own git history.

## What exists

| Piece | Where / What |
|---|---|
| `pi-run` | `base_pi/.pi/scripts/pi-run` (bash). Executes a command inside a registered project container. Symlinked to `/usr/local/bin/pi-run` by `setup.sh`. Uses `sudo -n docker` (the socket is root-only). |
| `pi-projects` | `base_pi/.pi/scripts/pi-projects.js` (Node, zero deps). Registry CLI: `register \| deregister \| list`. Symlinked to `/usr/local/bin/pi-projects`. Also exports `what_projects()` for extensions. |
| Registry | `base_pi/.pi/projects.json` — maps `<alias> → { container, path }`. Runtime state, gitignored. `pi-run` falls back to `alias`/`/workspaces/<alias>` if unregistered. |
| Bind mount | Project path `/workspaces/<project>` is mounted into both containers; writes from the harness sync instantly. |
| Registered projects | `pi-projects list` for the current set (contains `congruent_roster`). |

## How to use

1. **Start a session** — open the project repo in a VS Code window (spins up the
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
   pi-projects list                 # alias / container / path / running status
   pi-projects list --json          # machine-readable
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

1. Add one bind-mount entry for its host path in `base_pi/.devcontainer/devcontainer.json`
   (`"source=${localEnv:HOME}/workspaces/<project>,target=/workspaces/<project>,type=bind"`).
2. `pi-projects register <project> <container-name> /workspaces/<project>`.
3. Use `pi-run <project> <command>`; files at `/workspaces/<project>`.

Container resolution is by registry name; prefer a pinned name (`--name` in the
project's devcontainer runArgs) so the registry survives rebuilds. If a rebuild
renamed the container, re-`register` (or fall back to matching the devcontainer
label `devcontainer.local_folder`.

## Troubleshooting

- **`pi-run` says container not running** — the project's devcontainer isn't up;
  open the project window in VS Code first.
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