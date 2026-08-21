#!/usr/bin/env bash
set -euo pipefail

# 사용법:
#   wiki-source-repair.sh <cwd> list [limit]
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
    # limit(선택, 0=전체). 큰 큐를 한 번에 제시하면 그것만으로 세션 예산을 태우므로
    # 배치로 빼낸다 — 정렬은 trusted 먼저·오래된 감지 먼저라 배치가 재현된다.
    python3 "$PLUGIN_ROOT/core/wiki_source_repair.py" --cwd "$TARGET_CWD" --list \
      --limit "${3:-0}"
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
