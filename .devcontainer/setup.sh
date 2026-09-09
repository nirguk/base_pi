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
# Pinned project npm packages: install deterministically, then verify.
#
# WHY not just "pi update": `pi update` reconciles git extension sources
# synchronously, but its install of the project npm store ($STORE/npm) is
# asynchronous and unreliable -- observed to keep flushing in the background
# for 20s-2min+ after the command returned, and on fresh rebuilds to not
# install the project npm packages at all. Polling that hidden tail with a
# hard timeout is a race, not a fix. So we (1) install the pinned project npm
# packages ourselves, synchronously (~15-20s for the pinned set), then (2)
# verify the store is genuinely populated and quiescent before writing the
# completion flag. The flag must only ever promise "everything is in place".
#
# NPM_SPECS_SCRIPT emits one spec per line, e.g. "npm:pi-web-access@0.28.0"
# (npm specs only; git pins are already HEAD-resolved synchronously).
NPM_SPECS_SCRIPT="const s=require('$WS/.pi/settings.json');for(const p of s.packages||[]){const src=typeof p==='string'?p:(p&&p.source);if(src&&src.startsWith('npm:'))console.log(src)}"

MAX_WAIT=120      # verification backstop (s); install is now explicit+sync upfront
POLL=2            # poll interval (s)
STABLE_ROUNDS=3   # consecutive stable polls required before declaring done

# One verification round: echo the set of pinned npm specs that do NOT yet
# resolve at their pinned version from the store (empty string = all present).
# Emits one spec per line, e.g. "npm:pi-web-access@0.28.0" (npm specs only;
# git pins are already HEAD-resolved synchronously by `pi update`).
unresolved_of() {
  local out="" spec name ver got
  while IFS= read -r spec; do
    [ -z "$spec" ] && continue
    case "$spec" in
      npm:*)
        name=${spec#npm:}; name=${name%@*}
        ver=${spec##*@}
        got=$(node -p "try{require('$STORE/npm/node_modules/$name/package.json').version}catch(e){''}" 2>/dev/null)
        if [ -z "$got" ] || [ "$got" != "$ver" ]; then
          out="$out $name@$ver(installed:${got:-missing})"
        fi
        ;;
    esac
  done < <(node -e "$NPM_SPECS_SCRIPT" 2>/dev/null)
  printf '%s' "$out"
}

# --- Deterministic install of the pinned project npm packages ---
# `pi update` skips pinned npm sources in its own update pass, so these are
# never installed synchronously by it. Install them explicitly now: a direct
# npm install is fully synchronous and deterministic (the async flush we
# previously raced is bypassed entirely).
PROJECT_NPM_SPECS=$(printf '%s' "$(node -e "$NPM_SPECS_SCRIPT" 2>/dev/null)" | sed -n 's#^npm:##p' | tr '\n' ' ')
if [ -n "$PROJECT_NPM_SPECS" ]; then
  echo "[setup] Installing pinned project npm packages: $PROJECT_NPM_SPECS"
  # shellcheck disable=SC2086  # tokens are intentionally split into npm args
  ( cd "$STORE/npm" && npm install --no-audit --no-fund $PROJECT_NPM_SPECS )
fi

# Verification belt (bounded): the explicit install above already puts
# everything in place, so this just confirms the store is genuinely populated
# and quiescent (lockfile stable for STABLE_ROUNDS polls) before we write the
# completion flag -- guarding against a residual flush from a concurrent
# `pi` process or a stale store from a previous failed run.
start_ts=$(date +%s)
unresolved=""
stable=0
lock_mtime_first=0
while :; do
  mtime=$(stat -c %Y "$STORE/npm/package-lock.json" 2>/dev/null || echo 0)
  if [ "$mtime" != "0" ] && [ "$mtime" = "$lock_mtime_first" ]; then
    stable=$((stable+1))
  elif [ "$mtime" != "0" ]; then
    stable=1
  else
    stable=0   # lockfile not written yet -- install still in flight
  fi
  lock_mtime_first=$mtime

  unresolved=$(unresolved_of)
  [ -z "$unresolved" ] && [ "$stable" -ge "$STABLE_ROUNDS" ] && break
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
