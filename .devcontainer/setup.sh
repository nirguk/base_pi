#!/usr/bin/env bash
set -e

echo "[setup] Updating apt packages..."
apt-get update

# Install GitHub CLI (gh) if not present
if ! command -v gh &> /dev/null; then
  echo "[setup] Installing GitHub CLI (gh)..."
  apt-get install -y gh
fi

# for microphone access
apt-get update && apt-get install -y socat alsa-utils libasound2-plugins pulseaudio
mkfifo /tmp/mic_pipe
socat TCP:host.docker.internal:5000 - > /tmp/mic_pipe &
pulseaudio --start
pactl load-module module-pipe-source source_name=virtual_mic file=/tmp/mic_pipe format=s16le rate=16000 channels=1

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

echo "[setup] Configuring VS Code to pass Ctrl+P through to terminal..."
mkdir -p ~/.config/Code/User
cat > ~/.config/Code/User/keybindings.json <<'KBEOF'
[
  {
    "key": "ctrl+p",
    "command": "workbench.action.terminal.sendSequence",
    "args": { "text": "\u001b[27;5;16~" },
    "when": "terminalFocus && !terminalFindWidgetVisible"
  }
]
KBEOF

echo "[setup] Pi.dev environment ready."
