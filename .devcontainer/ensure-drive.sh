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
# remote-pi supervisor (daemon manager behind remote_spawn): restart if down.
SUP_BIN=/workspaces/base_pi/.pi/npm/node_modules/.bin/pi-supervisord
if [ -x "$SUP_BIN" ] && ! node /workspaces/base_pi/.pi/npm/node_modules/remote-pi/dist/index.js daemon status >/dev/null 2>&1; then
  if [ "$IS_ROOT" = "yes" ]; then
    setsid sudo -u vscode nohup "$SUP_BIN" >/tmp/pi-supervisord.log 2>&1 < /dev/null &
  else
    (setsid nohup "$SUP_BIN" >/tmp/pi-supervisord.log 2>&1 < /dev/null &)
  fi
fi
echo "[ensure-drive] ssh:2222 + tmux ready"
