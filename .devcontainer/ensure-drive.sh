#!/usr/bin/env bash
# ensure-drive — idempotent boot step for the `drive` workflow (ssh + tmux).
# Runs on rebuild (via setup.sh) and on every container start (postStartCommand).
# Uses sudo when non-root; a no-op when everything is already in place.
set -e
IS_ROOT=no
[ "$(id -u)" = "0" ] && IS_ROOT=yes
SUDO=""
[ "$IS_ROOT" = "no" ] && SUDO="sudo -n"

if ! command -v tmux >/dev/null 2>&1 || ! command -v sshd >/dev/null 2>&1; then
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq tmux openssh-server
fi

if [ "$IS_ROOT" = "yes" ]; then
  grep -q 'set -g mouse on' /home/vscode/.tmux.conf 2>/dev/null || echo 'set -g mouse on' >> /home/vscode/.tmux.conf
  chown vscode:vscode /home/vscode/.tmux.conf
else
  grep -q 'set -g mouse on' ~/.tmux.conf 2>/dev/null || echo 'set -g mouse on' >> ~/.tmux.conf
fi

$SUDO mkdir -p /run/sshd
$SUDO ssh-keygen -A >/dev/null 2>&1 || true
if ! (echo > /dev/tcp/127.0.0.1/2222) >/dev/null 2>&1; then
  $SUDO /usr/sbin/sshd -p 2222
fi
echo "[ensure-drive] ssh:2222 + tmux ready"
