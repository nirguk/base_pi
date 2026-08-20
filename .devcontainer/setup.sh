#!/usr/bin/env bash
set -e

echo "[setup] Updating apt packages..."
apt-get update

# Install GitHub CLI (gh) if not present
if ! command -v gh &> /dev/null; then
  echo "[setup] Installing GitHub CLI (gh)..."
  apt-get install -y gh
fi


echo "[setup] Installing Pi.dev agent..."
npm install -g --allow-scripts=@google/genai,protobufjs,koffi @earendil-works/pi-coding-agent

echo "[setup] Trusting project..."
mkdir -p ~/.pi/agent

if [ ! -f ~/.pi/agent/trust.json ]; then
  cat <<'EOF' >~/.pi/agent/trust.json
{
  "/workspaces/base_pi": true
}
EOF
fi



echo "[setup] Installing Pi.dev extensions..."
pi install npm:pi-web-access -l --approve

echo "[setup] Pi.dev environment ready."
