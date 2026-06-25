#!/usr/bin/env bash
# qmd index-on-edit worker. dirty 큐 drain → 컬렉션 등록 + update + embed (+ reload).
# bash 3.2 호환 (macOS /bin/bash)
set -u

# sandbox는 어떤 부작용(mkdir 포함)도 없이 즉시 무출력 종료.
[ -n "${QMD_SANDBOX:-}" ] && exit 0

# 유저 격리 경로(멀티유저 /tmp symlink 선점 방지). update.sh와 락 기본값을 통일.
# WRITER_LOCK/EMBED_LOCK 기본값은 update.sh와 반드시 동일해야 직렬화가 유지된다.
_QMD_UID="$(/usr/bin/id -un 2>/dev/null || id -u 2>/dev/null || echo qmd)"
_QMD_LOCK_BASE="${QMD_LOCK_BASE:-${TMPDIR:-/tmp}/qmd-auto-context-locks-${_QMD_UID}}"
_QMD_CACHE_DIR="${QMD_CACHE_DIR:-$HOME/.cache/qmd}"
mkdir -p "$_QMD_CACHE_DIR" "$_QMD_LOCK_BASE" 2>/dev/null || true

QUEUE="${QMD_DIRTY_QUEUE:-$HOME/.config/qmd/dirty-queue}"
WORKER_LOCK="${QMD_INDEX_WORKER_LOCKDIR:-$_QMD_LOCK_BASE/qmd-index-worker.lock.d}"
WRITER_LOCK="${QMD_WRITER_LOCKDIR:-$_QMD_LOCK_BASE/qmd-update.lock.d}"
EMBED_LOCK="${QMD_EMBED_LOCKDIR:-$_QMD_LOCK_BASE/qmd-embed.lock.d}"
# index-worker 동작 로그는 recall 로그(QMD_RECALL_LOG)와 분리한다.
# run-hook이 모든 action에 QMD_RECALL_LOG를 export하므로, 그걸 상속하면
# kick-index 경로에서 worker 로그가 recall 로그 파일로 강제 합쳐진다(그리고 과거엔 /tmp).
# 전용 QMD_INDEX_WORKER_LOG override만 받고, 기본은 유저 격리 캐시 경로.
LOG="${QMD_INDEX_WORKER_LOG:-$_QMD_CACHE_DIR/index-worker.log}"
QMD="${QMD_FAKE_QMD:-qmd}"

log() { printf '[%s] index-worker: %s\n' "$(date '+%H:%M:%S')" "$*" >>"$LOG" 2>&1 || true; }

# requeue: 락 밖 직접 append 대신 dirty_queue.py / snapshot과 동일한 fcntl.flock(LOCK_EX)로
# 큐 파일 자신에 append해 동시 enqueue와 상호배제한다. 엔트리는 argv로 전달(stdin은
# python -c 스크립트가 차지하지 않으므로 argv가 안전). bash 3.2 호환.
# python 실패 시에도 큐 엔트리를 유실하지 않도록 셸 append로 fallback한다.
_REQUEUE_PY='
import fcntl, os, sys
queue = os.environ["QMD_QUEUE"]
entries = [e for e in sys.argv[1:] if e]
if entries:
    # append + LOCK_EX 로 enqueue(dirty_queue.py) 및 snapshot truncate와 동일 락으로 직렬화.
    with open(queue, "a", encoding="utf-8") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        try:
            for e in entries:
                f.write(e + "\n")
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
'
requeue() {
  [ "$#" -gt 0 ] || return 0
  if QMD_QUEUE="$QUEUE" python3 -c "$_REQUEUE_PY" "$@" 2>/dev/null; then
    return 0
  fi
  # fallback (무유실 우선): 락 없이라도 큐에 복원한다.
  log "requeue: python fcntl append failed — fallback to shell append"
  for e in "$@"; do printf '%s\n' "$e" >>"$QUEUE"; done
}

reload_daemon() {
  if [ -n "${QMD_BACKEND_MANAGER:-}" ] && [ -x "$QMD_BACKEND_MANAGER" ]; then
    "$QMD_BACKEND_MANAGER" reload >>"$LOG" 2>&1 || return 0
    return 0
  fi
  log "reload skipped: QMD_BACKEND_MANAGER unavailable"
}

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

