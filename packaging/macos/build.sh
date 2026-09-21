#!/bin/zsh
set -euo pipefail
if [[ $# -lt 2 ]]; then echo 'Usage: build.sh /path/previous-macOS.zip /path/output [arm64|x64]'; exit 2; fi
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ARCH="${3:-$(uname -m)}"
[[ "$ARCH" == 'x86_64' ]] && ARCH='x64'
python3 "$ROOT/packaging/build-desktop.py" --platform "darwin-$ARCH" --base "$1" --output "$2"
