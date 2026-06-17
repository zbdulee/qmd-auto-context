#!/usr/bin/env bash
# qmd index-on-edit worker. dirty 큐 drain → 컬렉션 등록 + update + embed (+ reload).
# bash 3.2 호환 (macOS /bin/bash)
set -u

QUEUE="${QMD_DIRTY_QUEUE:-$HOME/.config/qmd/dirty-queue}"
WORKER_LOCK="${QMD_INDEX_WORKER_LOCKDIR:-/tmp/qmd-index-worker.lock.d}"
WRITER_LOCK="${QMD_WRITER_LOCKDIR:-/tmp/qmd-update.lock.d}"
EMBED_LOCK="${QMD_EMBED_LOCKDIR:-/tmp/qmd-embed.lock.d}"
LOG="${QMD_RECALL_LOG:-/tmp/qmd-index-worker.log}"
QMD="${QMD_FAKE_QMD:-qmd}"
LAUNCHCTL="${QMD_FAKE_LAUNCHCTL:-launchctl}"
DAEMON_PORT="${QMD_DAEMON_PORT:-8483}"

log() { printf '[%s] index-worker: %s\n' "$(date '+%H:%M:%S')" "$*" >>"$LOG" 2>&1 || true; }

reload_daemon() {
  command -v "$LAUNCHCTL" >/dev/null 2>&1 || return 0
  "$LAUNCHCTL" kill TERM "gui/$(id -u)/com.qmd-mcp-daemon" >>"$LOG" 2>&1 || return 0
  log "daemon SIGTERM reload (new embeddings)"
  [ -n "${QMD_HEALTH_SKIP:-}" ] && return 0
  for _ in $(seq 1 30); do
    curl -sf -m 1 "http://127.0.0.1:${DAEMON_PORT}/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
}

[ -n "${QMD_SANDBOX:-}" ] && exit 0
[ -f "$QUEUE" ] || exit 0

# PATH 보정 (비대화형 hook 환경; update.sh와 동일)
[ -d "$HOME/.bun/bin" ] && PATH="$HOME/.bun/bin:$PATH"
FNM_NODE_BIN=$(ls -d "$HOME/.local/share/fnm/node-versions"/v*/installation/bin 2>/dev/null | sort -V | tail -1)
[ -n "$FNM_NODE_BIN" ] && PATH="$FNM_NODE_BIN:$PATH"
unset BUN_INSTALL; export PATH

# single-flight
if ! mkdir "$WORKER_LOCK" 2>/dev/null; then
  if [ -n "$(find "$WORKER_LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
    rm -f "$WORKER_LOCK/pid" 2>/dev/null; rmdir "$WORKER_LOCK" 2>/dev/null || true
  fi
  exit 0
fi
echo "$$" > "$WORKER_LOCK/pid" 2>/dev/null || true
trap 'rm -f "$WORKER_LOCK/pid" 2>/dev/null; rmdir "$WORKER_LOCK" 2>/dev/null || true' EXIT

# 큐 스냅샷(원자적으로 비우고 처리 — 처리 중 새 enqueue는 다음 tick)
SNAP="$(mktemp)"
{
  exec 9<"$QUEUE"; flock 9
  cat "$QUEUE" >"$SNAP"; : >"$QUEUE"
  flock -u 9; exec 9<&-
} 2>/dev/null

# dedupe (name\tpath) — bash 3.2 호환 (mapfile 미사용)
ENTRIES=()
while IFS= read -r line; do
  [ -n "$line" ] && ENTRIES+=("$line")
done < <(sort -u "$SNAP")
rm -f "$SNAP"
[ "${#ENTRIES[@]}" -eq 0 ] && exit 0

# writer lock (update.sh와 공유) — busy면 큐 복원 후 종료
if ! mkdir "$WRITER_LOCK" 2>/dev/null; then
  log "writer lock busy — requeue & defer"
  for e in "${ENTRIES[@]}"; do printf '%s\n' "$e" >>"$QUEUE"; done
  exit 0
fi
echo "$$" > "$WRITER_LOCK/pid" 2>/dev/null || true
trap 'rm -f "$WRITER_LOCK/pid" 2>/dev/null; rmdir "$WRITER_LOCK" 2>/dev/null || true; rm -f "$WORKER_LOCK/pid" 2>/dev/null; rmdir "$WORKER_LOCK" 2>/dev/null || true' EXIT

added=0
for e in "${ENTRIES[@]}"; do
  name="${e%%	*}"; path="${e#*	}"
  [ -n "$name" ] && [ -n "$path" ] || continue
  if [ ! -d "$path" ]; then log "skip missing dir: $name -> $path"; continue; fi
  "$QMD" collection add "$path" --name "$name" >>"$LOG" 2>&1 && added=1
done
[ "$added" = 0 ] && exit 0

"$QMD" update >>"$LOG" 2>&1 || { log "update failed"; exit 0; }

# embed lock 획득 (update.sh 백그라운드 embed와 동시 실행 방지)
# stale 방어: pid liveness 체크 (update.sh 프로토콜과 대칭)
if [ -d "$EMBED_LOCK" ]; then
  epid="$(cat "$EMBED_LOCK/pid" 2>/dev/null || true)"
  { [ -z "$epid" ] || ! kill -0 "$epid" 2>/dev/null; } && { rm -f "$EMBED_LOCK/pid" 2>/dev/null; rmdir "$EMBED_LOCK" 2>/dev/null || true; }
fi
if ! mkdir "$EMBED_LOCK" 2>/dev/null; then
  log "embed lock busy — requeue & defer"
  for e in "${ENTRIES[@]}"; do printf '%s\n' "$e" >>"$QUEUE"; done
  exit 0
fi
echo "$$" > "$EMBED_LOCK/pid" 2>/dev/null || true
trap 'rm -f "$EMBED_LOCK/pid" 2>/dev/null; rmdir "$EMBED_LOCK" 2>/dev/null || true; rm -f "$WRITER_LOCK/pid" 2>/dev/null; rmdir "$WRITER_LOCK" 2>/dev/null || true; rm -f "$WORKER_LOCK/pid" 2>/dev/null; rmdir "$WORKER_LOCK" 2>/dev/null || true' EXIT

# embed (전체 incremental). 출력에서 새 임베딩 수 파싱.
EMBED_OUT="$("$QMD" embed 2>&1)"; printf '%s\n' "$EMBED_OUT" >>"$LOG"
NEW=$(printf '%s' "$EMBED_OUT" | grep -oE 'Embedded [0-9]+ chunks' | grep -oE '[0-9]+' | head -1)
NEW="${NEW:-0}"

# reload: 새 임베딩이 있을 때만
if [ "$NEW" -gt 0 ] && [ -z "${QMD_NO_RELOAD:-}" ]; then
  reload_daemon
fi
exit 0
