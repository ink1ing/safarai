#!/bin/zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_PATH="$ROOT_DIR/safarai/safarai.xcodeproj"
SCHEME="safarai"
DERIVED_DATA_PATH="$ROOT_DIR/.derived-data-beta"
BUILD_CONFIGURATION="Release"
DATE_STAMP="$(date +%Y%m%d)"
VERSION_LABEL="beta-${DATE_STAMP}"
OUTPUT_DIR="$ROOT_DIR/dist/$VERSION_LABEL"
STAGING_DIR="$OUTPUT_DIR/staging"
APP_SOURCE="$DERIVED_DATA_PATH/Build/Products/$BUILD_CONFIGURATION/safarai.app"
DMG_PATH="$OUTPUT_DIR/safarai-${VERSION_LABEL}-unsigned.dmg"
README_PATH="$STAGING_DIR/INSTALL.txt"

rm -rf "$OUTPUT_DIR"
mkdir -p "$STAGING_DIR"

xcodebuild \
  -project "$PROJECT_PATH" \
  -scheme "$SCHEME" \
  -configuration "$BUILD_CONFIGURATION" \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  CODE_SIGNING_ALLOWED=NO \
  build \
  -quiet

if [[ ! -d "$APP_SOURCE" ]]; then
  echo "Build finished but app not found at: $APP_SOURCE" >&2
  exit 1
fi

cp -R "$APP_SOURCE" "$STAGING_DIR/"
ln -s /Applications "$STAGING_DIR/Applications"

cat > "$README_PATH" <<EOF
Safari AI Sidebar ${VERSION_LABEL}

This is an unsigned beta build for local testing.

Install:
1. Drag safarai.app to Applications.
2. Open the app once from Applications.
3. Enable the Safari extension in Safari Settings > Extensions.
4. If macOS blocks the app, open System Settings > Privacy & Security and allow it manually.

Notes:
- This package is not signed or notarized.
- This package is built from the Release configuration but is still unsigned.
- Use this build for self-testing or limited internal testing only.
EOF

hdiutil create \
  -volname "Safari AI Sidebar ${VERSION_LABEL}" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH" >/dev/null

echo "Created beta package:"
echo "$DMG_PATH"
