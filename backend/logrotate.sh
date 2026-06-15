#!/bin/bash
# qmd 데몬 로그 로테이션.
# 데몬은 single-threaded이고 로그 fd를 계속 열어두므로 `: > log`(truncate)를 쓰면
# fd offset이 남아 sparse(앞부분 null) 파일이 된다. 그래서 크기 초과 시에만
# mv로 회전하고 데몬을 kill 한다(supervise 가 다음 주기에 asuser 로 재기동 → 새 빈 로그 open).
# 크기 미달이면 아무것도 안 한다.
set -u
HOME="${HOME:-/Users/$(/usr/bin/id -un)}"
PORT="${QMD_DAEMON_PORT:-8483}"
LOG="$HOME/.cache/qmd/mcp.daemon.log"
MAX_BYTES=$((10 * 1024 * 1024))   # 10MB

[ -f "$LOG" ] || exit 0
SIZE=$(stat -f%z "$LOG" 2>/dev/null || echo 0)
[ "$SIZE" -lt "$MAX_BYTES" ] && exit 0

mv -f "$LOG" "$LOG.1" 2>/dev/null || exit 0
# KeepAlive 데몬을 kickstart -k 로 재시작 → fd 닫히고 launchd 가 새 LOG 를 연다(sparse 문제 없음).
if ! launchctl kickstart -k "gui/$(/usr/bin/id -u)/com.qmd-mcp-daemon" 2>/dev/null; then
  # 재시작 실패 시 원복(데몬이 옛 inode=.1 에 계속 쓰므로 로그 연속성 유지)
  mv -f "$LOG.1" "$LOG" 2>/dev/null || true
fi
