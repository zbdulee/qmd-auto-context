#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
export CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}"
TARGET_CWD="${1:-$PWD}"
if [ "$#" -gt 0 ]; then shift; fi

exec bash "$PLUGIN_ROOT/core/update.sh" --enable-compile "$TARGET_CWD" "$@"
