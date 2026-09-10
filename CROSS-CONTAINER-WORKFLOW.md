# Cross-Container Workflow: Pi Harness + Project Devcontainer

> **Status note (2025-09):** This doc is the *concept/aspiration*. The live harness
> differs from the snippets here until
> [`cross-container-action-plan.md`](cross-container-action-plan.md) is executed.
> In particular: the harness `devcontainer.json` currently has `"mounts": []` and
> no `DOCKER_HOST`, and the harness has **no docker CLI** installed yet. The
> action plan tracks the concrete, staged delta and is the source of truth for
> what exists vs. what is planned. `congruent_roster` is the **first project**
> being wired up; it is an example entry in the registry, not a special case.
> See "Adding More Projects" below for how other projects plug in.

## File Ownership: Harness Runs as `vscode` (UID 1000)

> Live behavior (tracked in [`pi-as-vscode-change-plan.md`](pi-as-vscode-change-plan.md)).

Harness pi runs as uid/gid **1000** (`remoteUser: "vscode"`) — the same uid as the
project container's editor user — so files pi creates on the shared bind-mount are
owned by uid 1000 and immediately editable from the project container's VS Code.
The harness no longer writes as root. Root survives only behind passwordless sudo,
and exclusively for Docker socket ops: `pi-run` / `pi-projects` shell out via
`sudo -n docker <...>`. The socket itself stays root-only (`srw-rw----`); never
chmod/chown it (chmod = host footgun, chown mutates the host inode). One-time
chowns are now deterministic: `setup.sh` re-applies `chown -R vscode:vscode` to
the workspace, `/opt/pi-npm-store`, and `/home/vscode/.pi` on every (re)build,
since the extension store is recreated root-owned each build.

## Overview & Terminology

This setup keeps two separate devcontainers connected via a shared host directory. Pi runs in the harness container and executes commands in the project container via `docker exec`.

Before diving in, let's establish our core jargon so terms are used consistently:

* **Host Machine (or Host):** Your physical computer's operating system (macOS, Linux, Windows) where Docker/Podman and your code repositories live.
* **Harness Container (`base_pi`):** The container running the Pi AI assistant, Node.js, and management scripts. It acts as the "controller."
* **Project Container (`congruent_roster`):** The isolated container running the specific project's runtime (e.g., Python) and dependencies. It acts as the "target environment."
* **Bind Mount:** The Docker mechanism that maps a directory on the Host Machine into both containers simultaneously, ensuring file synchronization.

```
┌─────────────────────────────┐     ┌─────────────────────────────┐
│  base_pi (Harness Container)│     │  congruent_roster (Project Container)│
│                             │     │                             │
│  ┌───────────────────────┐  │     │  ┌───────────────────────┐  │
│  │ pi + Node.js          │  │     │  │ Python only           │  │
│  │ (no project code)     │  │     │  │ (no pi, no Node.js)   │  │
│  └───────────┬───────────┘  │     │  └───────────┬───────────┘  │
│              │ shared path  │     │              │ shared path  │
│              │◄─────────────┼─────┼──────────────►│             │
│              │              │     │              │              │
│  pi-run ────►│ docker exec  │     │              │              │
│              │              │     │              │              │
└──────────────┼──────────────┘     └───────────────┼─────────────┘
               │                                    │
               └────────────────────────────────────┘
                     /var/run/docker.sock (ro)
                     (Controlled via Host Docker Daemon)

```

## Why This Pattern

* **Clean project environment** — the project container contains only what the project needs (Python, no Node.js, no pi artifacts).
* **Reproducible harness** — `base_pi` serves as a single source of truth for pi configuration, extensions, and skills across multiple projects.
* **Separate git repos** — each repository tracks its own code independently.
* **Pi controls the project** — pi can read/write project files locally via the bind-mount and execute commands in the project container via `docker exec`.

## Prerequisites

* Docker or Podman installed and running on the **Host Machine**.
* VS Code with the Dev Containers extension.
* Two local repositories structured as siblings on the **Host Machine's** filesystem:
```
~/workspaces/
├── base_pi/          ← Pi harness repository
└── congruent_roster/       ← Project code repository

```



---

