#!/usr/bin/env bash
# Healthcheck for the base_pi devcontainer node/npm/pi provisioning.
#
# Verifies that the pinned, deterministic setup produced by .devcontainer/setup.sh
# is actually in place: node runtime, global pi pin, the /opt/pi-npm-store
# symlink architecture, and that every extension pinned in .pi/settings.json
# resolves to the expected version/commit.
#
# Exit 0 = healthy. Exit 1 = at least one check failed (prints fix hints).
# Intended to be wired as devcontainer "postStartCommand" so a broken setup
# shows as a degraded container instead of failing silently on startup.
set -u   # not -e: run every check, then report

WS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DC="$WS/.devcontainer/devcontainer.json"
SETUP="$WS/.devcontainer/setup.sh"
SETTINGS="$WS/.pi/settings.json"

passes=0
fails=0

pass() { printf 'PASS  %s\n' "$1"; passes=$((passes+1)); }
fail() { printf 'FAIL  %s\n' "$1" >&2; fails=$((fails+1)); }
hint() { printf '      fix: %s\n' "$1" >&2; }

# ---------- 1. Node runtime matches devcontainer pin ----------
node_pin=""
if command -v node >/dev/null 2>&1; then
  node_pin=$(node -e "try{const d=require('$DC');process.stdout.write(String((d.features||{})['ghcr.io/devcontainers/features/node:1']&&d.features['ghcr.io/devcontainers/features/node:1'].version||''))}catch(e){}" 2>/dev/null)
fi
node_pin_major=$(printf '%s' "$node_pin" | grep -oE '^[0-9]+' | head -1)

if [ -z "$node_pin_major" ]; then
  fail "node runtime: cannot parse node feature pin from devcontainer.json" && hint "check $DC features.gcr.io/devcontainers/features/node:1.version"
elif ! command -v node >/dev/null 2>&1; then
  fail "node runtime: node not on PATH" && hint "run ./.devcontainer/setup.sh (postCreate failed?)"
else
  node_actual_major=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)
  if [ -n "$node_actual_major" ] && [ "$node_actual_major" = "$node_pin_major" ]; then
    pass "node runtime: node $(node --version | sed 's/^v//') (pin major $node_pin_major)"
  else
    fail "node runtime: expected major $node_pin_major, got $(node --version 2>/dev/null)" && hint "rebuilt image node feature is out of sync with devcontainer.json"
  fi
fi

# ---------- 2. npm available ----------
if command -v npm >/dev/null 2>&1 && npm_ver=$(npm --version 2>/dev/null) && [ -n "$npm_ver" ]; then
  pass "npm runtime: $npm_ver"
else
  fail "npm runtime: npm not available or no version" && hint "run ./.devcontainer/setup.sh (postCreate rebuild?)"
fi

# ---------- 3. Globally installed pi pinned to setup.sh ----------
pi_pin=$(grep -oE '@earendil-works/pi-coding-agent@[0-9.]+' "$SETUP" 2>/dev/null | grep -oE '[0-9.]+$' | head -1)
if [ -z "$pi_pin" ]; then
  fail "pi pin: could not extract @earendil-works/pi-coding-agent version from setup.sh" && hint "check the npm install -g line in setup.sh"
else
  pi_ver=$(pi --version 2>/dev/null)
  if [ -n "$pi_ver" ] && [ "$pi_ver" = "$pi_pin" ]; then
    pass "pi pinned: $pi_pin"
  else
    fail "pi pinned: setup.sh pins $pi_pin, installed $( [ -n "$pi_ver" ] && echo "$pi_ver" || echo 'missing' )" && hint "run ./.devcontainer/setup.sh (postCreate rebuild?)"
  fi
fi

# ---------- 4/5. Store symlink architecture ----------
# .pi/npm and .pi/git/github.com must be symlinks into /opt/pi-npm-store,
# not physical dirs (setup.sh enforces this; a physical dir regresses
# every extension load / npm install onto the slow 9p host mount).
for link in .pi/npm .pi/git/github.com; do
  if [ -L "$WS/$link" ]; then
    target=$(readlink -f "$WS/$link" 2>/dev/null)
    if [ -n "$target" ] && [ -d "$target" ]; then
      pass "symlink $link -> $target"
    else
      fail "symlink $link -> $target: target missing" && hint "run ./.devcontainer/setup.sh"
    fi
  else
    fail "symlink $link: not a symlink (is a physical dir?)" && hint "run ./.devcontainer/setup.sh"
  fi
