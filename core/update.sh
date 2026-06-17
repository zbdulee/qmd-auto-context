#!/usr/bin/env bash
# qmd SessionStart core script.
set -e

# If QMD_SANDBOX is set or --sandbox option is passed, exit immediately with no output
if [ -n "$QMD_SANDBOX" ]; then
  exit 0
fi
for arg in "$@"; do
  if [ "$arg" = "--sandbox" ]; then
    exit 0
  fi
done


LOG="/tmp/qmd-hook.log"
LOCKDIR="/tmp/qmd-update.lock.d"
STATUS="/tmp/qmd-update-status.txt"

# SessionStart 헬스체크: 데몬 포트 확인. 기본은 안내만, QMD_AUTO_KICKSTART=1이면 기동 시도.
qmd_healthcheck() {
  local port="${QMD_HEALTHCHECK_PORT:-8483}"
  if curl -sf -m 1 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    return 0
  fi
  # 안내는 stderr(JSON 파싱 경로 보호). 자동기동 opt-in 시만 stdout에 언급.
  echo "[qmd] 데몬 미응답(:${port}). 기동: launchctl kickstart gui/$(id -u)/com.qmd-mcp-daemon" >&2
  if [[ "${QMD_AUTO_KICKSTART:-}" == "1" ]]; then
    echo "[qmd] kickstart 실행 (QMD_AUTO_KICKSTART=1)"
    command -v launchctl >/dev/null 2>&1 && launchctl kickstart "gui/$(id -u)/com.qmd-mcp-daemon" >/dev/null 2>&1 || true
  fi
}

log() {
  printf "[%s] %s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG" 2>&1 || true
}

retry() {
  local count=0
  local max=3
  local output=""
  while [ $count -lt $max ]; do
    count=$((count + 1))
    if output=$("$@" 2>&1); then
      LAST_OUT="$output"
      return 0
    fi
    if printf '%s' "$output" | grep -qi "already exists"; then
      LAST_OUT="$output"
      return 0
    fi
    log "RETRY ($count/$max) failed: $* - error: $output"
    sleep 1
  done
  LAST_OUT="$output"
  log "FAIL: $* - final error: $output"
  return 1
}

# preflight는 "위험 경로(risky)"인 기존 컬렉션만 제거한다.
# pending(미동의)은 사용자가 의도적으로 추가한 컬렉션일 수 있으므로 건드리지 않는다.
path_refused_by_resolver() {
  local candidate="$1"
  local resolved
  resolved=$(printf '{}' | python3 "$(dirname "$0")/resolve_paths.py" --cwd "$candidate" 2>/dev/null || true)
  [ "$(echo "$resolved" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("reason"))' 2>/dev/null)" = "risky" ]
}

preflight_remove_risky() {
  qmd collection list 2>/dev/null | awk '/^[^ ]/ {print $1}' | while read -r name; do
    [ -z "$name" ] && continue
    path=$(qmd collection show "$name" 2>/dev/null | awk -F': +' '/^ *Path|^ *Root/ {print $2; exit}')
    [ -z "$path" ] && continue
    if path_refused_by_resolver "$path"; then
      log "PREFLIGHT: removing risky collection '$name' (path=$path)"
      qmd collection remove "$name" >>"$LOG" 2>&1 || true
    fi
  done
}

