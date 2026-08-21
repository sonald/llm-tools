#!/usr/bin/env bash
set -euo pipefail

APP_NAME="ModelFiles"
BUNDLE_ID="com.siancao.modelfiles"
MIN_SYSTEM_VERSION="15.0"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
APP_DIR="$DIST_DIR/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
RESOURCE_BUNDLE="ModelFiles_ModelFiles.bundle"
MODE="${1:-run}"

stop_running() {
  pkill -x "$APP_NAME" 2>/dev/null || true
}

build_and_stage() {
  cd "$ROOT_DIR"
  swift build -c debug --disable-sandbox
  local bin_dir
  bin_dir="$(swift build -c debug --disable-sandbox --show-bin-path)"

  rm -rf "$APP_DIR"
  mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
  cp "$bin_dir/$APP_NAME" "$MACOS_DIR/$APP_NAME"
  cp "$ROOT_DIR/Sources/ModelFiles/Resources/AppIcon.icns" "$RESOURCES_DIR/AppIcon.icns"
  cp -R "$bin_dir/textual_Textual.bundle" "$RESOURCES_DIR/textual_Textual.bundle"
  cp -R "$bin_dir/$RESOURCE_BUNDLE" "$RESOURCES_DIR/$RESOURCE_BUNDLE"

  local localization_tool="/Applications/Xcode.app/Contents/Developer/usr/bin/xcstringstool"
  if [[ ! -x "$localization_tool" ]]; then
    echo "Missing xcstringstool: $localization_tool" >&2
    exit 1
  fi
  "$localization_tool" compile \
    "$ROOT_DIR/Sources/ModelFiles/Resources/Localizable.xcstrings" \
    --output-directory "$RESOURCES_DIR"

  cat > "$CONTENTS_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh-Hans</string>
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
  <key>CFBundleLocalizations</key>
  <array>
    <string>zh-Hans</string>
    <string>en</string>
  </array>
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
    stop_running
    build_and_stage
    /usr/bin/open -n "$APP_DIR"
    ;;
  debug)
    stop_running
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
    test -f "$RESOURCES_DIR/textual_Textual.bundle/prism-bundle.js"
    test -d "$RESOURCES_DIR/$RESOURCE_BUNDLE"
    test -f "$RESOURCES_DIR/$RESOURCE_BUNDLE/Localizable.xcstrings"
    test -f "$RESOURCES_DIR/zh-Hans.lproj/Localizable.strings"
    test -f "$RESOURCES_DIR/en.lproj/Localizable.strings"
    /usr/bin/plutil -lint "$CONTENTS_DIR/Info.plist"
    /usr/bin/plutil -lint "$RESOURCES_DIR/zh-Hans.lproj/Localizable.strings"
    /usr/bin/plutil -lint "$RESOURCES_DIR/en.lproj/Localizable.strings"
    echo "Verified $APP_DIR"
    ;;
  *)
    echo "Usage: $0 {run|debug|logs|telemetry|verify}" >&2
    exit 2
    ;;
esac
