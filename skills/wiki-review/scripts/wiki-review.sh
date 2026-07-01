#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
QMD_BACKEND_MANAGER="${QMD_BACKEND_MANAGER:-$PLUGIN_ROOT/core/backend_manager.sh}"
TARGET_CWD="${1:?usage: wiki-review.sh <cwd> <index> <merge|supersede|separate|discard>}"
INDEX="${2:?usage: wiki-review.sh <cwd> <index> <merge|supersede|separate|discard>}"
ACTION="${3:?usage: wiki-review.sh <cwd> <index> <merge|supersede|separate|discard>}"

if [ -z "${QMD_SANDBOX:-}" ]; then
  bash "$QMD_BACKEND_MANAGER" check-qmd --manual
fi

python3 "$PLUGIN_ROOT/core/wiki_review.py" --cwd "$TARGET_CWD" --index "$INDEX" --action "$ACTION"