acquire_lock() {
  if mkdir "$LOCKDIR" 2>/dev/null; then
    echo "$$" >"$LOCKDIR/pid"
    return 0
  fi

  local pid
  pid=$(cat "$LOCKDIR/pid" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    return 1
  fi

  rm -f "$LOCKDIR/pid" 2>/dev/null || true
  if rmdir "$LOCKDIR" 2>/dev/null && mkdir "$LOCKDIR" 2>/dev/null; then
    echo "$$" >"$LOCKDIR/pid"
    log "LOCK: removed stale qmd update lock"
    return 0
  fi

  return 1
}

release_lock() {
  rm -f "$LOCKDIR/pid" 2>/dev/null || true
  rmdir "$LOCKDIR" 2>/dev/null || true
}

write_failure_status() {
  local cmd="$1"
  local output="$2"
  {
    echo "FAIL at $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "cmd: $cmd"

    local last_col
    last_col=$(echo "$output" | grep -E '^\[[0-9]+/[0-9]+\] ' | tail -1)
    [ -n "$last_col" ] && echo "collection: $last_col"

    local err_line err_code err_path
    err_line=$(echo "$output" | grep -oE 'Error: [A-Z][A-Z0-9_]+: [^]]+' | head -1)
    [ -n "$err_line" ] && echo "error: $err_line"

    err_code=$(echo "$err_line" | awk '{print $2}' | tr -d ':')
    err_path=$(echo "$output" | grep -oE "path: '[^']+'" | head -1 | sed "s/path: //;s/^'//;s/'$//")
    [ -n "$err_path" ] && echo "path: $err_path"

    if [ -n "$last_col" ]; then
      local col_name
      col_name=$(echo "$last_col" | awk '{print $2}')
      case "$err_code" in
        EACCES|EPERM|ENOENT)
          echo "suggest: qmd collection remove \"$col_name\""
          ;;
        *)
          echo "suggest: tail -80 $LOG"
          ;;
      esac
    else
      echo "suggest: tail -80 $LOG"
    fi

    echo "log: $LOG"
  } >"$STATUS"
}

normalize_qmd_path() {
  [ -d "$HOME/.bun/bin" ] && PATH="$HOME/.bun/bin:$PATH"
  local fnm_node_bin
  fnm_node_bin=$(ls -d "$HOME/.local/share/fnm/node-versions"/v*/installation/bin 2>/dev/null | sort -V | tail -1)
  [ -n "$fnm_node_bin" ] && PATH="$fnm_node_bin:$PATH"
  export PATH
}

run_resolve_only() {
  local cwd="$1"
  python3 "$(dirname "$0")/resolve_paths.py" --cwd "$cwd"
}

