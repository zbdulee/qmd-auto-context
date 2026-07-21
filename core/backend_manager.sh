#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)" || exit 0
PORT="${QMD_DAEMON_PORT:-8483}"
STATE_DIR="${QMD_BACKEND_STATE_DIR:-${TMPDIR:-/tmp}/qmd-auto-context-backend}"
PID_FILE="${QMD_DAEMON_PID:-$STATE_DIR/daemon.pid}"
MANAGER_LOG="${QMD_BACKEND_LOG:-$HOME/.cache/qmd/backend-manager.log}"
DAEMON_LOG="${QMD_DAEMON_LOG:-$HOME/.cache/qmd/mcp.daemon.log}"
DAEMON_SCRIPT="${QMD_DAEMON_SCRIPT:-$ROOT/backend/daemon.sh}"
KEEPALIVE_SCRIPT="${QMD_KEEPALIVE_SCRIPT:-$ROOT/backend/keepalive.sh}"
LOGROTATE_SCRIPT="${QMD_LOGROTATE_SCRIPT:-$ROOT/backend/logrotate.sh}"
INDEX_WORKER_SCRIPT="${QMD_INDEX_WORKER_SCRIPT:-$ROOT/backend/index_worker.sh}"
COMPILE_WORKER_SCRIPT="${QMD_COMPILE_WORKER_SCRIPT:-$ROOT/core/wiki_compile_worker.py}"
KICK_LOCK="${QMD_WORKER_KICK_LOCKDIR:-$STATE_DIR/index-kick.lock.d}"
COMPILE_KICK_LOCK="${QMD_COMPILE_WORKER_KICK_LOCKDIR:-$STATE_DIR/wiki-compile-kick.lock.d}"
START_LOCK="${QMD_DAEMON_START_LOCKDIR:-$STATE_DIR/daemon-start.lock.d}"
REQUIRED_QMD_VERSION="${QMD_REQUIRED_VERSION:-2.5.3}"
SUPPORTED_QMD_MAJOR="${QMD_SUPPORTED_MAJOR:-2}"

. "$ROOT/core/qmd_path.sh"

mkdir -p "$STATE_DIR" "$(dirname "$MANAGER_LOG")" "$(dirname "$DAEMON_LOG")" 2>/dev/null || true

log() {
  printf '[%s] backend-manager: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$MANAGER_LOG" 2>&1 || true
}

qmd_health_timeout() {
  python3 - <<'PY'
import math
import os

default = 2.0
try:
    value = float(os.environ.get("QMD_HEALTH_TIMEOUT", default))
except (TypeError, ValueError):
    value = default
if not math.isfinite(value) or value <= 0:
    value = default
print(f"{value:g}")
PY
}

health() {
  local timeout
  timeout="$(qmd_health_timeout)"
  # localhost(not 127.0.0.1): qmd 데몬은 IPv6 ::1에만 바인딩된다. 127.0.0.1(IPv4)로
  # 찌르면 refused → false-dead 판정 → 데몬 재시작 crash loop. curl localhost는
  # ::1/127.0.0.1 둘 다 시도하므로 바인딩 계열과 무관하게 안전(recall.py·keepalive.sh와 일치).
  curl -sf -m "$timeout" "http://localhost:${PORT}/health" >/dev/null 2>&1
}

qmd_version() {
  local qmd_bin
  qmd_bin="$(resolve_qmd_bin 2>/dev/null)" || return 1
  "$qmd_bin" --version 2>/dev/null | sed -E 's/^qmd[[:space:]]+//'
}

version_ok() {
  local version="$1"
  python3 - "$version" "$REQUIRED_QMD_VERSION" "$SUPPORTED_QMD_MAJOR" <<'PY'
import re
import sys

version, required, major = sys.argv[1:4]

def parse(v):
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$", v.strip())
    if not m:
        raise ValueError(v)
    return tuple(int(x) for x in m.groups())

try:
    current = parse(version)
    minimum = parse(required)
    supported_major = int(major)
except ValueError:
    sys.exit(1)

if current[0] != supported_major:
    sys.exit(1)
sys.exit(0 if current >= minimum else 1)
PY
}

install_hint() {
  printf 'qmd is not installed or is too old. Install a tested qmd version:\n'
  printf '  bun add -g @tobilu/qmd@%s\n' "$REQUIRED_QMD_VERSION"
  printf '  # or: npm install -g @tobilu/qmd@%s\n' "$REQUIRED_QMD_VERSION"
}

check_qmd() {
  local mode="${1:-}"
  local version
  version="$(qmd_version || true)"
  if [ -z "$version" ] || ! version_ok "$version"; then
    log "qmd dependency missing_or_unsupported version=${version:-missing} required=$REQUIRED_QMD_VERSION major=$SUPPORTED_QMD_MAJOR"
    [ "$mode" = "--manual" ] && install_hint
    return 1
  fi
  return 0
}

pid_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

pid_command() {
  local pid="$1"
  ps -p "$pid" -o command= 2>/dev/null || true
}