## Step 1: Set Up the Project Devcontainer (`congruent_roster`)

The project devcontainer provides a clean, minimal Python environment with **no pi installed**.

### `congruent_roster/.devcontainer/Dockerfile`

```dockerfile
FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends \
        curl \
        python3 \
        python3-pip \
        python3-venv \
        git \
        bash \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user (matches host UID/GID if needed)
ARG USER_UID=1000
ARG USER_GID=1000
RUN groupadd --gid $USER_GID developer \
    && useradd --uid $USER_UID --gid $USER_GID -m developer
USER developer

WORKDIR /workspaces/congruent_roster

```

### `congruent_roster/.devcontainer/devcontainer.json`

```json
{
  "name": "Project Python",
  "build": {
    "context": ".",
    "dockerfile": "Dockerfile"
  },
  "remoteUser": "developer",
  "workspaceFolder": "/workspaces/congruent_roster",
  "customizations": {
    "vscode": {
      "extensions": []
    }
  },
  "containerEnv": {
    "PYTHONPATH": "/workspaces/congruent_roster"
  }
}

```

**Key Points:**

* No Node.js, no pi, and no references to `base_pi`.
* Contains only project-specific runtimes (Python and pip).
* Maintains its own independent Git repository history.

---

## Step 2: Configure `base_pi` for Cross-Container Access

The harness container (`base_pi`) requires three pieces to interact with the project container:

1. **A docker CLI inside the harness** — the `docker` client binary must be installed in the harness container. The devcontainer image does **not** include it by default; add it to the harness Dockerfile:

   ```dockerfile
   # base_pi/.devcontainer/Dockerfile (addition)
   RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
       && apt-get -y install --no-install-recommends docker.io \
       && rm -rf /var/lib/apt/lists/*
   ```

   (`docker.io` installs the client; the socket below does the talking.)

2. **Docker socket access** — allowing the harness container to talk to the Host Machine's Docker daemon and run `docker exec`.
3. **Shared bind-mount** — allowing both containers to read and write to the same project files on the Host Machine.

### Modify `base_pi/.devcontainer/devcontainer.json`

Add the Docker socket mount and the project directory bind-mount:

```json
{
  "name": "Ubuntu & Node (Harness)",
  "build": {
    "context": ".",
    "dockerfile": "Dockerfile"
  },
  "remoteUser": "root",
  "mounts": [
    "source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind",
    "source=${localEnv:HOME}/workspaces/congruent_roster,target=/workspaces/congruent_roster,type=bind"
  ],
  "runArgs": [],
  "features": {
    "ghcr.io/devcontainers/features/node:1": {
      "version": "26"
    }
  },
  "postCreateCommand": "./.devcontainer/setup.sh",
  "customizations": {
    "vscode": {
      "extensions": []
    }
  },
  "containerEnv": {
    "GEMINI_API_KEY": "${localEnv:GEMINI_API_KEY}",
    "OPENROUTER_API_KEY": "${localEnv:OPENROUTER_API_KEY}",
    "INCEPTION_API_KEY": "${localEnv:INCEPTION_API_KEY}",
    "GH_TOKEN": "${localEnv:GITHUB_PAT_TOKEN}",
    "GH_USER": "${localEnv:GITHUB_USERNAME}",
    "PI_LLM_DEBUGGING_FOOTER": "0",
    "XDG_CONFIG_HOME": "/workspaces/base_pi/.pi",
    "NOVITA_API_KEY": "${localEnv:NOVITA}",
    "PULSE_SERVER": "tcp:host.docker.internal:4713",
    "DOCKER_HOST": "unix:///var/run/docker.sock"
  }
}

```

**Configuration Breakdown:**

| Addition | Purpose |
| --- | --- |
| `docker.sock` mount | Allows the harness container to command the Host Machine's Docker daemon. |
| `congruent_roster` bind mount | Exposes project source code inside the harness container filesystem. |
| `DOCKER_HOST` env var | Directs Docker CLI tools inside the harness container to the mounted socket. |

> **`--network=host`:** earlier drafts added this to `runArgs`. It is **not** required for this pattern (
`docker exec` goes over the socket, not the network namespace) and is legacy cruft; keep 
`runArgs` empty unless a project specifically needs host networking. It is therefore omitted above.

