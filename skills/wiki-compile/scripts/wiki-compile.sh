#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
QMD_BACKEND_MANAGER="${QMD_BACKEND_MANAGER:-$PLUGIN_ROOT/core/backend_manager.sh}"
TARGET_CWD="${1:-$PWD}"

if [ -z "${QMD_SANDBOX:-}" ]; then
  bash "$QMD_BACKEND_MANAGER" check-qmd --manual
fi

python3 "$PLUGIN_ROOT/core/wiki_extract.py" --cwd "$TARGET_CWD"
