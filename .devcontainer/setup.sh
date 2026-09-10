#!/usr/bin/env bash
set -e

# Self-elevate to root when invoked as non-root. postCreateCommand runs as
# remoteUser (vscode once the harness runs as UID 1000); apt, npm install -g,
# chown and the extension-store population all need root. Dockerfile/RUN and
# already-root invocations hit `id -u == 0` and pass straight through.
if [ "$(id -u)" != "0" ]; then
  echo "[setup] not root; re-executing as root via sudo"
  exec sudo -n /workspaces/base_pi/.devcontainer/setup.sh "$@"
fi

exec > >(tee /workspaces/base_pi/setup_debug.log) 2>&1
export COLUMNS=120
export LINES=40
clear

# Export NVM & Node environment paths for both root and vscode execution
export NVM_DIR="/usr/local/share/nvm"
[ ! -d "$NVM_DIR" ] && export NVM_DIR="/home/vscode/.nvm"

if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
fi

# Fallback: manually prepend Node binary paths if nvm.sh didn't populate PATH
if ! command -v npm &>/dev/null; then
    NODE_BIN_DIR=$(find "$NVM_DIR/versions/node" -mindepth 2 -maxdepth 2 -name "bin" 2>/dev/null | tail -n 1)
    if [ -n "$NODE_BIN_DIR" ]; then
        export PATH="$NODE_BIN_DIR:$PATH"
    fi
fi

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

# ---------------------------------------------------------------------------
# 1. Configure Git authentication & identity BEFORE running pi update
# ---------------------------------------------------------------------------
if [ -n "$GH_TOKEN" ]; then
  echo "[setup] Configuring Git HTTPS authentication via GH_TOKEN..."
  git config --global url."https://${GH_TOKEN}@github.com/".insteadOf "https://github.com/"
fi

# Silence git's "detached HEAD" advice wall
git config --global advice.detachedHead false
git config --global user.email "nirgrahamuk@gmail.com"
git config --global user.name "nirguk"

# ---------------------------------------------------------------------------
# 2. Container-native extension store setup BEFORE running pi update
# ---------------------------------------------------------------------------
echo "[setup] Installing Pi.dev extensions from pinned .pi/settings.json..."

STORE=/opt/pi-npm-store
WS=/workspaces/base_pi

# Pre-create native store directories including vendor namespaces
mkdir -p "$STORE/npm" "$STORE/git/github.com/nirguk"

# Ensure workspace parent directory exists before linking
mkdir -p "$WS/.pi/git"

# Drop previous links OR physical dirs (idempotent)
rm -rf "$WS/.pi/npm" "$WS/.pi/git/github.com"

# Re-link workspace directories to native storage
ln -s "$STORE/npm"          "$WS/.pi/npm"
ln -s "$STORE/git/github.com" "$WS/.pi/git/github.com"

# Clean target store contents safely without deleting the parent folders
rm -rf "$STORE/npm"/*
rm -rf "$STORE/git/github.com/nirguk"/*

# Keep git index clean for tracked placeholders
git update-index --skip-worktree .pi/npm/.gitignore 2>/dev/null || true

# ---------------------------------------------------------------------------
# 3. Run pi update NOW that auth and storage paths are fully in place
# ---------------------------------------------------------------------------
echo "about to pi update"
pi update --extensions --approve
echo "finished pi update"

# ---------------------------------------------------------------------------
# Pinned project npm packages: install deterministically, then verify.
# ---------------------------------------------------------------------------
NPM_SPECS_SCRIPT="const s=require('$WS/.pi/settings.json');for(const p of s.packages||[]){const src=typeof p==='string'?p:(p&&p.source);if(src&&src.startsWith('npm:'))console.log(src)}"

MAX_WAIT=120      # verification backstop (s)
POLL=2            # poll interval (s)
STABLE_ROUNDS=3   # consecutive stable polls required before declaring done

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

PROJECT_NPM_SPECS=$(printf '%s' "$(node -e "$NPM_SPECS_SCRIPT" 2>/dev/null)" | sed -n 's#^npm:##p' | tr '\n' ' ')
if [ -n "$PROJECT_NPM_SPECS" ]; then
  echo "[setup] Installing pinned project npm packages: $PROJECT_NPM_SPECS"
  # shellcheck disable=SC2086
  ( cd "$STORE/npm" && npm install --no-audit --no-fund $PROJECT_NPM_SPECS )
fi

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
    stable=0
  fi
  lock_mtime_first=$mtime

  unresolved=$(unresolved_of)
  [ -z "$unresolved" ] && [ "$stable" -ge "$STABLE_ROUNDS" ] && break
  [ "$(date +%s)" -ge "$(( start_ts + MAX_WAIT ))" ] && break
  sleep "$POLL"
done

if [ -n "$unresolved" ]; then
  echo "[setup] ERROR: npm store still incomplete after ${MAX_WAIT}s:${unresolved}" >&2
  echo "[setup] Not writing .provisioned; re-run ./.devcontainer/setup.sh to retry." >&2
  exit 1
fi
echo "[setup] npm store verified populated (pinned npm packages resolve)."

# ---------------------------------------------------------------------------
# Cross-container tooling
# ---------------------------------------------------------------------------
ln -sf "$WS/.pi/scripts/pi-run" /usr/local/bin/pi-run
ln -sf "$WS/.pi/scripts/pi-projects.js" /usr/local/bin/pi-projects

# ---------------------------------------------------------------------------
# UID 1000 (vscode) ownership alignment
# ---------------------------------------------------------------------------
if [ -d "/root/.pi" ]; then
    mkdir -p /home/vscode/.pi
    cp -r /root/.pi/* /home/vscode/.pi/ 2>/dev/null || true
fi

for DIR in "$WS" /opt/pi-npm-store /home/vscode/.pi; do
    if [ -d "$DIR" ]; then
        chown -R vscode:vscode "$DIR"
    fi
done

for FILE in /usr/local/bin/pi-run /usr/local/bin/pi-projects; do
    if [ -f "$FILE" ]; then
        chown vscode:vscode "$FILE"
    fi
done

chown -R vscode:vscode /home/vscode

echo "[setup] Pi.dev environment ready."

touch "$STORE/.provisioned"