FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

# Install baseline dependencies
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends \
        curl \
        unzip \
        bash \
        ca-certificates \
        docker.io \
    && rm -rf /var/lib/apt/lists/*

# uv (Astral) package manager, pinned to 0.12.12 — the same version the
# congruent_roster project container runs. UV_INSTALL_DIR installs
# system-wide (all users); UV_NO_MODIFY_PATH=1 skips shell-rc edits since
# /usr/local/bin is already on PATH.
RUN curl -LsSf https://astral.sh/uv/0.12.12/install.sh \
    | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh

# Native venv store for the harness's own Python tooling (harnesskit et al.):
# on overlayfs (/opt), not the host 9p/drvfs bind mount, for the same I/O
# reasons that moved .pi/npm to /opt/pi-npm-store. Pre-created root-owned
# then chowned to vscode; setup.sh keeps the workspace's .venv symlink to it.
RUN mkdir -p /opt/base-pi-venv && chown vscode:vscode /opt/base-pi-venv
