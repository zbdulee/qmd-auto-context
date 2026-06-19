#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
QMD_BACKEND_MANAGER="${QMD_BACKEND_MANAGER:-$PLUGIN_ROOT/core/backend_manager.sh}"
TARGET_CWD="${1:-$PWD}"
if [ "$#" -gt 0 ]; then shift; fi

if [ -z "${QMD_SANDBOX:-}" ]; then
  bash "$QMD_BACKEND_MANAGER" check-qmd --manual
  bash "$QMD_BACKEND_MANAGER" ensure --wait >/dev/null 2>&1 || true
  bash "$QMD_BACKEND_MANAGER" warm >/dev/null 2>&1 || true
  bash "$QMD_BACKEND_MANAGER" rotate >/dev/null 2>&1 || true
fi

cd "$TARGET_CWD"
export QMD_BACKEND_MANAGER
exec bash "$PLUGIN_ROOT/core/update.sh" "$@"
