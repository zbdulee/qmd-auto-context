#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
TARGET_CWD="${1:-$PWD}"
if [ "$#" -gt 0 ]; then shift; fi

cd "$TARGET_CWD"
exec bash "$PLUGIN_ROOT/core/update.sh" "$@"
