#!/usr/bin/env bash
set -e
exec > >(tee /workspaces/base_pi/setup_debug.log) 2>&1
export COLUMNS=120
export LINES=40
clear

echo -e "\n=============================================="
echo " [setup] Initializing"

# Completion flag (inverted liveness marker): healthcheck.sh (postStartCommand)
# treats /opt/pi-npm-store/.provisioned as "provisioning finished successfully"
# and waits for it on first start instead of racing the store population. It is
# written only as the LAST step below, so under `set -e` it can never appear on
# a failed run. Clear any pre-existing flag up front so a re-run that fails
# midway (e.g. after the store wipe) cannot leave a stale success signal.
rm -f /opt/pi-npm-store/.provisioned

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

# Silence git's "detached HEAD" advice wall: `pi update` checks out pinned
# commits/tags (intentional, read-only), so each clone/checkout would spam the
# advisory text. Set before the update so the git invocations during it pick it up.
git config --global advice.detachedHead false
pi update --extensions --approve
git config --global user.email "nirgrahamuk@gmail.com"
git config --global user.name "nirguk"

# ---------------------------------------------------------------------------
# Wait for the npm store to be genuinely populated (race hardening).
#
# WHY: `pi update` can return while part of its npm install work is still
# flushing in the background. If we write the .provisioned completion flag
# immediately, the postStart healthcheck (running back-to-back) can observe a
# not-yet-populated store and emit transient FAILs for the "npm store
# non-empty" and "npm pin X installed" checks -- observed: the npm store
# kept updating ~20s AFTER the flag was written. The flag must only promise
# "everything is truly in place", so we poll the pinned npm packages until
# they resolve at their pinned versions, bounded, and only then touch it.
#
# Emits one spec per line, e.g. "npm:pi-web-access@0.28.0" (npm specs only;
# git pins are already HEAD-resolved synchronously by `pi update`).
NPM_SPECS_SCRIPT="const s=require('$WS/.pi/settings.json');for(const p of s.packages||[]){const src=typeof p==='string'?p:(p&&p.source);if(src&&src.startsWith('npm:'))console.log(src)}"

MAX_WAIT=90   # hard bound on waiting for the store (s)
POLL=2        # poll interval (s)
start_ts=$(date +%s)
unresolved=""
while :; do
  unresolved=""
  while IFS= read -r spec; do
    [ -z "$spec" ] && continue
    case "$spec" in
      npm:*)
        name=${spec#npm:}; name=${name%@*}
        ver=${spec##*@}
        got=$(node -p "try{require('$STORE/npm/node_modules/$name/package.json').version}catch(e){''}" 2>/dev/null)
        if [ -z "$got" ] || [ "$got" != "$ver" ]; then
          unresolved="$unresolved $name@$ver(installed:${got:-missing})"
        fi
        ;;
    esac
  done < <(node -e "$NPM_SPECS_SCRIPT" 2>/dev/null)

  [ -z "$unresolved" ] && break
  [ "$(date +%s)" -ge "$(( start_ts + MAX_WAIT ))" ] && break
  sleep "$POLL"
done

if [ -n "$unresolved" ]; then
  echo "[setup] ERROR: npm store still incomplete after ${MAX_WAIT}s:${unresolved}" >&2
  echo "[setup] Not writing .provisioned (a failed run must never look provisioned); re-run ./.devcontainer/setup.sh to retry." >&2
  exit 1
fi
echo "[setup] npm store verified populated (pinned npm packages resolve)."

echo "[setup] Pi.dev environment ready."

# Completion flag: only reached if every step above succeeded (`set -e` exits
# on any failure first). Success-only by construction -- never written on a
# failed run, removed at the top if this script re-runs, and now only written
# AFTER the npm store is verified populated (see the wait loop above).
touch "$STORE/.provisioned"
