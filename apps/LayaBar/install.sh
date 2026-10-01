#!/bin/sh
# Builds and installs LayaBar.app, then registers Laya to start at login.
#
# Idempotent: safe to run again after a pull. It does NOT start anything; that is what
# `laya install-autostart` is for, so a build and a first run stay separate decisions.
set -e
APP_SRC="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$APP_SRC/../.." && pwd)"
APP_DIR="$APP_SRC"
DEST="$HOME/Applications/LayaBar.app"
AGENT="$HOME/Library/LaunchAgents/io.github.supremedreamz.laya.plist"

echo "==> building LayaBar"
cd "$APP_DIR"
swift build -c release

echo "==> assembling $DEST"
rm -rf "$DEST"
mkdir -p "$DEST/Contents/MacOS" "$DEST/Contents/Resources"
cp .build/release/LayaBar "$DEST/Contents/MacOS/LayaBar"

# A menu-bar accessory app: no dock icon, LSUIElement set.
cat > "$DEST/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>LayaBar</string>
  <key>CFBundleDisplayName</key><string>Laya</string>
  <key>CFBundleIdentifier</key><string>io.github.supremedreamz.layabar</string>
  <key>CFBundleExecutable</key><string>LayaBar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Laya opens Terminal to start your routed Claude Code sessions and to sign in to Claude Code.</string>
</dict>
</plist>
PLIST

# The icon, rendered from the SVG at every size macOS asks for.
if command -v qlmanage >/dev/null 2>&1; then
  ICONSET="$(mktemp -d)/LayaBar.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 64 128 256 512; do
    for scale in 1 2; do
      px=$((size * scale))
      qlmanage -t -s "$px" -o "$(dirname "$ICONSET")" "$APP_SRC/Resources/LayaBar.svg" >/dev/null 2>&1 || true
      src="$(dirname "$ICONSET")/LayaBar.svg.png"
      [ -f "$src" ] && cp "$src" "$ICONSET/icon_${size}x${size}$([ "$scale" = 2 ] && echo @2x).png"
    done
  done
  if [ -f "$ICONSET/icon_512x512@2x.png" ]; then
    iconutil -c icns "$ICONSET" -o "$DEST/Contents/Resources/AppIcon.icns" 2>/dev/null || true
  fi
fi

# Sign ad hoc, as a whole bundle. The linker gives the bare executable a signature of its own
# (Identifier=LayaBar), which is not the bundle's identity: macOS keys notification permission on
# the bundle id, and a binary whose signature disagrees with its Info.plist can be refused with no
# error anywhere. Ad hoc needs no developer account, so it works on anyone's machine.
if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - --identifier io.github.supremedreamz.layabar --timestamp=none "$DEST" >/dev/null 2>&1 \
    && echo "==> signed $DEST (ad hoc)" \
    || echo "==> could not sign (continuing; notifications may need a manual allow in System Settings)"
fi

# The menu-bar app and the daemon are two processes on purpose: the app is the face, the daemon
# is the router, and the daemon must outlive the app being closed.
# The first private build used com.supreme.* identifiers; retire them without a word.
# MIGRATE marker
for OLD in "$HOME/Library/LaunchAgents/com.supreme.laya.plist"; do
  [ -f "$OLD" ] && { launchctl unload -w "$OLD" 2>/dev/null || true; rm -f "$OLD"; }
done

PLIST_BODY="$REPO/bin/laya-daemon"
cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.github.supremedreamz.laya</string>
  <key>ProgramArguments</key>
  <array><string>$PLIST_BODY</string></array>
  <key>RunAtLoad</key><true/>
  <!-- Restart after a crash, but not after a clean quit: with a plain KeepAlive the "Quit Laya"
       button is undone within a second. Measured: a job that exits 0 was restarted 6 times in
       6 seconds under KeepAlive=true, and once under SuccessfulExit=false. -->
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <!-- Interactive, not Background: a routing decision sits in front of every prompt, so this is not
       background work. Measured with every core busy, the same daemon run as three launchd jobs:
       under Background the one decision made under load took 95.6 s (the load lasted 100 s, so it
       may have been waiting for it to end; a real daemon in a separate run took 31.7 s), under
       Standard the slowest of three took 2.9 s, under Interactive 0.27 s. That is one sample for
       Background and the load differed between runs, so the direction is measured and the size is not. -->
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$HOME/.laya-router/daemon.log</string>
  <key>StandardErrorPath</key><string>$HOME/.laya-router/daemon.log</string>
</dict>
</plist>
PLIST

echo "==> installed $DEST"
echo "==> wrote $AGENT"
echo
echo "Not started yet. To start Laya at login now:"
echo "  launchctl load -w $AGENT"
echo "To open the menu-bar icon:"
echo "  open $DEST"