done

STORE=$(readlink -f "$WS/.pi/npm" 2>/dev/null | sed 's#/npm$##')

# ---------- 6. Store non-empty ----------
if [ -n "$STORE" ] && [ -d "$STORE/npm/node_modules" ] && [ -n "$(ls -A "$STORE/npm" 2>/dev/null)" ]; then
  pass "npm store non-empty ($STORE/npm)"
else
  fail "npm store: $STORE/npm missing or empty" && hint "run ./.devcontainer/setup.sh"
fi
if [ -n "$STORE" ] && [ -d "$STORE/git/github.com" ] && [ -n "$(ls -A "$STORE/git/github.com" 2>/dev/null)" ]; then
  pass "git store non-empty ($STORE/git/github.com)"
else
  fail "git store: $STORE/git/github.com missing or empty" && hint "run ./.devcontainer/setup.sh"
fi

# ---------- 7/8. Pinned packages resolve (npm + git) ----------
# Emit one normalized spec per line: "npm:name@ver" or "git:url@ref".
if command -v node >/dev/null 2>&1; then
  while IFS= read -r spec; do
    [ -z "$spec" ] && continue
    case "$spec" in
      npm:*)
        rest=${spec#npm:}
        ver=${rest##*@}
        name=${rest%@*}
        installed=$(node -p "try{require('$STORE/npm/node_modules/$name/package.json').version}catch(e){''}" 2>/dev/null)
        if [ -n "$installed" ] && [ "$installed" = "$ver" ]; then
          pass "npm pin $name@$ver installed"
        else
          fail "npm pin $name@$ver: installed $( [ -n "$installed" ] && echo "$installed" || echo 'missing' )" && hint "run ./.devcontainer/setup.sh"
        fi
        ;;
      git:*)
        rest=${spec#git:}
        ref=${rest##*@}
        repopath=${rest%@*}   # host/owner/repo, e.g. github.com/nirguk/pi-session-analyzer
        dir="$STORE/git/$repopath"
        got=$(git -C "$dir" rev-parse HEAD 2>/dev/null)
        if [ -z "$got" ]; then
          fail "git pin $repopath@$ref: checkout missing under store" && hint "run ./.devcontainer/setup.sh"
          continue
        fi
        if [ "$ref" = "$got" ]; then
          pass "git pin $repopath@$ref (HEAD=$got)"
        elif [[ "$ref" == [0-9a-f]{40} ]]; then
          fail "git pin $repopath: HEAD=$got != pinned $ref" && hint "run ./.devcontainer/setup.sh"
        else
          want=$(git -C "$dir" rev-parse "$ref^{commit}" 2>/dev/null || git -C "$dir" rev-parse "$ref" 2>/dev/null)
          if [ -n "$want" ] && [ "$want" = "$got" ]; then
            pass "git pin $repopath@$ref (HEAD=$got)"
          else
            fail "git pin $repopath@$ref: HEAD $got does not resolve from $ref" && hint "run ./.devcontainer/setup.sh"
          fi
        fi
        ;;
    esac
  done < <(node -e "
    const s=require('$SETTINGS');
    for (const p of s.packages||[]) {
      const src = typeof p==='string' ? p : (p && p.source);
      if (src) console.log(src);
    }" 2>/dev/null)
fi

# ---------- 9. pi list smoke (extensions resolvable end-to-end) ----------
if pi list >/dev/null 2>&1; then
  pass "pi list: extension resolution OK"
else
  fail "pi list: extensions do not resolve" && hint "run ./.devcontainer/setup.sh"
fi

echo
if [ "$fails" -eq 0 ]; then
  printf 'ALL CHECKS PASSED (%s)\n' "$passes"
  exit 0
else
  printf '%s FAILED, %s passed\n' "$fails" "$passes" >&2
  exit 1
fi