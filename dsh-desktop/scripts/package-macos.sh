#!/bin/zsh
# Build dsh-desktop into a signed (ad-hoc by default) .app + .dmg without
# requiring the Node/Tauri CLI. For a real distribution identity set
# APPLE_SIGNING_IDENTITY before running (Developer ID Application: ...).
#
# Cross-compile an Intel build on an Apple-Silicon host with:
#   TARGET=x86_64-apple-darwin TARGET_ARCH=x86_64 zsh scripts/package-macos.sh
#
# The app intentionally bundles NO Node runtime and NO dsh copy: it runs the
# user's own Node (>= 20) and globally installed @deepseek-ai/dsh, so the CLI
# and the desktop share one runtime, one package, one ~/.dsh.
set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

TARGET="${TARGET:-}"
TARGET_ARCH="${TARGET_ARCH:-}"
if [[ -n "$TARGET_ARCH" ]]; then
  ARCH="$TARGET_ARCH"
else
  case "$(uname -m)" in
    arm64) ARCH="aarch64" ;;
    x86_64) ARCH="x86_64" ;;
    *) ARCH="$(uname -m)" ;;
  esac
fi

PRODUCT_NAME="DSH Desktop"
VERSION="${VERSION:-0.6.8}"
IDENTIFIER="com.deepseek.harness.desktop"
BUNDLE_ROOT="src-tauri/target/release/bundle/macos"
APP_DIR="${BUNDLE_ROOT}/${PRODUCT_NAME}.app"
CONTENTS="${APP_DIR}/Contents"
DMG_DIR="src-tauri/target/release/bundle/dmg"
DMG_PATH="${DMG_DIR}/dsh-desktop-v${VERSION}-macos-${ARCH}.dmg"

rm -rf "$APP_DIR"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources/host" "$DMG_DIR"

if [[ -n "$TARGET" ]]; then
  (
    cd src-tauri
    cargo build --release --target "$TARGET"
  )
  cp "src-tauri/target/${TARGET}/release/dsh-desktop" "${CONTENTS}/MacOS/dsh-desktop"
else
  (
    cd src-tauri
    cargo build --release
  )
  cp src-tauri/target/release/dsh-desktop "${CONTENTS}/MacOS/dsh-desktop"
fi
chmod +x "${CONTENTS}/MacOS/dsh-desktop"

# Shell + icon + the portless Node host resources. The sidecar resolver checks
# Resources/host first in release builds, so the .app is self-contained for the
# host layer (the Node runtime and @deepseek-ai/dsh come from the user env).
cp host/sidecar.mjs host/ipc-web-server.mjs host/ws-ipc.mjs host/desktop-pnpm.mjs "${CONTENTS}/Resources/host/"
cp src-tauri/icons/icon.icns "${CONTENTS}/Resources/icon.icns"

cat > "${CONTENTS}/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>English</string>
  <key>CFBundleDisplayName</key><string>${PRODUCT_NAME}</string>
  <key>CFBundleExecutable</key><string>dsh-desktop</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundleIdentifier</key><string>${IDENTIFIER}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${PRODUCT_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST

SIGN_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
if [[ "$SIGN_IDENTITY" == "-" ]]; then
  codesign --force --deep --sign - "$APP_DIR"
else
  # Hardened runtime; the shell itself needs no special entitlements (the
  # Node runtime lives in the user's environment, not in this bundle).
  codesign --force --deep --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP_DIR"
fi

rm -f "$DMG_PATH"
hdiutil create -volname "$PRODUCT_NAME" -srcfolder "$APP_DIR" -ov -format UDZO "$DMG_PATH"

echo
echo "✅ Arch: ${ARCH}"
echo "✅ App:  ${APP_DIR}"
echo "✅ DMG:  ${DMG_PATH}"
echo "   codesign -dv \"${APP_DIR}\""
[[ "$SIGN_IDENTITY" == "-" ]] && echo "   (ad-hoc signed; run xcrun notarytool for distribution)"