#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="SAP MCP Desktop Bridge.app"
DEST="$HOME/Applications/$APP_NAME"
NEW="$HOME/Applications/.sap-mcp-bridge-stage-$$.app"
OLD="$HOME/Applications/.sap-mcp-bridge-backup-$(date +%s)-$$.app"
SHORTCUT="$HOME/Applications/SAP MCP Connection Manager.app"
DATA="$HOME/Library/Application Support/SAP MCP Desktop Bridge"
PLACED=0
CREATED_LINK=0
MARKER_CHANGED=0
MARKER_BACKUP="$DATA/update-rollback.json.before-$$"
rollback() {
  local code=$?
  if [[ $code -ne 0 ]]; then
    if [[ $PLACED -eq 1 && -e "$DEST" ]]; then mv "$DEST" "$DEST.failed-$$"; fi
    if [[ -e "$OLD" && ! -e "$DEST" ]]; then mv "$OLD" "$DEST"; fi
    if [[ $CREATED_LINK -eq 1 && -L "$SHORTCUT" ]]; then unlink "$SHORTCUT"; fi
    if [[ $MARKER_CHANGED -eq 1 ]]; then
      if [[ -e "$MARKER_BACKUP" ]]; then mv "$MARKER_BACKUP" "$DATA/update-rollback.json"; else rm -f "$DATA/update-rollback.json"; fi
    fi
    echo 'Installation failed. The previous application and client settings were restored where possible.' >&2
  fi
  return $code
}
trap rollback EXIT
mkdir -p "$HOME/Applications"
cp -R "$SCRIPT_DIR/$APP_NAME" "$NEW"
# Apple Silicon requires a local code seal; this is not a trusted publisher signature.
if /usr/bin/codesign --verify --deep --strict "$NEW" 2>/dev/null && /usr/bin/codesign -dv "$NEW" 2>&1 | /usr/bin/grep -q 'Authority=Developer ID Application'; then
  echo 'Preserving verified Developer ID signature.'
else
  /usr/bin/codesign --force --deep --sign - "$NEW"
fi
if [[ -e "$DEST" ]]; then mv "$DEST" "$OLD"; fi
mv "$NEW" "$DEST"
PLACED=1
if [[ ! -e "$SHORTCUT" && ! -L "$SHORTCUT" ]]; then ln -s "$DEST" "$SHORTCUT"; CREATED_LINK=1; fi
if [[ -e "$OLD" ]]; then
  mkdir -p "$DATA"
  if [[ -e "$DATA/update-rollback.json" ]]; then cp "$DATA/update-rollback.json" "$MARKER_BACKUP"; fi
  MARKER_CHANGED=1
  "$DEST/Contents/Resources/runtime/bin/node" -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({previous:process.argv[2],current:process.argv[3],installedAt:new Date().toISOString()}))' "$DATA/update-rollback.json" "$OLD" "$DEST"
fi
"$DEST/Contents/Resources/runtime/bin/node" "$DEST/Contents/Resources/app/src/configure-cli.js" --transactional
trap - EXIT
echo 'Installed. Open SAP MCP Connection Manager from Applications when ready.'
/usr/bin/osascript -e 'display dialog "SAP MCP Bridge successfully installed!\n\nOpen SAP MCP Connection Manager from Applications when you are ready." with title "Installation complete" buttons {"OK"} default button "OK" with icon note' || true
