#!/bin/bash
# managed-by: qmd-auto-context
# qmd 데몬 로그 로테이션.
# 데몬은 single-threaded이고 로그 fd를 계속 열어두므로 `: > log`(truncate)를 쓰면
# fd offset이 남아 sparse(앞부분 null) 파일이 된다. 그래서 크기 초과 시에만
# mv로 회전하고 데몬을 graceful reload 한다(새 프로세스가 새 빈 로그 open).
# 크기 미달이면 아무것도 안 한다.
set -u
HOME="${HOME:-/Users/$(/usr/bin/id -un)}"
PORT="${QMD_DAEMON_PORT:-8483}"
LOG="${QMD_DAEMON_LOG:-$HOME/.cache/qmd/mcp.daemon.log}"
MAX_BYTES=$((10 * 1024 * 1024))   # 10MB

[ -f "$LOG" ] || exit 0
SIZE=$(stat -f%z "$LOG" 2>/dev/null || echo 0)
[ "$SIZE" -lt "$MAX_BYTES" ] && exit 0

mv -f "$LOG" "$LOG.1" 2>/dev/null || exit 0
# 데몬을 SIGTERM 으로 graceful 재시작 → fd 닫히고 새 LOG 를 연다(sparse 문제 없음).
# (SIGKILL 강제종료는 SQLite clean close 를 막아 WAL checkpoint 누락 → WAL 누적. update.sh 와 동일 이슈)
if [ -n "${QMD_BACKEND_MANAGER:-}" ] && [ -x "$QMD_BACKEND_MANAGER" ]; then
  "$QMD_BACKEND_MANAGER" reload >/dev/null 2>&1 || mv -f "$LOG.1" "$LOG" 2>/dev/null || true
elif [ -n "${QMD_DAEMON_PID:-}" ] && [ -f "$QMD_DAEMON_PID" ]; then
  pid="$(cat "$QMD_DAEMON_PID" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || mv -f "$LOG.1" "$LOG" 2>/dev/null || true
  fi
else
  # 재시작 실패 시 원복(데몬이 옛 inode=.1 에 계속 쓰므로 로그 연속성 유지)
  mv -f "$LOG.1" "$LOG" 2>/dev/null || true
fi
