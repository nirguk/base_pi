# Cross-Container Workflow: Pi Harness + Project Devcontainer

## Overview

This setup keeps two separate devcontainers — one for the pi harness, one for project code — connected via a shared Docker volume. Pi runs in the harness container and executes commands in the project container via `docker exec`.

```
┌─────────────────────────────┐     ┌─────────────────────────────┐
│  base_pi (pi harness)       │     │  my-project (code)          │
│                             │     │                             │
│  ┌───────────────────────┐  │     │  ┌───────────────────────┐  │
│  │ pi + Node.js          │  │     │  │ Python only           │  │
│  │ (no project code)     │  │     │  │ (no pi, no Node.js)   │  │
│  └───────────┬───────────┘  │     │  └───────────┬───────────┘  │
│              │ shared volume│     │              │ shared volume │
│              │◄─────────────┼─────┼──────────────►│              │
│              │              │     │              │               │
│  pi-run ────►│ docker exec  │     │              │               │
│              │              │     │              │               │
└──────────────┼──────────────┘     └───────────────┼─────────────┘
               │                                      │
               │  /var/run/docker.sock (ro)          │
               └──────────────────────────────────────┘
                        (host Docker daemon)
```

## Why This Pattern

- **Clean project environment** — the project container has only what the project needs (Python, no Node.js, no pi artifacts)
- **Reproducible harness** — base_pi is the single source of truth for pi configuration, extensions, and skills
- **Separate git repos** — each repo tracks its own code independently
- **Pi controls the project** — pi can read/write project files and execute commands in the project container

## Prerequisites

- Docker or Podman running on the host
- VS Code with the Dev Containers extension
- Two repos: `base_pi` (pi harness) and `my-project` (project code)
- Both repos are cloned as siblings on the host filesystem

```
~/workspaces/
├── base_pi/          ← pi harness repo
└── my-project/       ← project code repo
```

---

## Step 1: Set Up the Project Devcontainer (`my-project`)

The project devcontainer is a clean, minimal Python environment with **no pi installed**.

### `my-project/.devcontainer/Dockerfile`

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

# Create a non-root user (match host UID/GID if needed)
ARG USER_UID=1000
ARG USER_GID=1000
RUN groupadd --gid $USER_GID developer \
    && useradd --uid $USER_UID --gid $USER_GID -m developer
USER developer

