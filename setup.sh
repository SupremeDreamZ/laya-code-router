#!/bin/bash
# Laya router — one-command setup for macOS.
#
# From a clone:            ./setup.sh
# Bootstrap a fresh Mac:   git clone https://github.com/SupremeDreamZ/laya-code-router ~/.laya-router/repo
#                          bash ~/.laya-router/repo/setup.sh
#
# Gets you from a clean Mac to a running router in one shot:
#   1. checks what you need (node, python, Claude Code and whether it is signed in)
#   2. builds the local decision model environment (~1 GB, one time)
#   3. installs the menu-bar app, starts the router and opens the app (it also starts at login)
# Safe to re-run: it fixes what's broken and leaves your settings alone.
#
#   ./setup.sh --check       look at this Mac and say what is missing, changing nothing
#   ./setup.sh --cli-only    skip the menu-bar app; the command-line launcher still works
#   ./setup.sh --uninstall   remove the app and the login item (your settings and usage stay)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
LAYA_HOME_DIR="${LAYA_HOME:-$HOME/.laya-router}"
VENV="${LAYA_VENV:-$LAYA_HOME_DIR/venv}"
MIN_DISK_MB=1500
APP_REQUIRED=1
for arg in "$@"; do
  case "$arg" in
    --cli-only) APP_REQUIRED=0 ;;
    --uninstall) UNINSTALL=1 ;;
    --check) CHECK_ONLY=1 ;;
    *) echo "unknown option: $arg  (try --check, --cli-only or --uninstall)" >&2; exit 2 ;;
  esac
