#!/usr/bin/env bash
set -euo pipefail

# 사용법:
#   wiki-source-repair.sh <cwd> list
#   wiki-source-repair.sh <cwd> repoint <cardPath> <oldSourcePath> <newSourcePath>
#   wiki-source-repair.sh <cwd> dismiss <cardPath>
#
# 데몬/인덱스를 쓰지 않는 파일시스템 작업이므로 backend manager는 호출하지 않는다.

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
TARGET_CWD="${1:?usage: wiki-source-repair.sh <cwd> <list|repoint|dismiss> [...]}"
ACTION="${2:?usage: wiki-source-repair.sh <cwd> <list|repoint|dismiss> [...]}"

case "$ACTION" in
  list)
    python3 "$PLUGIN_ROOT/core/wiki_source_repair.py" --cwd "$TARGET_CWD" --list
    ;;
  repoint)
    CARD="${3:?usage: wiki-source-repair.sh <cwd> repoint <cardPath> <oldSourcePath> <newSourcePath>}"
    OLD="${4:?usage: wiki-source-repair.sh <cwd> repoint <cardPath> <oldSourcePath> <newSourcePath>}"
    NEW="${5:?usage: wiki-source-repair.sh <cwd> repoint <cardPath> <oldSourcePath> <newSourcePath>}"
    python3 "$PLUGIN_ROOT/core/wiki_source_repair.py" --cwd "$TARGET_CWD" \
      --repoint "$CARD" --from "$OLD" --to "$NEW"
    ;;
  dismiss)
    CARD="${3:?usage: wiki-source-repair.sh <cwd> dismiss <cardPath>}"
    python3 "$PLUGIN_ROOT/core/wiki_source_repair.py" --cwd "$TARGET_CWD" --dismiss "$CARD"
    ;;
  *)
    echo "unknown action: $ACTION (expected list|repoint|dismiss)" >&2
    exit 2
    ;;
esac
