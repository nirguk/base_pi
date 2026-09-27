#!/usr/bin/env bash
set -e

# Self-elevate to root when invoked as non-root
if [ "$(id -u)" != "0" ]; then
  echo "[setup] not root; re-executing as root via sudo"
  exec sudo -n /workspaces/base_pi/.devcontainer/setup.sh "$@"
fi

# Log output directly without background process-substitution deadlocks
LOG_FILE="/workspaces/base_pi/setup_debug.log"
exec > >(tee -a "$LOG_FILE") 2>&1

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

rm -f /opt/pi-npm-store/.provisioned

# Set IGNOREEOF safely
if [ -f /home/vscode/.bashrc ] && ! grep -q "IGNOREEOF" /home/vscode/.bashrc; then
    echo "export IGNOREEOF=10" >> /home/vscode/.bashrc
fi

apt-get update

echo "[setup] Installing GitHub CLI..."
if ! command -v gh &> /dev/null; then
    apt-get install -o Dpkg::Use-Pty=0 -y gh
fi

echo "[setup] APT PACKAGES INSTALL COMPLETE"

echo "[setup] Installing Pi.dev agent (pinned for reproducible rebuilds)..."
npm install -g --allow-scripts=@google/genai,protobufjs,koffi @earendil-works/pi-coding-agent@0.87.0

echo "[setup] Trusting project..."
mkdir -p ~/.pi/agent /home/vscode/.pi/agent

if [ ! -f ~/.pi/agent/trust.json ]; then
  cat <<'EOF' >~/.pi/agent/trust.json
{
  "/workspaces/base_pi": true
}
EOF
fi

# ---------------------------------------------------------------------------
# 1. Configure Git authentication & identity
# ---------------------------------------------------------------------------
# Setup runs as root, but day-to-day git runs as vscode: auth must land in
# both configs. Identity stays editor-managed; only fill gaps so we never
# overwrite the private no-reply address VS Code already sets.
if [ -n "$GH_TOKEN" ]; then
  echo "[setup] Configuring Git HTTPS authentication via GH_TOKEN..."
  git config --global url."https://${GH_TOKEN}@github.com/".insteadOf "https://github.com/"
  sudo -u vscode git config --global url."https://${GH_TOKEN}@github.com/".insteadOf "https://github.com/" 2>/dev/null || true
fi

git config --global advice.detachedHead false
sudo -u vscode git config --global advice.detachedHead false 2>/dev/null || true
if [ -z "${GITHUB_USERNAME:-}" ]; then
  echo "[setup] ERROR: GITHUB_USERNAME is not set. Set GITHUB_USERNAME on the host before rebuilding." >&2
  exit 1
fi
if ! sudo -u vscode git config --global user.name >/dev/null 2>&1; then
  sudo -u vscode git config --global user.name "${GITHUB_USERNAME}" 2>/dev/null || true
fi
if ! sudo -u vscode git config --global user.email >/dev/null 2>&1; then
  sudo -u vscode git config --global user.email "${GITHUB_USERNAME}@users.noreply.github.com" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 2. Container-native extension store setup
# ---------------------------------------------------------------------------
echo "[setup] Installing Pi.dev extensions from pinned .pi/settings.json..."

STORE=/opt/pi-npm-store
WS=/workspaces/base_pi

# Owner namespace for git-backed extensions, from GITHUB_USERNAME (required above).
GIT_OWNER="${GITHUB_USERNAME}"

mkdir -p "$STORE/npm" "$STORE/git/github.com/$GIT_OWNER" "$WS/.pi/git"

rm -rf "$WS/.pi/npm" "$WS/.pi/git/github.com"

ln -s "$STORE/npm"           "$WS/.pi/npm"
ln -s "$STORE/git/github.com" "$WS/.pi/git/github.com"

rm -rf "$STORE/npm"/*
rm -rf "$STORE/git/github.com/$GIT_OWNER"/*

sudo -u vscode git -C "$WS" update-index --skip-worktree .pi/npm/.gitignore 2>/dev/null || true

# ---------------------------------------------------------------------------
# 3. Run pi update
# ---------------------------------------------------------------------------
echo "about to pi update"
pi update --extensions --approve
echo "finished pi update"

# ---------------------------------------------------------------------------
# Pinned project npm packages
# ---------------------------------------------------------------------------
NPM_SPECS_SCRIPT="const s=require('$WS/.pi/settings.json');for(const p of s.packages||[]){const src=typeof p==='string'?p:(p&&p.source);if(src&&src.startsWith('npm:'))console.log(src)}"

MAX_WAIT=120
POLL=2
STABLE_ROUNDS=3

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
# Harness Python tooling
# ---------------------------------------------------------------------------
if command -v uv >/dev/null 2>&1 && [ -f "$WS/pyproject.toml" ]; then
  VENV_STORE=/opt/base-pi-venv
  export UV_PYTHON_INSTALL_DIR=/opt/uv-python
  rm -f "$WS/.venv"
  if [ ! -x "$VENV_STORE/bin/python" ]; then
    uv venv "$VENV_STORE"
  fi
  ln -s "$VENV_STORE" "$WS/.venv"
  ( cd "$WS" && uv sync )
fi

# ---------------------------------------------------------------------------
# Cross-container tooling
# ---------------------------------------------------------------------------
ln -sf "$WS/.pi/scripts/pi-run" /usr/local/bin/pi-run 2>/dev/null || true
ln -sf "$WS/.pi/scripts/pi-projects.js" /usr/local/bin/pi-projects 2>/dev/null || true

# ---------------------------------------------------------------------------
# Permissions alignment
# ---------------------------------------------------------------------------
if [ -d "/root/.pi" ]; then
    cp -r /root/.pi/* /home/vscode/.pi/ 2>/dev/null || true
fi

# Only chown container-native paths recursively. 
# DO NOT chown $WS recursively across bind mounts.
# --from=root:root skips files already owned by vscode, so re-runs stay fast.
for DIR in /opt/pi-npm-store /opt/base-pi-venv /opt/uv-python /home/vscode/.pi; do
    if [ -d "$DIR" ]; then
        chown -R --from=root:root vscode:vscode "$DIR"
    fi
done

# Touch top-level workspace files only if needed, or chown without -R
chown vscode:vscode "$WS"

# Avoid recursive chown on /home/vscode if .cache/ stores thousands of extension files.
# .pi is already covered above; .bashrc is a single file.
chown --from=root:root vscode:vscode /home/vscode/.bashrc 2>/dev/null || true

for FILE in /usr/local/bin/pi-run /usr/local/bin/pi-projects; do
    if [ -f "$FILE" ]; then
        chown vscode:vscode "$FILE" 2>/dev/null || true
    fi
done

# Safety net: fix only stray root-owned files under home (no-op when clean).
# This replaces the old `chown -R /home/vscode`, which re-touched every file
# including .vscode-server and .cache on each run.
find /home/vscode -user root -exec chown vscode:vscode {} + 2>/dev/null || true

# Setup runs as root, so the git index can end up root-owned; vscode then
# cannot write to it. Fix just that file instead of the whole checkout.
if [ -f "$WS/.git/index" ]; then
    chown --from=root:root vscode:vscode "$WS/.git/index" 2>/dev/null || true
fi

echo "[setup] Pi.dev environment ready."
touch "$STORE/.provisioned"

# Force flush standard streams to end process-substitution safely
exec 1>&- 2>&-
wait