---

## Adding More Projects

`congruent_roster` is the worked example. To wire up **another** project `other-project`:

1. Add one `mounts` line in the harness `devcontainer.json` for its host path:
   `"source=${localEnv:HOME}/workspaces/other-project,target=/workspaces/other-project,type=bind"` (one mount entry per project — this array is the only per-project part of the harness config).
2. Run `pi-projects register other-project <container-name> /workspaces/other-project`.
3. Use `pi-run other-project <command>` and read/write files at `/workspaces/other-project`.

The registry (`projects.json`) is dynamic and unbounded; only the `mounts` array grows by one line per project. `pi-projects list` shows all registered projects and their running state.

> **Security Note:** Mounting the Docker socket grants root-equivalent control over the **Host Machine's** containers. Since this is a personal local development harness, this is an intentional convenience trade-off.

---

## Step 3: Create the `pi-run` Helper Script

The `pi-run` script wraps `docker exec`, letting pi execute commands inside the project container without needing to manually specify container IDs or full paths.

### `base_pi/.pi/scripts/pi-run`

```bash
#!/bin/bash
# pi-run: Execute a command inside the project devcontainer
#
# Usage:
#   pi-run <container-name> <command...>
#
# Examples:
#   pi-run congruent_roster python -m pytest
#   pi-run congruent_roster pip install -e .
#   pi-run congruent_roster python src/main.py
#
# Prerequisite: The project container must be running (opened in VS Code).

set -e

CONTAINER_NAME="$1"
shift

if [ -z "$CONTAINER_NAME" ]; then
  echo "Error: no container name specified" >&2
  echo "Usage: pi-run <container-name> <command...>" >&2
  exit 1
fi

# Check if the target container is running
if ! docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q 'true'; then
  echo "Error: container '$CONTAINER_NAME' is not running" >&2
  echo "Open the project in VS Code to start its devcontainer first." >&2
  exit 1
fi

# Execute the command inside the project container
docker exec -w /workspaces/congruent_roster "$CONTAINER_NAME" "$@"

```

Make the script executable:

```bash
chmod +x base_pi/.pi/scripts/pi-run

```

### Exposing `pi-run` on the PATH

Update `base_pi/.devcontainer/setup.sh` to symlink the script globally inside the harness container:

```bash
# Make pi-run available globally on PATH within the harness container
ln -sf /workspaces/base_pi/.pi/scripts/pi-run /usr/local/bin/pi-run

```

---

## Step 4: Configure Pi Instructions (`AGENTS.md`)

Add guidelines to `base_pi/AGENTS.md` so the AI assistant understands how to interface with the project container:

```markdown
## Project Container Workflow

The project code resides in a separate project container (`congruent_roster`). Pi operates from the harness container and does not run inside the project container directly.

*   **To execute commands** (tests, builds, scripts) in the project container, use:
    ```bash
    pi-run congruent_roster <command>
    ```
    *Examples:*
    * `pi-run congruent_roster python -m pytest`
    * `pi-run congruent_roster pip install -e .`

*   **To read or write project files** directly (no container execution needed):
    * Access `/workspaces/congruent_roster`. Pi has full read/write file access via the shared bind-mount.

```

---

## Day-to-Day Workflow

1. **Start the Session:** Open `congruent_roster` in a VS Code window (spins up the **Project Container**). Open `base_pi` in a separate VS Code window (spins up the **Harness Container**).
2. **Execute Code/Tests:** Ask pi to run tests; it will automatically delegate execution via `pi-run congruent_roster python -m pytest`.
3. **Edit Files:** Ask pi to create code files; it writes them directly to `/workspaces/congruent_roster/`, which instantly syncs to the project container via the bind-mount.
4. **Stop the Session:** Close both VS Code windows to gracefully shut down both containers.

---

## Troubleshooting

* **`docker exec` fails with "permission denied":** Verify that `/var/run/docker.sock` is properly listed under `mounts` in `base_pi`'s `devcontainer.json`.
* **Project files appear empty:** Ensure the Host Machine path in the `mounts` array matches the absolute path to your local project sibling directory.
* **`pi-run` reports container is not running:** Ensure the project's VS Code window is active so the project container is currently running.

