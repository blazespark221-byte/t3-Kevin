#!/bin/sh
# Builds this fork as "T3 Code (Kevin)" and installs it into /Applications,
# beside (never over) upstream T3 Code. Run again after changes or an upstream merge.
#   --build-only    build the DMG while the app is still open
#   --install-only  install the newest DMG already built (seconds)
set -eu
cd "$(dirname "$0")/.."

APP="/Applications/T3 Code (Kevin).app"
mode="${1:-all}"

export PATH="$PWD/node_modules/.bin:$PATH"
# A shell started from inside an Electron app (T3 Code itself) carries this,
# which makes Electron binaries run as plain Node.
unset ELECTRON_RUN_AS_NODE

if [ "$mode" != "--install-only" ]; then
  # A `-pr.` version builds without an update feed, so the app never replaces
  # itself with an upstream release.
  version="$(node -p "require('./apps/desktop/package.json').version")-pr.kevin.$(date +%Y%m%d%H%M)"
  node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 \
    --build-version "$version" --output-dir release/kevin
fi
[ "$mode" = "--build-only" ] && { echo "Built. Quit the app, then run: sh $0 --install-only"; exit 0; }

if ps -axo command | grep -F "$APP/Contents/MacOS/" | grep -vqF grep; then
  echo "Quit T3 Code (Kevin) first, then run: sh $0 --install-only" >&2
  exit 1
fi

dmg="$(ls -t release/kevin/T3-Code-Kevin-*-arm64.dmg | head -1)"
mount="$(hdiutil attach -nobrowse -readonly "$dmg" | tail -1 | cut -f3)"
rm -rf "$APP"
ditto "$mount/T3 Code (Kevin).app" "$APP"
hdiutil detach "$mount" -quiet
# Unsigned builds keep Electron's stale ad-hoc signature; re-seal the bundle.
codesign --force --deep --sign - "$APP"
echo "Installed $APP from $dmg"
