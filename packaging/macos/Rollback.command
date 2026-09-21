#!/bin/zsh
set -euo pipefail
sleep 3
DEST="$HOME/Applications/SAP MCP Desktop Bridge.app"
DATA="$HOME/Library/Application Support/SAP MCP Desktop Bridge"
NODE="$DEST/Contents/Resources/runtime/bin/node"
PREVIOUS="$("$NODE" -e 'const fs=require("fs"),path=require("path");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(m.current!==process.argv[2]||!m.previous.startsWith(path.join(process.env.HOME,"Applications",".sap-mcp-bridge-backup-"))||path.dirname(m.previous)!==path.join(process.env.HOME,"Applications"))process.exit(1);console.log(m.previous)' "$DATA/update-rollback.json" "$DEST")"
[[ -d "$PREVIOUS" ]]
REPLACED="$DEST.replaced-$$"
mv "$DEST" "$REPLACED"
if ! mv "$PREVIOUS" "$DEST"; then mv "$REPLACED" "$DEST"; exit 1; fi
rm "$DATA/update-rollback.json"