---

## Stable Container Resolution (pinned name vs label lookup)

`pi-projects` / `pi-run` resolve a project alias to a container. Three ways to
key that resolution, in order of how much setup they need:

1. **Random name (default, fragile):** VS Code assigns a random Docker name
   (`relaxed_gould`) that changes on every rebuild. The registry entry goes
   stale and `pi-run` breaks until you re-`register`.
2. **Pinned name (chosen — see `congruent_roster`):** add
   `"runArgs": ["--name=congruent_roster"]` to the project's `devcontainer.json`.
   The **`name` field is only a UI label**; `--name` is what sets the real Docker
   name. Registry stays valid across rebuilds. Caveat: an existing stale
   container with the same name blocks the next `docker run` (remove it first).
3. **Label lookup (alternative if a name ever causes trouble):** do not trust the
   name at all — resolve by a Docker metadata filter instead:
   ```bash
   docker ps -q --filter label=devcontainer.local_folder="<host-folder>"
   docker exec "$(docker ps -q --filter label=devcontainer.local_folder="...congruent_roster")" <cmd>
   ```
   Every devcontainer carries `devcontainer.local_folder=<host-path>` (and
   similar labels), so this survives renames and rebuilds with no config change;
   it only needs `pi-run`/`pi-projects` to look up by label rather than by the
   registry's container name. Edge case: two windows open on the same folder
   would match more than one container.

