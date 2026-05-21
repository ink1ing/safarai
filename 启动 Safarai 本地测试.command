#!/bin/zsh
set -e

PROJECT_DIR="/Users/silas/Desktop/safarai-main"
XCODE_PROJECT="$PROJECT_DIR/safarai/safarai.xcodeproj"
SCHEME="safarai"
DERIVED_DATA_DIR="$PROJECT_DIR/.build/DerivedData"
BUILT_APP="$DERIVED_DATA_DIR/Build/Products/Debug/safarai.app"
INSTALL_APP="/Applications/Safarai Local.app"
INSTALL_EXTENSION="$INSTALL_APP/Contents/PlugIns/safarai Extension.appex"
APP_ENTITLEMENTS="$PROJECT_DIR/safarai/safarai/safarai.entitlements"
EXTENSION_ENTITLEMENTS="$PROJECT_DIR/safarai/safarai Extension/safarai Extension.entitlements"
LOCAL_EXTENSION_ENTITLEMENTS="$PROJECT_DIR/safarai/safarai Extension/local-test.entitlements"
LOCAL_SHARED_DIR="$HOME/Library/Application Support/Safarai Local Shared"
LEGACY_GROUP_DIR="$HOME/Library/Group Containers/group.ink.safarai"

cd "$PROJECT_DIR"

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "xcodebuild not found. Please install or select Xcode first."
  echo "Press any key to close..."
  read -k 1
  exit 1
fi

build_and_install() {
  local started_at
  started_at="$(date '+%H:%M:%S')"
  echo "[$started_at] Building and reinstalling Safarai Local..."

  xcodebuild \
    -project "$XCODE_PROJECT" \
    -scheme "$SCHEME" \
    -configuration Debug \
    -derivedDataPath "$DERIVED_DATA_DIR" \
    CODE_SIGNING_ALLOWED=NO \
    -quiet \
    build

  if [[ ! -d "$BUILT_APP" ]]; then
    echo "Build finished, but app was not found:"
    echo "$BUILT_APP"
    return 1
  fi

  pkill -f "$INSTALL_APP/Contents/MacOS/safarai" >/dev/null 2>&1 || true
  pkill -f "$INSTALL_EXTENSION/Contents/MacOS/safarai Extension" >/dev/null 2>&1 || true
  sleep 0.4

  rm -rf "$INSTALL_APP"
  ditto "$BUILT_APP" "$INSTALL_APP"
  mkdir -p "$LOCAL_SHARED_DIR"
  if [[ -d "$LEGACY_GROUP_DIR" ]]; then
    for item in \
      ui-settings.json \
      active-provider.json \
      provider.json \
      openai-compatible-provider.json \
      zed-account.json \
      codex-account.json \
      codex-login-state.json \
      codex-login-request.json \
      panel-state.json \
      selection-intent.json \
      chat-history
    do
      if [[ -e "$LEGACY_GROUP_DIR/$item" && ! -e "$LOCAL_SHARED_DIR/$item" ]]; then
        ditto "$LEGACY_GROUP_DIR/$item" "$LOCAL_SHARED_DIR/$item"
      fi
    done
  fi
  chmod 700 "$LOCAL_SHARED_DIR" 2>/dev/null || true
  find "$LOCAL_SHARED_DIR" -type d -exec chmod 700 {} \; 2>/dev/null || true
  find "$LOCAL_SHARED_DIR" -type f -name "*.json" -exec chmod 600 {} \; 2>/dev/null || true
  /usr/bin/codesign --force --sign - --entitlements "$LOCAL_EXTENSION_ENTITLEMENTS" "$INSTALL_EXTENSION"
  /usr/bin/codesign --force --sign - "$INSTALL_APP"
  /usr/bin/codesign --verify --deep --strict "$INSTALL_APP"
  /usr/bin/pluginkit -a "$INSTALL_EXTENSION"
  xattr -dr com.apple.quarantine "$INSTALL_APP" >/dev/null 2>&1 || true
  open "$INSTALL_APP"

  echo "[$(date '+%H:%M:%S')] Installed and launched: $INSTALL_APP"
  echo "Safari extension registered as: ink.safarai.Extension"
  echo "If Safari does not show it, enable Safari > Develop > Allow Unsigned Extensions, then Safari Settings > Extensions > Safarai."
}

clear
echo "Safarai local test launcher"
echo "Project: $PROJECT_DIR"
echo "Install target: $INSTALL_APP"
echo

build_and_install

echo
echo "Silent watch mode is active."
echo "Press Enter to rebuild and overwrite the installed app."
echo "Type q then Enter to quit."

while true; do
  printf "> "
  IFS= read -r command
  if [[ "$command" == "q" || "$command" == "quit" || "$command" == "exit" ]]; then
    echo "Bye."
    exit 0
  fi

  build_and_install || {
    echo "Reinstall failed. Fix the build error and press Enter to retry."
  }
done