WORKDIR /workspaces/my-project
```

### `my-project/.devcontainer/devcontainer.json`

```json
{
  "name": "Project Python",
  "build": {
    "context": ".",
    "dockerfile": "Dockerfile"
  },
  "remoteUser": "developer",
  "workspaceFolder": "/workspaces/my-project",
  "customizations": {
    "vscode": {
      "extensions": []
    }
  },
  "containerEnv": {
    "PYTHONPATH": "/workspaces/my-project"
  }
}
```

**Key points:**
- No Node.js, no pi, no base_pi references
- Only Python and pip — whatever the project needs
- The container has its own independent git repo

---

## Step 2: Configure `base_pi` for Cross-Container Access

The base_pi devcontainer needs two additions:
1. **Docker socket access** — so pi can `docker exec` into the project container
2. **Shared volume** — so both containers see the same project files

### Modify `base_pi/.devcontainer/devcontainer.json`

Add the Docker socket mount and a bind mount for the project directory:

```json
{
  "name": "Ubuntu & Node (Cached)",
  "build": {
    "context": ".",
    "dockerfile": "Dockerfile"
  },
  "remoteUser": "root",
  "mounts": [
    "source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind",
    "source=${localEnv:HOME}/workspaces/my-project,target=/workspaces/my-project,type=bind"
  ],
  "runArgs": [
    "--network=host"
  ],
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

**What changed:**

| Addition | Purpose |
|----------|---------|
| `docker.sock` mount | Pi can call `docker exec` on host containers |
| `my-project` bind mount | Project files are visible inside base_pi's container |
| `--network=host` | Pi can reach the project container by name on the host network |
| `DOCKER_HOST` env var | Tools inside the container know where Docker is |

**Security note:** Mounting the Docker socket gives pi the ability to create, stop, and enter any container on the host. Since this is your personal harness, this is an intentional trade-off.

---

## Step 3: Create the `pi-run` Helper Script

`pi-run` wraps `docker exec` so pi can run commands in the project container without knowing the container name or path details.

### `base_pi/.pi/scripts/pi-run`

```bash
#!/bin/bash
# pi-run: Execute a command inside the project devcontainer
#
# Usage:
#   pi-run <container-name> <command...>
#
# Examples:
#   pi-run my-project python -m pytest
#   pi-run my-project pip install -e .
#   pi-run my-project python src/main.py
#
# The container must be running (opened in VS Code as a devcontainer).

set -e

CONTAINER_NAME="$1"
shift

if [ -z "$CONTAINER_NAME" ]; then
  echo "Error: no container name specified" >&2
  echo "Usage: pi-run <container-name> <command...>" >&2
  exit 1
fi

# Check if the container is running
if ! docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q 'true'; then
  echo "Error: container '$CONTAINER_NAME' is not running" >&2
  echo "Open the project in VS Code to start its devcontainer first." >&2
  exit 1
fi

# Execute the command inside the container
docker exec -w /workspaces/my-project "$CONTAINER_NAME" "$@"
```

Make it executable:

```bash
chmod +x base_pi/.pi/scripts/pi-run
```

### How pi discovers `pi-run`

Add `pi-run` to pi's PATH by ensuring it's in a directory that's on the container's PATH. Since base_pi's devcontainer runs as root and `/workspaces/base_pi` is the workspace, you can either:

1. **Symlink it into a PATH directory** (add to `setup.sh`):
   ```bash
   ln -sf /workspaces/base_pi/.pi/scripts/pi-run /usr/local/bin/pi-run
   ```

2. **Or reference it directly** in pi's instructions (AGENTS.md):
   ```
   To run commands in the project container, use:
   /workspaces/base_pi/.pi/scripts/pi-run <container-name> <command>
   ```

Option 1 is cleaner. Add it to `base_pi/.devcontainer/setup.sh`:

```bash
# ... existing setup.sh content ...

# Make pi-run available on PATH
ln -sf /workspaces/base_pi/.pi/scripts/pi-run /usr/local/bin/pi-run
```

---

## Step 4: Configure Pi to Use `pi-run`

Add instructions to `base_pi/AGENTS.md` so pi knows how to execute commands in the project container:

```markdown
## Project Container

The project code lives in a separate devcontainer (`my-project`) for a clean,
minimal Python environment. Pi does not run inside that container.

To execute commands in the project container, use:

    pi-run my-project <command>

Examples:
    pi-run my-project python -m pytest
    pi-run my-project pip install -e .
    pi-run my-project python src/main.py

To read or write project files directly (no container exec needed):
    The project files are bind-mounted at /workspaces/my-project.
    Read/write files there directly — pi has full access.
```

---

## Day-to-Day Workflow

### Starting a session

1. **Open `my-project` in VS Code** → its devcontainer builds → the project container starts running
2. **Open `base_pi` in a second VS Code window** → its devcontainer builds → pi is available
3. Pi can now see `/workspaces/my-project` (bind-mounted) and run commands in the project container via `pi-run`

### Working with pi on project code

```
You: "run the tests in my-project"
Pi:  pi-run my-project python -m pytest
```

```
You: "create a new module in my-project"
Pi:  (writes files directly to /workspaces/my-project/src/new_module.py)
```

```
You: "install the project dependencies"
Pi:  pi-run my-project pip install -e .
```

### Stopping a session

1. Close the `my-project` VS Code window → project container stops
2. Close the `base_pi` VS Code window → pi harness container stops

### When the project container is not running

If you try `pi-run my-project ...` and the container is stopped, pi-run returns an error:

```
Error: container 'my-project' is not running
Open the project in VS Code to start its devcontainer first.
```

Pi should ask you to start the project container before retrying.

---

## Multiple Projects

If you work on multiple projects, each gets its own devcontainer. The `pi-run` script works the same way — just use the correct container name:

```bash
pi-run project-alpha python -m pytest
pi-run project-bash python manage.py runserver
```

Container names default to the directory name of the project repo. You can override by setting an env var in `devcontainer.json`:

```json
{
  "containerEnv": {
    "PI_CONTAINER_NAME": "my-custom-name"
  }
}
```

Then `pi-run` reads `PI_CONTAINER_NAME` as a fallback:

```bash
CONTAINER_NAME="${PI_CONTAINER_NAME:-$1}"
```

---

## Troubleshooting

### `docker exec` fails with "permission denied"

The Docker socket mount may not be accessible inside the container. Verify:

```bash
# Inside base_pi's container:
ls -la /var/run/docker.sock
docker ps
```

If `docker ps` fails, the socket isn't mounted correctly. Check `devcontainer.json` → `mounts`.

### Project files are not visible at `/workspaces/my-project`

The bind mount path in `devcontainer.json` must match the actual host path. Verify:

```bash
# Inside base_pi's container:
ls /workspaces/my-project
```

If empty, the host path `${localEnv:HOME}/workspaces/my-project` doesn't exist or is wrong. Update the mount in `devcontainer.json`.

### `pi-run` says container is not running

The project's VS Code window must be open so its devcontainer is running. Open the project in VS Code first, then retry.

### Python commands fail inside the project container

The project container may not have the required packages installed. Run `pi-run my-project pip install -e .` first, or ensure `requirements.txt` is installed in the container.

### File changes don't sync between containers

Both containers must mount the **same host directory** to the **same container path**. Check that the bind mount in `base_pi` and the workspace folder in `my-project`'s devcontainer point to the same host path.

---

## Security Considerations

| Risk | Mitigation |
|------|-----------|
| Docker socket gives container escape | You own the host; this is intentional |
| Pi can stop/create containers | `pi-run` only execs into named containers |
| Project files writable by both containers | Use git to track changes; review before committing |
| Container name collisions | Use unique, descriptive container names per project |
```}