# 큐 스냅샷(원자적으로 비우고 처리 — 처리 중 새 enqueue는 다음 tick).
# macOS엔 flock(1) 명령이 없다. core/dirty_queue.py(enqueue)와 동일한 python fcntl.flock으로
# 락을 잡아야 실제로 상호배제된다. flock(1)에 의존하지 않는다(cross-platform).
SNAP="$(mktemp)"
QMD_QUEUE="$QUEUE" QMD_SNAP="$SNAP" python3 - <<'PY' 2>/dev/null || true
import fcntl
import os

queue = os.environ["QMD_QUEUE"]
snap = os.environ["QMD_SNAP"]
# r+ 로 열어 enqueue(append + LOCK_EX)와 직렬화. snapshot 후 truncate.
with open(queue, "r+", encoding="utf-8") as f:
    fcntl.flock(f.fileno(), fcntl.LOCK_EX)
    try:
        data = f.read()
        with open(snap, "w", encoding="utf-8") as s:
            s.write(data)
        f.seek(0)
        f.truncate()
    finally:
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)
PY

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
  requeue "${ENTRIES[@]}"
  exit 0
fi
echo "$$" > "$WRITER_LOCK/pid" 2>/dev/null || true
trap 'rm -f "$WRITER_LOCK/pid" 2>/dev/null; rmdir "$WRITER_LOCK" 2>/dev/null || true; rm -f "$WORKER_LOCK/pid" 2>/dev/null; rmdir "$WORKER_LOCK" 2>/dev/null || true' EXIT

added=0
for e in "${ENTRIES[@]}"; do
  name="${e%%	*}"; path="${e#*	}"
  [ -n "$name" ] && [ -n "$path" ] || continue
  if [ ! -d "$path" ]; then log "skip missing dir: $name -> $path"; continue; fi
  if out=$("$QMD" collection add "$path" --name "$name" 2>&1); then
    added=1
  elif printf '%s' "$out" | grep -qi "already exists"; then
    added=1
  fi
  printf '%s\n' "$out" >>"$LOG"
done
[ "$added" = 0 ] && exit 0

if ! UPDATE_OUT="$("$QMD" update 2>&1)"; then
  printf '%s\n' "$UPDATE_OUT" >>"$LOG"; log "update failed"; exit 0
fi
printf '%s\n' "$UPDATE_OUT" >>"$LOG"

# embed lock 획득 (update.sh 백그라운드 embed와 동시 실행 방지)
# stale 방어: pid liveness 체크 (update.sh 프로토콜과 대칭)
if [ -d "$EMBED_LOCK" ]; then
  epid="$(cat "$EMBED_LOCK/pid" 2>/dev/null || true)"
  { [ -z "$epid" ] || ! kill -0 "$epid" 2>/dev/null; } && { rm -f "$EMBED_LOCK/pid" 2>/dev/null; rmdir "$EMBED_LOCK" 2>/dev/null || true; }
fi
if ! mkdir "$EMBED_LOCK" 2>/dev/null; then
  log "embed lock busy — requeue & defer"
  requeue "${ENTRIES[@]}"
  exit 0
fi
echo "$$" > "$EMBED_LOCK/pid" 2>/dev/null || true
trap 'rm -f "$EMBED_LOCK/pid" 2>/dev/null; rmdir "$EMBED_LOCK" 2>/dev/null || true; rm -f "$WRITER_LOCK/pid" 2>/dev/null; rmdir "$WRITER_LOCK" 2>/dev/null || true; rm -f "$WORKER_LOCK/pid" 2>/dev/null; rmdir "$WORKER_LOCK" 2>/dev/null || true' EXIT

# embed (전체 incremental). 출력에서 새 임베딩 수 파싱.
EMBED_OUT="$("$QMD" embed 2>&1)"; printf '%s\n' "$EMBED_OUT" >>"$LOG"
NEW=$(printf '%s' "$EMBED_OUT" | grep -oE 'Embedded [0-9]+ chunks' | grep -oE '[0-9]+' | head -1)
NEW="${NEW:-0}"
REMOVED=$(printf '%s' "$UPDATE_OUT" | grep -oE '[1-9][0-9]* removed' | grep -oE '^[0-9]+' | head -1)
REMOVED="${REMOVED:-0}"

# reload: 새 임베딩이 있거나 삭제된 항목이 있을 때
if { [ "$NEW" -gt 0 ] || [ "$REMOVED" -gt 0 ]; } && [ -z "${QMD_NO_RELOAD:-}" ]; then
  reload_daemon
fi
exit 0
