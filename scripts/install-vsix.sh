#!/usr/bin/env sh
set -e
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
VSIX_FILE="$ROOT_DIR/binsight-0.1.0.vsix"

rm -f "$ROOT_DIR/binsight-0.2.0.vsix"
python3 "$SCRIPT_DIR/package-vsix.py"
NODE_OPTIONS="--no-deprecation" code --install-extension "$VSIX_FILE" --force
echo "----------------------------------------------------------------"
echo "✅ Installed $VSIX_FILE"
echo "👉 In VS Code, press Ctrl+Shift+P -> 'Developer: Reload Window'"
echo "----------------------------------------------------------------"
