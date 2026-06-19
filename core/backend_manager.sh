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
KICK_LOCK="${QMD_WORKER_KICK_LOCKDIR:-$STATE_DIR/index-kick.lock.d}"
START_LOCK="${QMD_DAEMON_START_LOCKDIR:-$STATE_DIR/daemon-start.lock.d}"
REQUIRED_QMD_VERSION="${QMD_REQUIRED_VERSION:-2.5.3}"
SUPPORTED_QMD_MAJOR="${QMD_SUPPORTED_MAJOR:-2}"

mkdir -p "$STATE_DIR" "$(dirname "$MANAGER_LOG")" "$(dirname "$DAEMON_LOG")" 2>/dev/null || true

log() {
  printf '[%s] backend-manager: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$MANAGER_LOG" 2>&1 || true
}

normalize_path() {
  local fnm_node_bin
  fnm_node_bin=$(python3 - "$HOME/.local/share/fnm/node-versions" <<'PY' 2>/dev/null || true
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
candidates = []
for path in root.glob("v*/installation/bin"):
    match = re.match(r"^v(\d+)\.(\d+)\.(\d+)$", path.parent.parent.name)
    if match:
        candidates.append((tuple(int(x) for x in match.groups()), path))
if candidates:
    print(max(candidates)[1])
PY
)
  [ -n "$fnm_node_bin" ] && PATH="$fnm_node_bin:$PATH"
  [ -d "$HOME/.bun/bin" ] && PATH="$HOME/.bun/bin:$PATH"
  export PATH
}

health() {
  curl -sf -m "${QMD_HEALTH_TIMEOUT:-1}" "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1
}

qmd_version() {
  normalize_path
  command -v qmd >/dev/null 2>&1 || return 1
  qmd --version 2>/dev/null | sed -E 's/^qmd[[:space:]]+//'
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
    wait_health || true
    return 0
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
      rm -f "$KICK_LOCK/pid" 2>/dev/null || true
      rmdir "$KICK_LOCK" 2>/dev/null || true
      mkdir "$KICK_LOCK" 2>/dev/null || return 0
    else
      return 0
    fi
  fi
  (
    trap 'rm -f "$KICK_LOCK/pid" 2>/dev/null; rmdir "$KICK_LOCK" 2>/dev/null || true' EXIT
    echo "$$" >"$KICK_LOCK/pid" 2>/dev/null || true
    QMD_DAEMON_PORT="$PORT" QMD_BACKEND_MANAGER="$ROOT/core/backend_manager.sh" bash "$INDEX_WORKER_SCRIPT" >>"$MANAGER_LOG" 2>&1 || true
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
  cleanup-legacy) cleanup_legacy ;;
  *) echo "usage: backend_manager.sh health|check-qmd [--manual]|start|ensure [--wait]|warm|rotate|reload|kick-index|cleanup-legacy" >&2; exit 2 ;;
esac
