#!/bin/zsh
set -euo pipefail
if [[ $# -ne 3 ]]; then echo 'Usage: Sign.command /path/App.app "Developer ID Application: Company (TEAM)" notary-keychain-profile'; exit 2; fi
APP="$1"
IDENTITY="$2"
PROFILE="$3"
ROOT="$(cd "$(dirname "$0")" && pwd)"
/usr/bin/codesign --force --deep --options runtime --entitlements "$ROOT/entitlements.plist" --sign "$IDENTITY" "$APP"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP"
ZIP="$(mktemp -u /tmp/sap-mcp-notary-XXXXXX.zip)"
/usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$APP"
/usr/sbin/spctl --assess --type execute --verbose "$APP"
echo 'Signed, notarized and stapled. Repackage the app after this step.'