done
LABEL="io.github.supremedreamz.laya"
OLD_LABEL="com.supreme.laya"   # the first private build; retired quietly
say() { printf '  %s\n' "$*"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mX %s\033[0m\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = "Darwin" ] || { echo "Laya setup supports macOS. The CLI alone also runs on Linux — see README."; [ $APP_REQUIRED -eq 0 ] || exit 1; }

if [ "${UNINSTALL:-}" = "1" ]; then
  step "Uninstalling"
  for label in "$LABEL" "$OLD_LABEL"; do
    # bootout stops the running router as well as unloading it. Nothing loaded is fine.
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$label.plist"
  done
  pkill -f "LayaBar.app/Contents/MacOS" 2>/dev/null || true
  rm -rf "$HOME/Applications/LayaBar.app"
  npm unlink -g laya-code-router >/dev/null 2>&1 || true
  say "Removed the app, the login item, and the CLI links."
  say "Your data is untouched: ~/.laya-router (settings, usage) and ~/.laya-router.env."
  say "Delete them yourself when you are sure:  rm -rf ~/.laya-router ~/.laya-router.env"
  exit 0
fi

cd "$REPO"

# ---------------------------------------------------------------- 1. checks
step "Checking this machine"
command -v node >/dev/null 2>&1 || command -v /opt/homebrew/bin/node >/dev/null 2>&1 || \
  fail "Node.js 20.12+ is required. Install it (https://nodejs.org or 'brew install node') and re-run."
NODE_MAJOR=$(node -p "process.versions.node.split('.').slice(0,2).join('.')" 2>/dev/null || echo 0)
awk -v v="$NODE_MAJOR" 'BEGIN{exit !(v>=20.12)}' || fail "Node 20.12+ required, found $(node --version)."
say "node $(node --version)"

PY=""
for c in python3 /usr/bin/python3 /opt/homebrew/bin/python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; exit(0 if sys.version_info>=(3,10) else 1)' 2>/dev/null; then PY="$c"; break; fi
done
[ -n "$PY" ] || fail "Python 3.10+ required for the local decision model. Install it ('brew install python@3.12') and re-run."
say "python $($PY -c 'import platform;print(platform.python_version())') ($PY)"

FREE_MB=$(df -k . | awk 'NR==2{print int($4/1024)}')
[ "$FREE_MB" -ge "$MIN_DISK_MB" ] || fail "Only ${FREE_MB} MB free. The model environment needs ~${MIN_DISK_MB} MB — free some space and re-run."
say "disk: $((FREE_MB / 1024)) GB-ish free — enough"

# Signing in is Claude Code's own: setup only looks. The answer comes from `claude auth status`
# through src/account.mjs, which also knows the places `claude` hides when a PATH is short.
SIGNED_IN=1
ACCOUNT_HINT="$(node "$REPO/src/account.mjs" --hint 2>/dev/null)" && ACCOUNT_RC=0 || ACCOUNT_RC=$?
printf '%s\n' "$ACCOUNT_HINT" | while IFS= read -r line; do say "$line"; done
[ "$ACCOUNT_RC" -eq 0 ] || SIGNED_IN=0
if [ "$ACCOUNT_RC" -eq 1 ]; then
  say "Setup does not need you signed in. Do it any time before your first routed session."
fi
if [ "${CHECK_ONLY:-}" = "1" ]; then
  step "Checked. Nothing was changed."
  [ "$SIGNED_IN" -eq 1 ] && say "Run ./setup.sh to install." || say "Run ./setup.sh to install, then sign in."
  exit 0
fi

# ------------------------------------------------------------------- 2. CLI
step "Installing the router CLI"
npm install --no-fund --no-audit --loglevel=error
npm link --loglevel=error >/dev/null 2>&1 || npm link --force --loglevel=error >/dev/null
say "laya-claude ready: $(command -v laya-claude || echo 'npm link needs PATH — open a new terminal')"

# ------------------------------------------------------------------- 3. venv
step "Setting up the local decision model"
if [ ! -x "$VENV/bin/python" ]; then
  say "creating $VENV"
  "$PY" -m venv "$VENV"
fi
[ -x "$VENV/bin/python" ] || fail "Could not create the venv at $VENV"
say "installing laya (torch downloads once, ~2 min)"
# Pinned to 0.3.x, where the routing thresholds were calibrated. Measured on 2026-09-30: scores
# recorded before upgrading to 0.3.22 and re-scored on it differ by at most 0.001 over 9 prompts,
# with no tier changes. That is the only pair compared; pip installs the newest release in range.
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q "laya>=0.3.4,<0.4"
LAYA_VER=$("$VENV/bin/python" -c "import laya;print(laya.__version__)")
say "laya $LAYA_VER"

# make every entry point (daemon, launchd, CLI) find this interpreter
ENV_FILE="$HOME/.laya-router.env"
touch "$ENV_FILE"
if grep -q '^LAYA_PYTHON=' "$ENV_FILE" 2>/dev/null; then
  sed -i '' "s|^LAYA_PYTHON=.*|LAYA_PYTHON=$VENV/bin/python|" "$ENV_FILE"
else
  echo "LAYA_PYTHON=$VENV/bin/python" >>"$ENV_FILE"
fi
say "interpreter recorded in ~/.laya-router.env"

# first real decision warms the weights download; 90s timeout so a slow network warns, not hangs
step "Warming the model (downloads ~8 MB of weights, once)"
if LAYA_HOME="$LAYA_HOME_DIR" LAYA_PYTHON="$VENV/bin/python" \
   "$VENV/bin/python" src/laya_bridge.py --warm >/dev/null 2>&1; then
  say "model loaded and answering"
else
  say "first load can take a minute on a slow connection — the router will retry on its own."
  say "If routing never works, run: LAYA_DEBUG=1 laya-claude and check ~/.laya-claude.log"
fi

# -------------------------------------------------------------------- 4. app
if [ "$APP_REQUIRED" -eq 1 ]; then
  step "Building the menu-bar app"
  if ! command -v swiftc >/dev/null 2>&1; then
    say "No Swift toolchain found. Install it and re-run ./setup.sh:"
    say "  xcode-select --install"
    say "(or re-run with --cli-only to skip the menu-bar app; everything else still works)"
    exit 1
  fi
  bash apps/LayaBar/install.sh
  say "LayaBar installed to ~/Applications"
  # install.sh only builds and registers. Without this nothing runs until the next login.
  bash apps/LayaBar/start.sh
else
  step "Skipping the menu-bar app (--cli-only)"
fi

# ---------------------------------------------------------------- verify
step "Verifying"
ANSWERING=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if node -e '
import("net").then(({connect})=>{
  const s=connect({host:"127.0.0.1",port:Number(process.env.LAYA_CONTROL_PORT??8790)});
  let b="";s.on("data",c=>{b+=c;if(b.includes("\n")){const m=JSON.parse(b.split("\n")[0]);process.exit(m.result?0:1)}});
  s.on("error",()=>process.exit(1));
  s.on("connect",()=>s.write(JSON.stringify({id:1,action:"snapshot"})+"\n"));
  setTimeout(()=>process.exit(1),2000);
})' >/dev/null 2>&1; then ANSWERING=1; break; fi
  sleep 1
done
if [ "$ANSWERING" -eq 1 ]; then say "router is answering"
elif [ "$APP_REQUIRED" -eq 1 ]; then say "router not answering yet: its log is ~/.laya-router/daemon.log"
else say "router runs when you start a session (--cli-only)"; fi

# Signing in may have happened while the model downloaded, so ask again rather than reuse the
# answer from the start. This is the last thing printed because it is the thing left to do.
if FINAL_HINT="$(node "$REPO/src/account.mjs" --hint 2>/dev/null)"; then
  step "Claude Code"
  say "$FINAL_HINT"
else
  step "One more step"
  printf '%s\n' "$FINAL_HINT" | while IFS= read -r line; do say "$line"; done
fi

cat <<'DONE'

Done.

  laya-claude            start a routed Claude Code session
  click the L icon       menu-bar app: spend, history, settings, launch a session

The routing model loads when the router starts (about 10 seconds), so it is ready before
your first prompt. It holds about 1.3 GB of memory; LAYA_EAGER_LOAD=0 loads it on first use instead.

Uninstall:  ./setup.sh --uninstall   (or delete ~/Applications/LayaBar.app and
            ~/Library/LaunchAgents/io.github.supremedreamz.laya.plist, then npm uninstall -g)
DONE
