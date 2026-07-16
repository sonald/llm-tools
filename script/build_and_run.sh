#!/usr/bin/env bash
set -euo pipefail

APP_NAME="ModelFiles"
BUNDLE_ID="com.siancao.modelfiles"
MIN_SYSTEM_VERSION="13.0"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
APP_DIR="$DIST_DIR/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
MODE="${1:-run}"

build_and_stage() {
  cd "$ROOT_DIR"
  swift build -c debug
  local bin_dir
  bin_dir="$(swift build -c debug --show-bin-path)"

  rm -rf "$APP_DIR"
  mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
  cp "$bin_dir/$APP_NAME" "$MACOS_DIR/$APP_NAME"
  cp "$ROOT_DIR/Sources/ModelFiles/Resources/AppIcon.icns" "$RESOURCES_DIR/AppIcon.icns"

  cat > "$CONTENTS_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleExecutable</key>
  <string>$APP_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>$MIN_SYSTEM_VERSION</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST
}

case "$MODE" in
  run)
    build_and_stage
    /usr/bin/open -n "$APP_DIR"
    ;;
  debug)
    build_and_stage
    exec /usr/bin/lldb "$MACOS_DIR/$APP_NAME"
    ;;
  logs)
    exec /usr/bin/log stream --style compact --predicate "process == '$APP_NAME'"
    ;;
  telemetry)
    exec /usr/bin/log show --last 10m --style compact --predicate "process == '$APP_NAME'"
    ;;
  verify)
    build_and_stage
    test -x "$MACOS_DIR/$APP_NAME"
    /usr/bin/plutil -lint "$CONTENTS_DIR/Info.plist"
    echo "Verified $APP_DIR"
    ;;
  *)
    echo "Usage: $0 {run|debug|logs|telemetry|verify}" >&2
    exit 2
    ;;
esac
