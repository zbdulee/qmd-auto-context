#!/bin/bash
# managed-by: qmd-auto-context
# qmd 데몬 embedding context warm 유지 핑.
# 데몬은 모델을 오래 살려두지만 embedding context는 idle 시 dispose 되어 재생성(~1-2s) 페널티가 붙는다.
# 실측상 30초 간격이면 항상 완전 warm(~0.6s) 유지. vec 쿼리여야 embedding 모델을 touch 한다(lex는 BM25라 무의미).
#
# 주의: qmd 데몬은 single-threaded(Node 이벤트루프)다. 핑이 겹치거나 데몬이 busy인데 또 쏘면
# 서버를 더 바쁘게 만들어 /health 까지 막는다. 그래서:
#  (1) single-flight: 이전 핑이 아직 돌면 skip (mkdir atomic lock)
#  (2) health 가 즉답할 때만 vec 핑 (busy/down 이면 skip)
PORT="${QMD_DAEMON_PORT:-8483}"
LOCKDIR="${TMPDIR:-/tmp}/qmd-keepalive.lock.d"

# (1) single-flight. 이미 도는 핑이 있으면(=lock 존재) 그냥 빠진다.
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  # stale lock 방어: 10분 이상 오래된 lock 이면 정리하고 이번엔 skip.
  if [ -n "$(find "$LOCKDIR" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
    rmdir "$LOCKDIR" 2>/dev/null || true
  fi
  exit 0
fi
trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT

# (2) health 즉답 확인. busy/down 이면 핑을 추가로 쏘지 않는다.
curl -s -m 1 "http://localhost:${PORT}/health" >/dev/null 2>&1 || exit 0

# warm 핑 (vec). 데몬이 정상이면 ~0.6s.
curl -s -m 5 -X POST "http://localhost:${PORT}/query" \
  -H 'Content-Type: application/json' \
  -d '{"searches":[{"type":"vec","query":"keepalive warm ping"}],"limit":1,"rerank":false}' \
  >/dev/null 2>&1 || true
