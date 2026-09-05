#!/usr/bin/env bash
set -e
exec > >(tee /workspaces/base_pi/setup_debug.log) 2>&1
export COLUMNS=120
export LINES=40
clear

echo -e "\n=============================================="
echo " [setup] Initializing"

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
git config --global user.email "nirgrahamuk@gmail.com"
git config --global user.name "nirguk"

echo "[setup] Pi.dev environment ready."
