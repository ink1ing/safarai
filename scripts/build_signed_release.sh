#!/bin/zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_PATH="$ROOT_DIR/safarai/safarai.xcodeproj"
SCHEME="safarai"
ARCHIVE_PATH="$ROOT_DIR/dist/release/safarai.xcarchive"
EXPORT_DIR="$ROOT_DIR/dist/release/export"
STAGING_DIR="$ROOT_DIR/dist/release/staging"
NOTES_DIR="$ROOT_DIR/dist/release/notes"
NOTARY_PROFILE="${APPLE_NOTARY_PROFILE:-}"
PUBLISH_TO_GITHUB="${PUBLISH_TO_GITHUB:-0}"

mkdir -p "$ROOT_DIR/dist/release"

function fail() {
  echo "error: $1" >&2
  exit 1
}

function require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

function read_build_setting() {
  local key="$1"
  xcodebuild -project "$PROJECT_PATH" -scheme "$SCHEME" -showBuildSettings 2>/dev/null \
    | awk -F' = ' -v key="$key" '$1 ~ key"$" {print $2; exit}'
}

function require_developer_id() {
  local identities
  identities="$(security find-identity -v -p codesigning 2>/dev/null || true)"
  if ! echo "$identities" | grep -q "Developer ID Application"; then
    fail "Developer ID Application certificate not found. Install a valid Developer ID Application certificate before building a distributable release."
  fi
}

function require_notary_profile() {
  [[ -n "$NOTARY_PROFILE" ]] || fail "APPLE_NOTARY_PROFILE is not set. Create a notarytool keychain profile and export APPLE_NOTARY_PROFILE before running this script."
}

require_command xcodebuild
require_command xcrun
require_command hdiutil
require_command ditto

require_developer_id
require_notary_profile

VERSION="$(read_build_setting MARKETING_VERSION)"
BUILD="$(read_build_setting CURRENT_PROJECT_VERSION)"
TEAM_ID="$(read_build_setting DEVELOPMENT_TEAM)"

[[ -n "$VERSION" ]] || fail "Unable to resolve MARKETING_VERSION from build settings."
[[ -n "$BUILD" ]] || fail "Unable to resolve CURRENT_PROJECT_VERSION from build settings."
[[ -n "$TEAM_ID" ]] || fail "Unable to resolve DEVELOPMENT_TEAM from build settings."

RELEASE_ID="v${VERSION}"
DMG_NAME="safarai-${RELEASE_ID}-build${BUILD}-macos.dmg"
DMG_PATH="$ROOT_DIR/dist/release/${DMG_NAME}"
RELEASE_NOTES_PATH="$ROOT_DIR/docs/releases/${RELEASE_ID}.md"
INSTALLER_README="$STAGING_DIR/INSTALL.txt"

rm -rf "$ARCHIVE_PATH" "$EXPORT_DIR" "$STAGING_DIR" "$DMG_PATH"
mkdir -p "$EXPORT_DIR" "$STAGING_DIR" "$NOTES_DIR"

if [[ ! -f "$RELEASE_NOTES_PATH" ]]; then
  fail "Release notes file not found: $RELEASE_NOTES_PATH"
fi

echo "Archiving ${SCHEME} ${RELEASE_ID} (${BUILD})..."
xcodebuild \
  -project "$PROJECT_PATH" \
  -scheme "$SCHEME" \
  -configuration Release \
  -archivePath "$ARCHIVE_PATH" \
  archive \
  -quiet

APP_PATH="$ARCHIVE_PATH/Products/Applications/safarai.app"
[[ -d "$APP_PATH" ]] || fail "Archived app not found at $APP_PATH"

echo "Validating code signature..."
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
spctl --assess --type execute --verbose=2 "$APP_PATH" || true

echo "Preparing DMG staging..."
cp -R "$APP_PATH" "$STAGING_DIR/"
ln -s /Applications "$STAGING_DIR/Applications"
cp "$RELEASE_NOTES_PATH" "$NOTES_DIR/"

cat > "$INSTALLER_README" <<EOF
Safari AI Sidebar ${RELEASE_ID} (${BUILD})

Install:
1. Quit the running Safarai app.
2. Drag safarai.app to Applications and replace the previous version.
3. Launch the app from Applications.
4. Confirm the Safari extension is still enabled in Safari Settings > Extensions.

Rollback:
1. Keep the previous DMG until the new version is verified.
2. If the new version fails, remove /Applications/safarai.app.
3. Reinstall the previous known-good DMG.

Release notes:
$(basename "$RELEASE_NOTES_PATH")
EOF

echo "Creating DMG..."
hdiutil create \
  -volname "Safari AI Sidebar ${RELEASE_ID}" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH" >/dev/null

echo "Submitting DMG for notarization..."
xcrun notarytool submit "$DMG_PATH" \
  --keychain-profile "$NOTARY_PROFILE" \
  --wait

echo "Stapling DMG..."
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"

echo "Release artifact ready:"
echo "$DMG_PATH"

if [[ "$PUBLISH_TO_GITHUB" == "1" ]]; then
  require_command gh
  echo "Publishing release ${RELEASE_ID} to GitHub..."
  gh release create "$RELEASE_ID" \
    "$DMG_PATH" \
    --repo ink1ing/safarai \
    --title "Safari AI Sidebar ${RELEASE_ID}" \
    --notes-file "$RELEASE_NOTES_PATH"
fi
