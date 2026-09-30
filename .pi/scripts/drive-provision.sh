#!/usr/bin/env bash
# drive-provision — (re)generate the per-project files behind the `drive` word.
#
# Per registered project in .pi/projects.json it writes:
#   <project>/.pi-ssh/id_ed25519(.pub)  login key (generated, never committed)
#   <project>/.pi-ssh/basepi-ip         this window's current address
#   <project>/.pi-ssh/drive             the attach script behind `drive`
# Plus: canonical keypair in base_pi/.pi-ssh/ (gitignored there), and this
# window's ~/.ssh/authorized_keys entry. Each project ignores .pi-ssh/.
# Safe to re-run: existing keys are kept, addresses refreshed.
set -e
BASE_WS=/workspaces/base_pi
CANON="$BASE_WS/.pi-ssh"
REG="$BASE_WS/.pi/projects.json"

mkdir -p "$CANON" ~/.ssh
chmod 700 ~/.ssh "$CANON" 2>/dev/null || true
if [ ! -f "$CANON/id_ed25519" ]; then
  ssh-keygen -t ed25519 -N '' -f "$CANON/id_ed25519" -C basepi-drive >/dev/null
fi
chmod 600 "$CANON/id_ed25519"
IP=$(hostname -i 2>/dev/null | awk '{print $1}')
[ -n "$IP" ] && echo -n "$IP" > "$CANON/basepi-ip"

grep -qxF "$(cat "$CANON/id_ed25519.pub")" ~/.ssh/authorized_keys 2>/dev/null \
  || cat "$CANON/id_ed25519.pub" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

node -e "const r=require('$REG');for(const [a,v] of Object.entries(r)){console.log(a+' '+v.path)}" \
| while read -r alias dir; do
  [ -d "$dir" ] || { echo "[drive-provision] skip $alias (no $dir)"; continue; }
  mkdir -p "$dir/.pi-ssh"
  cp "$CANON/id_ed25519" "$CANON/id_ed25519.pub" "$dir/.pi-ssh/"
  chmod 600 "$dir/.pi-ssh/id_ed25519"
  echo -n "$IP" > "$dir/.pi-ssh/basepi-ip"
  sed -e "s#__DIR__#$dir#g" -e "s#__ALIAS__#$alias#g" \
    "$BASE_WS/.pi/scripts/drive-template.sh" > "$dir/.pi-ssh/drive"
  chmod +x "$dir/.pi-ssh/drive"
  echo "[drive-provision] $alias -> $dir/.pi-ssh/drive (default session ${alias}-link)"
done
echo "[drive-provision] done. In each project terminal, once: echo \"alias drive='\$(pwd)/.pi-ssh/drive'\" >> ~/.bashrc; source ~/.bashrc"