load_config_json() {
  local dir prev=""
  dir=$(cd "$1" 2>/dev/null && pwd) || dir="$1"
  # HOME 하위가 아니면 부모로 올라가지 않고 cwd만 검사 (find_git_root와 경계 일치)
  local under_home=0
  case "$dir/" in "$HOME"/*) under_home=1 ;; esac
  while [ -n "$dir" ] && [ "$dir" != "/" ] && [ "$dir" != "$prev" ]; do
    if [ -f "$dir/.auto-context.json" ]; then
      cat "$dir/.auto-context.json"; return
    fi
    if [ -f "$dir/.agents/qmd-recall.json" ]; then
      cat "$dir/.agents/qmd-recall.json"; return
    fi
    [ "$dir" = "$HOME" ] && break
    [ "$under_home" = "0" ] && break
    prev="$dir"
    dir="$(dirname "$dir")"
  done
  printf '{}'
}

config_event_enabled() {
  local event="$1"
  local config_json="$2"
  python3 - "$event" "$(dirname "$0")" "$config_json" <<'PY'
import json
import sys
from pathlib import Path

event, core_dir, raw = sys.argv[1:4]
sys.path.insert(0, str(Path(core_dir).resolve()))
import config as qmd_config

try:
    parsed = json.loads(raw) if raw else {}
except json.JSONDecodeError:
    parsed = {}

normalized = qmd_config.normalize_config(parsed if isinstance(parsed, dict) else {})
print("yes" if qmd_config.event_enabled(normalized, event) else "no")
PY
}

run_update() {
  normalize_qmd_path
  command -v qmd >/dev/null 2>&1 || exit 0

  workdir="$1"
  cd "$workdir" 2>/dev/null || exit 0
  
  log "START: cwd=$workdir"

  # 1. read config from .agents/qmd-recall.json if exists
  local config_json
  config_json=$(load_config_json "$workdir")
  if [ "$(config_event_enabled sessionStart "$config_json")" != "yes" ]; then
    log "SKIP: sessionStart disabled by config.events"
    exit 0
  fi

  # 2. Get collections and paths via resolve-only logic
  local resolved
  resolved=$(echo "$config_json" | bash "$0" --resolve-only --cwd "$workdir" 2>/dev/null || echo '{"refused":true}')

  refused=$(echo "$resolved" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("refused"))' 2>/dev/null || echo "")
  if [ "$refused" = "True" ]; then
    log "ABORT: resolve-only refused path '$workdir'"
    exit 0
  fi

  if ! acquire_lock; then
    log "SKIP: qmd update already running (lock=$LOCKDIR)"
    exit 0
  fi
  trap 'release_lock' EXIT

  preflight_remove_risky

  # 3. Add collections
  collections_ok=1
  while read -r name path; do
    [ -z "$name" ] && continue
    # Resolve relative path against workdir
    local full_path="$path"
    if [[ "$path" != /* ]]; then
      full_path="$workdir/$path"
    fi
    log "ADD COLLECTION: name=$name path=$full_path"
    retry qmd collection add "$full_path" --name "$name" || collections_ok=0
  done < <(echo "$resolved" | python3 -c 'import json,sys; [print(f"{e[\"name\"]}\t{e[\"path\"]}") for e in json.load(sys.stdin).get("entries", [])]' 2>/dev/null)

  # 4. update and embed
  if [ "$collections_ok" = 1 ] && retry qmd update; then
    rm -f "$STATUS"
    log "END rc=0"
    
    EMBED_LOCK="/tmp/qmd-embed.lock.d"
    if [ -d "$EMBED_LOCK" ]; then
      epid="$(cat "$EMBED_LOCK/pid" 2>/dev/null || true)"
      { [ -z "$epid" ] || ! kill -0 "$epid" 2>/dev/null; } && rm -rf "$EMBED_LOCK" 2>/dev/null
    fi
    
    if ! mkdir "$EMBED_LOCK" 2>/dev/null; then
      log "EMBED: already running, skip"
    else
      LOG="$LOG" EMBED_LOCK="$EMBED_LOCK" QMD_DAEMON_PORT="${QMD_DAEMON_PORT:-8483}" nohup bash -c '
        echo "$$" > "$EMBED_LOCK/pid" 2>/dev/null || true
        trap "rm -f \"$EMBED_LOCK/pid\" 2>/dev/null; rmdir \"$EMBED_LOCK\" 2>/dev/null" EXIT
        out=$(qmd embed 2>&1); printf "%s\n" "$out" >> "$LOG"
        if printf "%s" "$out" | grep -qiE "embedded|chunks"; then
          # SIGTERM 으로 graceful shutdown 유도 → 데몬이 SQLite clean close 하며 WAL checkpoint.
          # KeepAlive=true plist 가 자동 respawn. (SIGKILL 강제종료는 clean close 차단 →
          # WAL checkpoint 누락 → embed 로 팽창한 WAL 이 잔존·누적 → vec query 20s 로 저하)
          if launchctl kill TERM "gui/$(id -u)/com.qmd-mcp-daemon" 2>/dev/null; then
            printf "[%s] EMBED->daemon SIGTERM restart (clean WAL checkpoint)\n" "$(date +%H:%M:%S)" >> "$LOG"
            # respawn 후 /health ready 까지 bounded 대기(최대 ~15s). 실패해도 로그만, hook 진행.
            for _ in {1..30}; do
              curl -sf -m 1 "http://127.0.0.1:$QMD_DAEMON_PORT/health" >/dev/null 2>&1 && break
              sleep 0.5
            done
          fi
        fi
      ' >/dev/null 2>&1 &
      log "EMBED: started in background (pid=$!)"
    fi
  else
    write_failure_status "qmd update" "$LAST_OUT"
    log "END rc=1 - status written to $STATUS"
  fi
}

main() {
  raw=$(cat)
  workdir=$(printf '%s' "$raw" | python3 -c 'import json,sys,os; print((json.load(sys.stdin).get("cwd") or os.getcwd()))' 2>/dev/null)
  [ -z "$workdir" ] && workdir="$PWD"

  config_json=$(load_config_json "$workdir")
  if [ "$(config_event_enabled sessionStart "$config_json")" != "yes" ]; then
    exit 0
  fi

  if [ -f "$STATUS" ]; then
    echo "qmd previous update failed: $(cat "$STATUS")"
  fi

  # opt-in 게이트: 미설정(pending)·거절(optout)·위험(risky) 폴더는 인덱싱하지 않는다.
  resolved=$(echo "$config_json" | bash "$0" --resolve-only --cwd "$workdir" 2>/dev/null || echo '{}')
  reason=$(echo "$resolved" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("reason") or "")' 2>/dev/null || echo "")
  if [ "$reason" = "pending" ]; then
    suggested=$(echo "$resolved" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("prompt") or {}).get("suggestedRoot",""))' 2>/dev/null || echo "")
    helper="bash $(cd "$(dirname "$0")" && pwd)/update.sh"
    echo "[qmd] 이 폴더는 아직 검색 인덱스에 등록되지 않았습니다."
    printf '      인덱싱하려면:    %s --optin %q\n' "$helper" "$suggested"
    printf '      다시 묻지 않으려면: %s --optout %q\n' "$helper" "$workdir"
    echo "      사용자에게 인덱싱할지 물어보고, 답에 따라 위 명령 중 하나를 실행하세요."
    exit 0
  fi
  if [ "$reason" = "optout" ] || [ "$reason" = "risky" ]; then
    exit 0
  fi

  # 헬스체크: config·reason 검사 통과 후, fork 직전 1회 실행 (main() 호출에서만).
  # --resolve-only 내부 재귀호출(--cwd 포함)과 --worker 경로에서는 실행 안 됨.
  qmd_healthcheck

  nohup bash "$0" --worker "$workdir" </dev/null >>"$LOG" 2>&1 &
  exit 0
}

if [ "$1" = "--optin" ] || [ "$1" = "--optout" ]; then
  mode="$1"; target="${2:-$PWD}"
  python3 - "$mode" "$target" <<'PY'
import json, os, sys, tempfile
from pathlib import Path
mode, target = sys.argv[1], Path(sys.argv[2])
dest = target / ".auto-context.json"
legacy = target / ".agents" / "qmd-recall.json"
base = {}
used_legacy = False
for src in (dest, legacy):
    if src.exists():
        try:
            base = json.loads(src.read_text())
            if not isinstance(base, dict): base = {}
        except (OSError, json.JSONDecodeError): base = {}
        used_legacy = (src == legacy)   # 레거시를 base로 읽었는지(=dest 없었음)
        break
if mode == "--optin":
    base["indexing"] = True
    if not base.get("collections"):
        base["collections"] = [target.name.replace(" ", "-")]
    msg = f"[qmd] opt-in 완료: {target} ({base['collections']}). 다음 세션부터 인덱싱됩니다."
else:
    base["indexing"] = False
    msg = f"[qmd] opt-out 완료: {target}. 이 폴더는 인덱싱·검색하지 않습니다."
target.mkdir(parents=True, exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=str(target), prefix=".auto-context.", suffix=".tmp")
try:
    with os.fdopen(fd, "w") as fh:
        json.dump(base, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, dest)
except BaseException:
    try: os.unlink(tmp)
    except OSError: pass
    raise
# 레거시를 base로 승계했으면(=내용이 .auto-context.json에 담김) 중복 방치 않고 백업 후 제거
if used_legacy and legacy.exists():
    os.replace(str(legacy), str(legacy) + ".bak-migrated")
print(msg)
PY
  exit 0
fi

# Resolve-only CLI switch
if [ "$1" = "--resolve-only" ]; then
  shift
  cwd="$PWD"
  if [ "$1" = "--cwd" ]; then
    cwd="$2"
  else
    # 외부(직접) 호출만 헬스체크 실행. 내부 subprocess 호출(--cwd 포함)은 skip(JSON 파싱 보호).
    qmd_healthcheck
  fi
  run_resolve_only "$cwd"
  exit 0
fi

if [ "$1" = "--worker" ]; then
  shift
  run_update "${1:-$PWD}"
else
  main
fi
