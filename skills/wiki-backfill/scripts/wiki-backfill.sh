#!/usr/bin/env bash
# Backfill wiki cards for source documents that never reached the compile queue.
#
# Subcommands:
#   plan  <cwd> [--limit N]            read-only: what would be enqueued (no writes, no cost)
#   run   <cwd> [--limit N]            enqueue with explicit consent (costs host CLI calls)
#   drain <cwd> [--runs N]             drive the compile worker until the queue empties
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
QMD_BACKEND_MANAGER="${QMD_BACKEND_MANAGER:-$PLUGIN_ROOT/core/backend_manager.sh}"

ACTION="${1:-plan}"
TARGET_CWD="${2:-$PWD}"
if [ "$#" -gt 0 ]; then shift; fi
if [ "$#" -gt 0 ]; then shift; fi

case "$ACTION" in
  plan)
    python3 "$PLUGIN_ROOT/core/wiki_backfill.py" --cwd "$TARGET_CWD" --json "$@"
    ;;
  run)
    if [ -z "${QMD_SANDBOX:-}" ]; then
      bash "$QMD_BACKEND_MANAGER" check-qmd --manual
    fi
    python3 "$PLUGIN_ROOT/core/wiki_backfill.py" --cwd "$TARGET_CWD" --json --consent "$@"
    ;;
  drain)
    # 컴파일 워커를 유계 횟수만큼 순차 실행한다. 워커는 per-run 상한
    # (compile.batch.maxPerRun)이 있어 한 번에 큐를 다 비우지 않고 초과분을 requeue하므로,
    # 백필 큐를 소화하려면 여러 run이 필요하다. 무한 루프를 만들지 않기 위해 횟수 상한을
    # 두고, remaining 이 0 이면 즉시 멈춘다.
    RUNS=8
    if [ "${1:-}" = "--runs" ] && [ -n "${2:-}" ]; then RUNS="$2"; shift 2; fi
    for i in $(seq 1 "$RUNS"); do
      out="$(python3 "$PLUGIN_ROOT/core/wiki_compile_worker.py" --cwd "$TARGET_CWD" --json --flush-all || true)"
      printf 'run %s: %s\n' "$i" "$out"
      case "$out" in
        *'"remaining": 0'*) break ;;
        "") break ;;
      esac
    done
    ;;
  *)
    echo "usage: wiki-backfill.sh plan|run|drain <cwd> [flags]" >&2
    exit 2
    ;;
esac
