#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
QMD_BACKEND_MANAGER="${QMD_BACKEND_MANAGER:-$PLUGIN_ROOT/core/backend_manager.sh}"
TARGET_CWD="${1:-$PWD}"
if [ "$#" -gt 0 ]; then shift; fi

if [ -z "${QMD_SANDBOX:-}" ]; then
  bash "$QMD_BACKEND_MANAGER" check-qmd --manual
fi

out="$(python3 "$PLUGIN_ROOT/core/sync.py" --cwd "$TARGET_CWD" --json "$@")"
printf '%s\n' "$out"

if [ -z "${QMD_SANDBOX:-}" ]; then
  case " $* " in
    *" --dry-run "*|*" --baseline-only "*) ;;
    *) bash "$QMD_BACKEND_MANAGER" kick-index >/dev/null 2>&1 || true ;;
  esac
fi