pid_is_daemon() {
  local pid="$1"
  local cmd
  pid_alive "$pid" || return 1
  cmd="$(pid_command "$pid")"
  printf '%s' "$cmd" | grep -q "mcp --http" || return 1
  printf '%s' "$cmd" | grep -q -- "--port $PORT" || return 1
}

pid_is_starting_daemon() {
  local pid="$1"
  local cmd
  pid_alive "$pid" || return 1
  cmd="$(pid_command "$pid")"
  printf '%s' "$cmd" | grep -q "bash $DAEMON_SCRIPT" && return 0
  printf '%s' "$cmd" | grep -q "backend/daemon.sh" && return 0
  return 1
}

read_pid() {
  cat "$PID_FILE" 2>/dev/null || true
}

start_daemon() {
  check_qmd >/dev/null 2>&1 || return 0
  health && return 0
  if ! mkdir "$START_LOCK" 2>/dev/null; then
    if [ -n "$(find "$START_LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
      rmdir "$START_LOCK" 2>/dev/null || true
      mkdir "$START_LOCK" 2>/dev/null || { wait_health || true; return 0; }
    else
      wait_health || true
      return 0
    fi
  fi
  local pid
  pid="$(read_pid)"
  if pid_is_daemon "$pid" || pid_is_starting_daemon "$pid"; then
    rmdir "$START_LOCK" 2>/dev/null || true
    return 0
  fi
  rm -f "$PID_FILE" 2>/dev/null || true
  QMD_DAEMON_PORT="$PORT" nohup bash "$DAEMON_SCRIPT" >>"$DAEMON_LOG" 2>&1 &
  echo "$!" >"$PID_FILE" 2>/dev/null || true
  log "daemon start pid=$!"
  rmdir "$START_LOCK" 2>/dev/null || true
}

wait_health() {
  local max="${QMD_DAEMON_READY_ATTEMPTS:-60}"
  local i=0
  while [ "$i" -lt "$max" ]; do
    health && return 0
    i=$((i + 1))
    sleep 0.5
  done
  log "daemon health wait timeout port=$PORT"
  return 1
}

cleanup_legacy() {
  local launch_agents="$HOME/Library/LaunchAgents"
  local qmd_config="$HOME/.config/qmd"
  local label plist script path
  for label in com.qmd-mcp-daemon com.qmd-keepalive com.qmd-logrotate com.qmd-index-worker; do
    plist="$launch_agents/$label.plist"
    if has_marker "$plist"; then
      if command -v launchctl >/dev/null 2>&1; then
        launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || launchctl unload "$plist" >/dev/null 2>&1 || true
      fi
      rm -f "$plist" 2>/dev/null || true
      log "removed legacy LaunchAgent $label"
    fi
  done
  for script in daemon.sh keepalive.sh logrotate.sh index_worker.sh; do
    path="$qmd_config/$script"
    if has_marker "$path"; then
      rm -f "$path" 2>/dev/null || true
      log "removed legacy script $path"
    fi
  done
}

ensure() {
  [ "${QMD_CLEANUP_LEGACY:-}" = "1" ] && cleanup_legacy >/dev/null 2>&1 || true
  check_qmd >/dev/null 2>&1 || return 0
  start_daemon
  if [ "${1:-}" = "--wait" ]; then
    wait_health || true
  fi
}

warm() {
  QMD_DAEMON_PORT="$PORT" bash "$KEEPALIVE_SCRIPT" >/dev/null 2>&1 || true
}

rotate() {
  QMD_DAEMON_PORT="$PORT" QMD_DAEMON_PID="$PID_FILE" QMD_DAEMON_LOG="$DAEMON_LOG" bash "$LOGROTATE_SCRIPT" >/dev/null 2>&1 || true
}

wait_pid_exit() {
  local pid="$1"
  local max="${QMD_DAEMON_SHUTDOWN_ATTEMPTS:-60}"
  local i=0
  while [ "$i" -lt "$max" ]; do
    pid_is_daemon "$pid" || return 0
    i=$((i + 1))
    sleep 0.5
  done
  log "daemon graceful shutdown timeout pid=$pid"
  return 1
}

reload() {
  local pid
  pid="$(read_pid)"
  if pid_is_daemon "$pid"; then
    kill -TERM "$pid" >/dev/null 2>&1 || true
    log "daemon SIGTERM pid=$pid"
    wait_pid_exit "$pid" || return 0
  elif [ -n "$pid" ]; then
    log "ignore stale/non-qmd daemon pid=$pid"
  fi
  rm -f "$PID_FILE" 2>/dev/null || true
  start_daemon
  wait_health || true
}

kick_index() {
  if ! mkdir "$KICK_LOCK" 2>/dev/null; then
    if [ -n "$(find "$KICK_LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
      rm -f "$KICK_LOCK/pid" "$KICK_LOCK/rekick" 2>/dev/null || true
      rmdir "$KICK_LOCK" 2>/dev/null || true
      mkdir "$KICK_LOCK" 2>/dev/null || return 0
    else
      # busy: 실행 중인 worker에게 재-drain 요청(lost-wakeup 방지). worker가 큐를
      # 스냅샷한 뒤 enqueue된 항목이 다음 루프에서 처리된다. 이걸 안 하면 KICK_LOCK을
      # 쥔 긴 embed(수 분) 동안 들어온 compile/verify 카드가 다음 SessionStart까지 대기.
      : >"$KICK_LOCK/rekick" 2>/dev/null || true
      return 0
    fi
  fi
  (
    # trap이 rekick도 지워야 rmdir(빈 디렉토리 요구)이 성공한다 — 안 지우면 lock 누수.
    trap 'rm -f "$KICK_LOCK/pid" "$KICK_LOCK/rekick" 2>/dev/null; rmdir "$KICK_LOCK" 2>/dev/null || true' EXIT
    echo "$$" >"$KICK_LOCK/pid" 2>/dev/null || true
    while :; do
      # 이번 run이 커버할 것으로 간주하고 요청을 먼저 소비. run "도중" 들어온 rekick만
      # 남아 다음 루프를 돈다(잔여 window = 마지막 체크~lock 해제 사이 마이크로초, self-heal).
      rm -f "$KICK_LOCK/rekick" 2>/dev/null || true
      QMD_DAEMON_PORT="$PORT" QMD_BACKEND_MANAGER="$ROOT/core/backend_manager.sh" bash "$INDEX_WORKER_SCRIPT" >>"$MANAGER_LOG" 2>&1 || true
      [ -e "$KICK_LOCK/rekick" ] || break
    done
  ) >/dev/null 2>&1 &
}

kick_wiki_compile() {
  local cwd="${1:-}"
  local flush="${2:-}"
  local flush_arg=""
  [ "$flush" = "--flush" ] && flush_arg="--flush-all"
  local lock_hash lock_dir
  [ -z "$cwd" ] && return 0
  lock_hash="$(python3 - "$cwd" <<'PY' 2>/dev/null || true
import hashlib
import sys
print(hashlib.sha256(sys.argv[1].encode('utf-8')).hexdigest()[:16])
PY
)"
  [ -z "$lock_hash" ] && lock_hash="default"
  lock_dir="${COMPILE_KICK_LOCK}.${lock_hash}"
  if ! mkdir "$lock_dir" 2>/dev/null; then
    if [ -n "$(find "$lock_dir" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
      rm -f "$lock_dir/pid" 2>/dev/null || true
      rmdir "$lock_dir" 2>/dev/null || true
      mkdir "$lock_dir" 2>/dev/null || return 0
    else
      return 0
    fi
  fi
  (
    trap 'rm -f "$lock_dir/pid" 2>/dev/null; rmdir "$lock_dir" 2>/dev/null || true' EXIT
    echo "$$" >"$lock_dir/pid" 2>/dev/null || true
    case "$COMPILE_WORKER_SCRIPT" in
      *.sh|*.bash) bash "$COMPILE_WORKER_SCRIPT" --cwd "$cwd" $flush_arg >>"$MANAGER_LOG" 2>&1 || true ;;
      *) python3 "$COMPILE_WORKER_SCRIPT" --cwd "$cwd" $flush_arg >>"$MANAGER_LOG" 2>&1 || true ;;
    esac
    # compile worker(+피기백 verify)가 dirty 큐에 enqueue한 wiki collection을 즉시 drain해
    # 다음 SessionStart 전에 같은 세션에서 recall-visible하게 만든다. 편집 자신의 index
    # kick은 배치/verify 지연 때문에 카드가 큐에 오르기 전에 이미 drain을 마쳐 놓친다.
    # index_worker는 빈 큐에 no-op이고 KICK/WRITER 락으로 single-flight라 double-kick 무해.
    # 알려진 bound: 이 시점 다른 kick이 KICK_LOCK을 쥐고 있으면 여기 kick은 busy로 drop된다.
    # 그래도 큐는 보존되므로 다음 kick/SessionStart에 drain된다(기존엔 항상 SessionStart까지 대기).
    kick_index
  ) >/dev/null 2>&1 &
}

has_marker() {
  [ -f "$1" ] && grep -q "managed-by: qmd-auto-context" "$1" 2>/dev/null
}

case "${1:-}" in
  health) health || true ;;
  check-qmd) shift; check_qmd "${1:-}" ;;
  start) start_daemon ;;
  ensure) shift; ensure "${1:-}" ;;
  warm) warm ;;
  rotate) rotate ;;
  reload) reload ;;
  kick-index) kick_index ;;
  kick-wiki-compile) shift; kick_wiki_compile "${1:-}" "${2:-}" ;;
  cleanup-legacy) cleanup_legacy ;;
  *) echo "usage: backend_manager.sh health|check-qmd [--manual]|start|ensure [--wait]|warm|rotate|reload|kick-index|kick-wiki-compile <cwd> [--flush]|cleanup-legacy" >&2; exit 2 ;;
esac
