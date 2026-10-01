#!/bin/sh
# Starts what install.sh set up: the background router (as the login item, so it also comes back
# at every login) and the menu-bar app. install.sh builds and registers; this runs.
#
# Safe to run again: a copy that is already loaded is removed first, so it also picks up a new
# build. Nothing here needs a password and nothing leaves this Mac.
#
# Removing a loaded job is not instant. Measured on a real Mac: `bootout` returns in 50 ms while
# launchd is still tearing the job down, `print` keeps listing it, and a `bootstrap` in that window
# fails with "Bootstrap failed: 5: Input/output error". A daemon that is busy takes longer to go.
# So this waits until the old copy is gone, and still retries a refusal that comes a moment later.
# LAYA_START_PAUSE (seconds) and LAYA_START_TRIES change the pace; the defaults give about 15 s.
set -e
LABEL="io.github.supremedreamz.laya"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
APP="$HOME/Applications/LayaBar.app"
PAUSE="${LAYA_START_PAUSE:-0.25}"
TRIES="${LAYA_START_TRIES:-60}"
DOMAIN="gui/$(id -u)"

if [ ! -f "$AGENT" ]; then
  echo "Laya is not installed yet. Run apps/LayaBar/install.sh first (or ./setup.sh from the top)." >&2
  exit 1
fi

# Nothing loaded is the normal first run, so a failure to clear it is not an error.
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true

# Wait for launchd to finish removing it. `print` succeeds while the job is still listed.
n=0
while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; do
  n=$((n + 1))
  if [ "$n" -ge "$TRIES" ]; then
    echo "Could not start the router: the previous copy would not finish stopping." >&2
    echo "Try again in a moment, or log out and back in. The router's own log is ~/.laya-router/daemon.log." >&2
    exit 1
  fi
  sleep "$PAUSE"
done

# Even once it is unlisted launchd can refuse for a moment longer, so a few refusals are expected.
# Only that refusal is retried: any other message means something is actually wrong.
n=0
while :; do
  n=$((n + 1))
  if out="$(launchctl bootstrap "$DOMAIN" "$AGENT" 2>&1)"; then break; fi
  case "$out" in
    *"Input/output error"*) [ "$n" -lt "$TRIES" ] || FAILED=1 ;;
    *) FAILED=1 ;;
  esac
  if [ -n "${FAILED:-}" ]; then
    echo "Could not start the router: $out" >&2
    echo "If you turned Laya off under System Settings > General > Login Items, turn it back on." >&2
    echo "The router's own log is ~/.laya-router/daemon.log." >&2
    exit 1
  fi
  sleep "$PAUSE"
done
echo "router started (and set to start at login)"

if [ -d "$APP" ]; then
  open "$APP"
  echo "menu-bar app opened: look for the L in the menu bar"
else
  echo "the menu-bar app is not installed ($APP), so only the router was started"
fi
