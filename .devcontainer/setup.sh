#!/usr/bin/env bash
set -e
exec > >(tee /workspaces/base_pi/setup_debug.log) 2>&1
export COLUMNS=120
export LINES=40
clear

echo -e "\n=============================================="
echo " [setup] Initializing"

# Marker (PID file): lets postStartCommand (healthcheck.sh) know setup.sh is still
# running so it can wait instead of racing the store population on first
# start. A PID file (not a bare flag) lets the healthcheck ignore stale markers
# left by a SIGKILLed setup -- the EXIT trap can't run on SIGKILL, but a dead
# PID is detected immediately, so connect-only starts never wait.
SETUP_MARKER=/tmp/pi-store-setup-running
trap 'rm -f "$SETUP_MARKER"' EXIT
echo $$ > "$SETUP_MARKER"

# disable closing the terminal on Ctrl+D (unless repeated 10x times)
if ! grep -q "IGNOREEOF" ~/.bashrc; then
    echo "export IGNOREEOF=10" >> ~/.bashrc
fi

apt-get update

echo "[setup] Installing GitHub CLI..."
if ! command -v gh &> /dev/null; then
    sudo apt-get install -o Dpkg::Use-Pty=0 -y gh
fi

echo "[setup] APT PACKAGES INSTALL COMPLETE"

echo "[setup] Installing Pi.dev agent (pinned for reproducible rebuilds)..."
npm install -g --allow-scripts=@google/genai,protobufjs,koffi @earendil-works/pi-coding-agent@0.85.1

echo "[setup] Trusting project..."
mkdir -p ~/.pi/agent

if [ ! -f ~/.pi/agent/trust.json ]; then
  cat <<'EOF' >~/.pi/agent/trust.json
{
  "/workspaces/base_pi": true
}
EOF
fi

echo "[setup] Installing Pi.dev extensions from pinned .pi/settings.json..."

# --- Container-native extension store (performance) ---
#
# WHY: the workspace (.pi/...) is a 9p bind mount from the Windows host
# (drvfs via Docker Desktop). Reading/writing node_modules there is the slow
# path for every `pi` invocation (extension loading) and for npm install.
# /opt/pi-npm-store lives on the container's own overlayfs, so extension
# packages land on fast native disk. We symlink the PARENT dirs (.pi/npm and
# .pi/git/github.com) -- NOT node_modules itself -- because npm's install
# engine (arborist) deletes a symlinked node_modules and recreates a real dir
# ("Removing non-directory"), and `git clean -fdx` removes it on ref changes.
# Symlinking the parents keeps the symlink out of pi's/npm's/git's way
# (pi's path guard is lexical; git clone/fetch/reset/clean all operate inside
# the store), while all writes flow onto container-native storage.
#
# Store is container-layer (not a volume, per project constraint): wiped on
# rebuild, but each rebuild reinstalls deterministically anyway, so the win is
# pure I/O speed, matching this setup's "deterministic reconcile" philosophy.
#
# NOTE for agents: `.pi/npm` and `.pi/git/github.com` ARE SYMLINKS into
# /opt/pi-npm-store. Do NOT replace them with physical dirs and never
# `rm -rf` INTO them from the workspace side -- rm -rf on the symlink itself
# only removes the link, which is safe, but deleting the store contents
# directly (`rm -rf /opt/pi-npm-store/*`) is the intended reconcile path.
STORE=/opt/pi-npm-store
WS=/workspaces/base_pi

mkdir -p "$STORE/npm" "$STORE/git/github.com"
# Drop previous links OR physical dirs (idempotent on re-run; a symlink
# rm -rf removes only the link and never follows into the store, and a
# pre-existing physical dir is exactly what we must replace)
rm -rf "$WS/.pi/npm" "$WS/.pi/git/github.com"
ln -s "$STORE/npm"          "$WS/.pi/npm"
ln -s "$STORE/git/github.com" "$WS/.pi/git/github.com"

# Keep git status clean in the provisioned container: the tracked placeholder
# .pi/npm/.gitignore is now a symlink target, and the symlink itself is
# untracked+ignored (root .gitignore). skip-worktree is index-local (NOT
# cloned), so re-apply it every build. .pi/git/github.com needs none: it is
# covered by the committed .pi/git/.gitignore "*" rule.
git update-index --skip-worktree .pi/npm/.gitignore 2>/dev/null || true

# Deterministic reconcile: drop the (gitignored, potentially corrupted) package
# trees and rebuild them strictly from the pinned specs in .pi/settings.json.
# Pinned npm versions and git refs are skipped by updates, so this converges
# to the committed manifest on every rebuild / fresh clone.
# Clean the STORE contents, not the workspace symlinks: `pi update`'s git paths
# (installGit/updateGit) self-heal by cloning into whatever exists behind the
# symlink, but npm needs a clean prefix (updateNpmBatch does no pre-clean and
# npm can't see versions dropped from the store).
rm -rf "$STORE/npm"/*
# Clean the contents of github.com instead of deleting the directory
rm -rf "$STORE/git/github.com/"*
pi update --extensions --approve
git config --global user.email "nirgrahamuk@gmail.com"
git config --global user.name "nirguk"

echo "[setup] Pi.dev environment ready."