> **Note (Sep 2025):** `congruent_roster` currently uses the *pinned name*
> (`runArgs --name`). If a rebuild ever fails with a name conflict, or a rename
> breaks the registry again, prefer falling back to the label lookup above over
> re-pinning/re-registering. There is no first-class `containerName` property in
> the devcontainer spec yet (vscode-remote-release#2485), so `runArgs` is the
> community-standard way to pin.

Switching the harness-side management tools to Node.js aligns perfectly with your `base_pi` environment (which already includes Node 26).

Here is the Node.js implementation for `pi-projects`. It functions both as a CLI tool and as a native module providing the `what_projects()` API for Pi extensions.

---

## Step 5: Implement the Node.js Project Registry (`pi-projects.js`)

Create this script at `base_pi/.pi/scripts/pi-projects.js`. It uses only built-in Node modules (`fs`, `path`, `child_process`), requiring zero external dependencies or `npm install` steps.

### `base_pi/.pi/scripts/pi-projects.js`

```javascript
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REGISTRY_PATH = path.join('/workspaces/base_pi/.pi', 'projects.json');

function loadRegistry() {
    if (!fs.existsSync(REGISTRY_PATH)) {
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    } catch (e) {
        return {};
    }
}

function saveRegistry(registry) {
    const dir = path.dirname(REGISTRY_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf8');
}

/**
 * API function to programmatically discover all registered projects.
 * Can be imported into custom Pi Node.js extensions.
 */
function what_projects() {
    return loadRegistry();
}

module.exports = { what_projects };

// --- CLI Handling ---
if (require.main === module) {
    const args = process.argv.slice(2);
    const command = args[0];
    const subArgs = args.slice(1);

    if (!command) {
        console.error("Usage: pi-projects <register|deregister|list> [args...]");
        process.exit(1);
    }

    if (command === 'register') {
        const [alias, containerName, customPath] = subArgs;
        if (!alias || !containerName) {
            console.error("Error: Missing arguments.");
            console.error("Usage: pi-projects register <alias> <container-name> [path]");
            process.exit(1);
        }
        const registry = loadRegistry();
        registry[alias] = {
            container: containerName,
            path: customPath || `/workspaces/${alias}`
        };
        saveRegistry(registry);
        console.log(`Successfully registered project: '${alias}' -> container '${containerName}'`);
    } 
    else if (command === 'deregister') {
        const alias = subArgs[0];
        if (!alias) {
            console.error("Error: Missing project alias.");
            console.error("Usage: pi-projects deregister <alias>");
            process.exit(1);
        }
        const registry = loadRegistry();
        if (registry[alias]) {
            delete registry[alias];
            saveRegistry(registry);
            console.log(`Deregistered project: '${alias}'`);
        } else {
            console.error(`Error: Project '${alias}' not found in registry.`);
            process.exit(1);
        }
    } 
    else if (command === 'list') {
        const registry = loadRegistry();
        if (subArgs.includes('--json')) {
            console.log(JSON.stringify(registry, null, 2));
            process.exit(0);
        }
        if (Object.keys(registry).length === 0) {
            console.log("No projects currently registered.");
            process.exit(0);
        }
        console.log(`${'PROJECT ALIAS'.padEnd(20)} ${'CONTAINER NAME'.padEnd(20)} ${'PATH'.padEnd(30)} STATUS`);
        console.log('-'.repeat(80));
        for (const [alias, info] of Object.entries(registry)) {
            let isRunning = false;
            try {
                const res = execSync(`docker inspect -f '{{.State.Running}}' ${info.container}`, { encoding: 'utf8' });
                isRunning = res.trim() === 'true';
            } catch (e) {
                isRunning = false;
            }
            const status = isRunning ? '\x1b[32mRunning\x1b[0m' : '\x1b[31mStopped\x1b[0m';
            console.log(`${alias.padEnd(20)} ${info.container.padEnd(20)} ${info.path.padEnd(30)} ${status}`);
        }
    } 
    else {
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
}

```

Make it executable and expose it on the harness container's `PATH`:

```bash
chmod +x base_pi/.pi/scripts/pi-projects.js

```

Add this line to your `base_pi/.devcontainer/setup.sh`:

```bash
ln -sf /workspaces/base_pi/.pi/scripts/pi-projects.js /usr/local/bin/pi-projects

```

---

## Step 6: Using `what_projects()` in Custom Node.js Pi Extensions

Because this script exports `what_projects()`, any custom Pi JavaScript or TypeScript extension can programmatically discover available project targets natively without shelling out:

```javascript
const { what_projects } = require('./pi-projects.js');

function inspectWorkspace() {
    const projects = what_projects();
    for (const [alias, details] of Object.entries(projects)) {
        console.log(`Found project alias: ${alias}, targeting container: ${details.container}`);
    }
}

```

---

## Step 7: Updating `pi-run` to Coordinate with Node

You can also update `pi-run` to read the JSON registry via a quick Node snippet, ensuring the entire stack relies on JavaScript-native JSON parsing:

### `base_pi/.pi/scripts/pi-run`

```bash
#!/bin/bash
# pi-run: Execute a command inside a registered project devcontainer

set -e

PROJECT_ALIAS="$1"
shift

if [ -z "$PROJECT_ALIAS" ]; then
  echo "Error: no project alias specified" >&2
  echo "Usage: pi-run <project-alias> <command...>" >&2
  exit 1
fi

REGISTRY_PATH="/workspaces/base_pi/.pi/projects.json"

# Resolve container name and path using Node
RESOLVED=$(node -e '
const fs = require("fs");
const alias = process.argv[1];
const regPath = process.argv[2];
if (fs.existsSync(regPath)) {
    try {
        const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
        if (reg[alias]) {
            console.log(`${reg[alias].container}|${reg[alias].path}`);
            process.exit(0);
        }
    } catch(e) {}
}
console.log(`${alias}|/workspaces/${alias}`);
' "$PROJECT_ALIAS" "$REGISTRY_PATH")

CONTAINER_NAME=$(echo "$RESOLVED" | cut -d'|' -f1)
PROJECT_PATH=$(echo "$RESOLVED" | cut -d'|' -f2)

# Verify container running state
if ! docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q 'true'; then
  echo "Error: container '$CONTAINER_NAME' (alias: '$PROJECT_ALIAS') is not running" >&2
  echo "Open the project in VS Code to start its devcontainer first." >&2
  exit 1
fi

# Execute command inside target container
docker exec -w "$PROJECT_PATH" "$CONTAINER_NAME" "$@"

```

Don't forget to make `pi-run` executable:

```bash
chmod +x base_pi/.pi/scripts/pi-run
ln -sf /workspaces/base_pi/.pi/scripts/pi-run /usr/local/bin/pi-run

```