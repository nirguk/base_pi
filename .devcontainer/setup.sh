#!/usr/bin/env bash
set -e
exec > >(tee /workspaces/base_pi/setup_debug.log) 2>&1
export COLUMNS=120
export LINES=40
clear

echo -e "\n=============================================="
echo " [setup] Initializing Headless Devcontainer Audio"
echo "==============================================\n"

export DEBIAN_FRONTEND=noninteractive
export HOME=/home/vscode
export XDG_CONFIG_HOME=/home/vscode/.config

# Directly force the vscode user's home directory in /etc/passwd
sed -i 's|^vscode:x:\([0-9]*\):\([0-9]*\):.*:.*:|vscode:x:\1:\2::/home/vscode:|' /etc/passwd

# Pre-create the required directories with correct ownership
mkdir -p /home/vscode/.config/pulse
chown -R vscode:vscode /home/vscode

# Robustly prevent any init script or service startup during apt operations
cat << 'EOF' > /usr/sbin/policy-rc.d
#!/bin/sh
exit 101
EOF
chmod +x /usr/sbin/policy-rc.d

echo "[setup] Updating apt packages..."
sudo apt-get -qq update

echo "[setup] Installing GitHub CLI..."
if ! command -v gh &> /dev/null; then
    sudo apt-get install -o Dpkg::Use-Pty=0 -y gh
fi

echo "[setup] Installing core audio and tools..."
set +e
sudo apt-get install -o Dpkg::Use-Pty=0 -y --no-install-recommends socat alsa-utils libasound2-plugins pulseaudio pulseaudio-utils
APT_EXIT=$?
set -e

if [ $APT_EXIT -ne 0 ]; then
    echo "[setup] Warning: apt-get install exited with code $APT_EXIT"
fi

echo "[setup] APT PACKAGES INSTALL COMPLETE"
echo "[setup] TIDYING POLICY & PulseAudio systemd user"
# Remove the policy override now that installation is complete
rm -f /usr/sbin/policy-rc.d

# Remove PulseAudio systemd user units just in case
rm -f /usr/lib/systemd/user/pulseaudio.socket /usr/lib/systemd/user/pulseaudio.service

echo "[setup] Disable RTKit high-priority and real-time scheduling by appending to daemon.conf"
echo "high-priority = no" >> /etc/pulse/daemon.conf
echo "realtime-scheduling = no" >> /etc/pulse/daemon.conf

echo "[setup] Disable physical sound card detection in default.pa for container environments"
sed -i '/load-module module-udev-detect/s/^/#/' /etc/pulse/default.pa
sed -i '/load-module module-alsa-card/s/^/#/' /etc/pulse/default.pa

echo "[setup] Create the pipe and start the network listener..."
rm -f /tmp/mic_pipe
mkfifo /tmp/mic_pipe
chown vscode:vscode /tmp/mic_pipe

# 1. Hold an open write descriptor continuously under the vscode user
runuser -u vscode -- bash -c "exec 3<> /tmp/mic_pipe; sleep infinity" &

# 2. Pipe incoming network audio from Windows FFmpeg into the FIFO
runuser -u vscode -- bash -c "while true; do socat TCP:host.docker.internal:5000 PIPE:/tmp/mic_pipe || true; sleep 2; done" &

echo "[setup] Ensure machine ID is generated for D-Bus and PulseAudio"
mkdir -p /var/lib/dbus
dbus-uuidgen > /var/lib/dbus/machine-id
if [ ! -f /etc/machine-id ]; then
    dbus-uuidgen > /etc/machine-id
fi

echo "[setup] Create the runtime directory with strict 0700 permissions required by PulseAudio"
mkdir -p /tmp/run-vscode
chmod 700 /tmp/run-vscode
chown -R vscode:vscode /tmp/run-vscode

echo "[setup] Start PulseAudio as the vscode user..."
rm -f /tmp/pulse.log

# Start PulseAudio in background mode
runuser -u vscode -- env HOME=/home/vscode PULSE_SERVER="" XDG_RUNTIME_DIR=/tmp/run-vscode pulseaudio --start --daemonize=yes --exit-idle-time=-1 -vvv >> /tmp/pulse.log 2>&1

echo "[setup] Waiting for PulseAudio user socket..."
AUDIO_READY=0
for i in {1..20}; do
    if [ -S /tmp/run-vscode/pulse/native ]; then
        AUDIO_READY=1
        break
    fi
    sleep 0.5
done

if [ $AUDIO_READY -eq 0 ]; then
    echo "[setup] Error: PulseAudio failed to create socket. Dumping /tmp/pulse.log:"
    cat /tmp/pulse.log
    exit 1
fi

echo "[setup] Load dummy sink and virtual microphone source..."
runuser -u vscode -- env HOME=/home/vscode XDG_RUNTIME_DIR=/tmp/run-vscode PULSE_SERVER=unix:/tmp/run-vscode/pulse/native pactl load-module module-null-sink sink_name=dummy_output
runuser -u vscode -- env HOME=/home/vscode XDG_RUNTIME_DIR=/tmp/run-vscode PULSE_SERVER=unix:/tmp/run-vscode/pulse/native pactl load-module module-pipe-source source_name=virtual_mic file=/tmp/mic_pipe format=s16le rate=16000 channels=1 source_properties=device.description="Virtual_Microphone"
runuser -u vscode -- env HOME=/home/vscode XDG_RUNTIME_DIR=/tmp/run-vscode PULSE_SERVER=unix:/tmp/run-vscode/pulse/native pactl set-default-source virtual_mic

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

git config --global user.email "nirgrahamuk@gmail.com"
git config --global user.name "nirguk"
echo "[setup] Pi.dev environment ready."