#!/bin/zsh
# Quick debug .app (ad-hoc signed) for local smoke testing; no dmg.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

PRODUCT_NAME="DeepSeek Harness Desktop"
APP_DIR="src-tauri/target/debug/bundle/macos/${PRODUCT_NAME}.app"
CONTENTS="${APP_DIR}/Contents"

rm -rf "$APP_DIR"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources/host"

(
  cd src-tauri
  cargo build
)

cp src-tauri/target/debug/dsh-desktop "${CONTENTS}/MacOS/dsh-desktop"
chmod +x "${CONTENTS}/MacOS/dsh-desktop"
cp host/sidecar.mjs host/ipc-web-server.mjs host/ws-ipc.mjs host/desktop-pnpm.mjs "${CONTENTS}/Resources/host/"
cp src-tauri/icons/icon.icns "${CONTENTS}/Resources/icon.icns"

# Reuse a Tauri-generated plist when available; otherwise synthesize it below.
rm -f "${CONTENTS}/Info.plist"
cat > "${CONTENTS}/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>English</string>
  <key>CFBundleDisplayName</key><string>${PRODUCT_NAME}</string>
  <key>CFBundleExecutable</key><string>dsh-desktop</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundleIdentifier</key><string>com.deepseek.harness.desktop</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${PRODUCT_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.6.7</string>
  <key>CFBundleVersion</key><string>0.6.7</string>
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

codesign --force --deep --sign - "$APP_DIR"
echo "✅ Debug app: ${APP_DIR}"
echo "   open \"${APP_DIR}\""