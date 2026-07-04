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

_QMD_CORE_DIR="$(cd "$(dirname "$0")" && pwd)" || exit 0
. "$_QMD_CORE_DIR/qmd_path.sh"

# 유저 격리 경로(멀티유저 /tmp symlink 선점 방지). backend_manager.sh와 통일.
# 로그/status는 $HOME/.cache/qmd/, 락은 user-private 디렉토리.
# 모든 경로는 QMD_* env override 유지(테스트 주입).
_QMD_UID="$(/usr/bin/id -un 2>/dev/null || id -u 2>/dev/null || echo qmd)"
_QMD_LOCK_BASE="${QMD_LOCK_BASE:-${TMPDIR:-/tmp}/qmd-auto-context-locks-${_QMD_UID}}"
_QMD_CACHE_DIR="${QMD_CACHE_DIR:-$HOME/.cache/qmd}"
mkdir -p "$_QMD_CACHE_DIR" "$_QMD_LOCK_BASE" 2>/dev/null || true
LOG="${QMD_HOOK_LOG:-$_QMD_CACHE_DIR/hook.log}"
# WRITER 락: index_worker.sh의 WRITER_LOCK(QMD_WRITER_LOCKDIR)과 기본값 공유 → 직렬화.
LOCKDIR="${QMD_WRITER_LOCKDIR:-$_QMD_LOCK_BASE/qmd-update.lock.d}"
STATUS="${QMD_UPDATE_STATUS:-$_QMD_CACHE_DIR/update-status.txt}"

# SessionStart 헬스체크: 데몬 포트 확인. 데몬 기동은 plugin-managed backend manager가 담당한다.
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

qmd_healthcheck() {
  local port="${QMD_HEALTHCHECK_PORT:-8483}"
  local timeout
  timeout="$(qmd_health_timeout)"
  if curl -sf -m "$timeout" "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    return 0
  fi
  # 안내는 stderr(JSON 파싱 경로 보호). core/update.sh는 launchd를 직접 제어하지 않는다.
  echo "[qmd] 데몬 미응답(:${port}). backend manager가 준비되지 않았으면 이번 update는 건너뜁니다." >&2
  # set -e 주의: 호출부는 반드시 조건문(if/||)으로 감쌀 것.
  return 1
}

# SessionStart 이상 상태 알림: 무음 사망(RC7) 표면화. stdout이 additionalContext로
# 주입되므로 이상 상태에서만 출력하고, marker mtime TTL로 반복 세션 잡음을 억제한다.
# 조건이 해소되면 notice_clear로 재무장해 재발 시 다시 1회 알린다.
# QMD_SUPPRESS_NOTICE=1(Hermes 등 stdout이 표면화되지 않는 호스트)이면 출력과
# marker 기록을 모두 생략한다 — marker 선점으로 타 호스트 알림을 삼키지 않기 위함.
_notice_marker() {
  local key="$1" project="$2" hash
  hash=$(printf '%s' "$project" | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest()[:16])' 2>/dev/null)
  [ -z "$hash" ] && hash=default
  printf '%s' "$_QMD_CACHE_DIR/notice-${key}-${hash}"
}

notice_once() {
  local key="$1" project="$2" message="$3" marker ttl now mtime
  [ -n "${QMD_SUPPRESS_NOTICE:-}" ] && return 0
  marker="$(_notice_marker "$key" "$project")"
  ttl="${QMD_NOTICE_TTL_SECS:-14400}"
  case "$ttl" in ''|*[!0-9]*) ttl=14400 ;; esac
  if [ -f "$marker" ]; then
    now=$(date +%s)
    mtime=$(stat -f %m "$marker" 2>/dev/null || stat -c %Y "$marker" 2>/dev/null || echo 0)
    if [ $((now - mtime)) -lt "$ttl" ]; then
      return 0
    fi
  fi
  echo "$message"
  : > "$marker" 2>/dev/null || true
}

notice_clear() {
  rm -f "$(_notice_marker "$1" "$2")" 2>/dev/null || true
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

run_resolve_only() {
  local cwd="$1"
  python3 "$(dirname "$0")/resolve_paths.py" --cwd "$cwd"
}

load_config_json() {
  python3 "$(dirname "$0")/config.py" --cwd "$1" --raw 2>/dev/null || printf '{}'
}

migrate_config_json() {
  python3 "$(dirname "$0")/config.py" --cwd "$1" --migrate
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

prune_missing_settings_collections() {
  local workdir="$1"
  local missing
  missing=$(python3 - "$workdir" "$(dirname "$0")" <<'PY'
import fnmatch
import json
import sys
from pathlib import Path

workdir = Path(sys.argv[1]).resolve()
core_dir = Path(sys.argv[2]).resolve()
sys.path.insert(0, str(core_dir))

import config as qmd_config
import resolve_paths as qmd_resolve_paths

info = qmd_config.find_project_config(str(workdir))
if info.get("configFormat") != "auto-context-dir":
    sys.exit(0)

settings = Path(info.get("configPath") or "")
project_root = Path(info.get("projectRoot") or workdir).resolve()
settings_dir = project_root / ".auto-context"
expected = project_root / ".auto-context" / "settings.json"
try:
    if settings != expected or settings_dir.is_symlink() or settings.is_symlink():
        sys.exit(0)
    if settings.resolve() != expected:
        sys.exit(0)
except OSError:
    sys.exit(0)

try:
    raw = json.loads(settings.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    sys.exit(0)
if not isinstance(raw, dict):
    sys.exit(0)

collections = [item for item in raw.get("collections", []) if isinstance(item, str)]
collection_paths = raw.get("collectionPaths") if isinstance(raw.get("collectionPaths"), dict) else {}
collection_paths = {key: value for key, value in collection_paths.items() if isinstance(key, str) and isinstance(value, str)}
roots = qmd_resolve_paths.allowed_roots(raw)

missing = []
for collection in collections:
    matched_path = "."
    for pattern, value in collection_paths.items():
        if fnmatch.fnmatch(collection, pattern):
            matched_path = value
            break
    if not qmd_resolve_paths.safe_collection_path(project_root, matched_path, roots):
        continue
    candidate = Path(matched_path).expanduser()
    if not candidate.is_absolute():
        candidate = project_root / candidate
    if not candidate.is_dir():
        missing.append(collection)

if not missing:
    sys.exit(0)

print("\n".join(missing))
PY
)
  [ -z "$missing" ] && return 0

  local successful
  successful=""
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    log "PRUNE MISSING COLLECTION: $name"
    if qmd collection remove "$name" >>"$LOG" 2>&1; then
      successful="${successful}${name}
"
    else
      log "PRUNE MISSING COLLECTION FAILED: $name"
    fi
  done <<EOF
$missing
EOF

  [ -z "$successful" ] && return 0

  local successful_json
  successful_json=$(SUCCESSFUL_COLLECTIONS="$successful" python3 - <<'PY'
import json
import os

names = [line for line in os.environ.get("SUCCESSFUL_COLLECTIONS", "").splitlines() if line]
print(json.dumps(names, ensure_ascii=False))
PY
)

  python3 - "$workdir" "$(dirname "$0")" "$successful_json" <<'PY'
import fnmatch
import json
import os
import sys
import tempfile
from pathlib import Path

workdir = Path(sys.argv[1]).resolve()
core_dir = Path(sys.argv[2]).resolve()
try:
    removed = json.loads(sys.argv[3])
except json.JSONDecodeError:
    removed = []
if not isinstance(removed, list):
    sys.exit(0)
removed = [item for item in removed if isinstance(item, str)]
if not removed:
    sys.exit(0)

sys.path.insert(0, str(core_dir))
import config as qmd_config

info = qmd_config.find_project_config(str(workdir))
if info.get("configFormat") != "auto-context-dir":
    sys.exit(0)

settings = Path(info.get("configPath") or "")
project_root = Path(info.get("projectRoot") or workdir).resolve()
settings_dir = project_root / ".auto-context"
expected = project_root / ".auto-context" / "settings.json"
try:
    if settings != expected or settings_dir.is_symlink() or settings.is_symlink():
        sys.exit(2)
    if settings.resolve() != expected:
        sys.exit(0)
except OSError:
    sys.exit(2)

try:
    raw = json.loads(settings.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    sys.exit(2)
if not isinstance(raw, dict):
    sys.exit(2)

collections = [item for item in raw.get("collections", []) if isinstance(item, str)]
removed_set = set(removed)
remaining = [collection for collection in collections if collection not in removed_set]
raw["collections"] = remaining
if not remaining:
    raw["indexing"] = False

if isinstance(raw.get("collectionPaths"), dict):
    remaining_set = set(remaining)
    pruned_paths = {}
    for pattern, value in raw["collectionPaths"].items():
        if not isinstance(pattern, str):
            pruned_paths[pattern] = value
            continue
        if pattern in removed_set:
            continue
        if (
            isinstance(value, str)
            and any(ch in pattern for ch in "*?[")
            and not any(fnmatch.fnmatch(collection, pattern) for collection in remaining_set)
        ):
            continue
        pruned_paths[pattern] = value
    raw["collectionPaths"] = pruned_paths

if isinstance(raw.get("collectionRoles"), dict):
    raw["collectionRoles"] = {
        key: value
        for key, value in raw["collectionRoles"].items()
        if not isinstance(key, str) or key not in removed_set
    }

tmp_path = None
try:
    fd, tmp_name = tempfile.mkstemp(
        dir=str(settings.parent),
        prefix=settings.name + ".",
        suffix=".tmp",
        text=True,
    )
    tmp_path = Path(tmp_name)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(raw, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp_path, settings)
except OSError:
    if tmp_path is not None:
        try:
            tmp_path.unlink()
        except OSError:
            pass
    sys.exit(2)
PY
}

run_update() {
  normalize_qmd_path
  local qmd_bin
  qmd_bin="$(resolve_qmd_bin 2>/dev/null)" || exit 0
  qmd() { "$qmd_bin" "$@"; }

  workdir="$1"
  cd "$workdir" 2>/dev/null || exit 0
  
  log "START: cwd=$workdir"

  local migration_result
  migration_result=$(migrate_config_json "$workdir" 2>&1 || true)
  [ -n "$migration_result" ] && log "CONFIG MIGRATION: $migration_result"
  local migrated
  migrated=$(printf '%s' "$migration_result" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("migrated"))' 2>/dev/null || echo "False")

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

  if [ "$migrated" != "True" ]; then
    if ! prune_missing_settings_collections "$workdir"; then
      log "ABORT: failed to write pruned settings"
      exit 0
    fi
  fi
  config_json=$(load_config_json "$workdir")
  resolved=$(echo "$config_json" | bash "$0" --resolve-only --cwd "$workdir" 2>/dev/null || echo '{"refused":true}')
  refused=$(echo "$resolved" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("refused"))' 2>/dev/null || echo "")
  if [ "$refused" = "True" ]; then
    log "ABORT: resolve-only refused path '$workdir' after prune"
    exit 0
  fi

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
    
    # EMBED 락: index_worker.sh의 EMBED_LOCK(QMD_EMBED_LOCKDIR)과 기본값 공유 → 직렬화.
    EMBED_LOCK="${QMD_EMBED_LOCKDIR:-$_QMD_LOCK_BASE/qmd-embed.lock.d}"
    if [ -d "$EMBED_LOCK" ]; then
      epid="$(cat "$EMBED_LOCK/pid" 2>/dev/null || true)"
      # stale 정리: rm -rf 대신 우리 락 구조(pid 파일만)에 맞춰 unlink 후 rmdir.
      # 예상 밖 내용이 있으면 rmdir 실패로 보호된다(env override 재귀 삭제 위험 제거).
      { [ -z "$epid" ] || ! kill -0 "$epid" 2>/dev/null; } && { rm -f "$EMBED_LOCK/pid" 2>/dev/null; rmdir "$EMBED_LOCK" 2>/dev/null || true; }
    fi
    
    if ! mkdir "$EMBED_LOCK" 2>/dev/null; then
      log "EMBED: already running, skip"
    else
      LOG="$LOG" EMBED_LOCK="$EMBED_LOCK" QMD_BIN_RESOLVED="$qmd_bin" QMD_DAEMON_PORT="${QMD_DAEMON_PORT:-8483}" QMD_BACKEND_MANAGER="${QMD_BACKEND_MANAGER:-}" WORKDIR="$workdir" CORE_DIR="$(dirname "$0")" nohup bash -c '
        echo "$$" > "$EMBED_LOCK/pid" 2>/dev/null || true
        trap "rm -f \"$EMBED_LOCK/pid\" 2>/dev/null; rmdir \"$EMBED_LOCK\" 2>/dev/null" EXIT
        out=$("$QMD_BIN_RESOLVED" embed 2>&1); printf "%s\n" "$out" >> "$LOG"
        if printf "%s" "$out" | grep -qiE "embedded|chunks"; then
          # SIGTERM 으로 graceful shutdown 유도 → 데몬이 SQLite clean close 하며 WAL checkpoint.
          # SIGKILL 강제종료는 clean close 차단 → WAL checkpoint 누락 → vec query 저하.
          if [ -n "${QMD_BACKEND_MANAGER:-}" ] && [ -x "$QMD_BACKEND_MANAGER" ]; then
            "$QMD_BACKEND_MANAGER" reload >> "$LOG" 2>&1 || true
          else
            printf "[%s] EMBED reload skipped: QMD_BACKEND_MANAGER unavailable\n" "$(date +%H:%M:%S)" >> "$LOG"
          fi
        fi
        # Retroactive wiki dedup scan: must run strictly after embed completes
        # (this line), never after run_update()/--worker itself returns.
        python3 "$CORE_DIR/wiki_dedup_scan.py" --cwd "$WORKDIR" >> "$LOG" 2>&1 || true
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
    [ -z "$suggested" ] && suggested="$workdir"
    helper="bash $(cd "$(dirname "$0")" && pwd)/update.sh"
    # pending_guide: 미설정 프로젝트 안내 메시지 (Task 8의 deny reason과 명령 세트 공유 위해 함수화)
    pending_guide() {
      local h="$1" s="$2" w="$3"
      echo "[qmd] 이 폴더는 아직 검색 인덱스에 등록되지 않았습니다."
      echo "      다음 중 하나를 선택하세요:"
      printf '  1) 추천 확인:       %s --recommend %q\n'        "$h" "$w"
      printf '  2) 추천 즉시 적용:  %s --optin --recommended %q\n' "$h" "$s"
      printf '  3) 직접 작성:       %q/.auto-context/settings.json 파일을 작성한 뒤 다음 세션에 자동 적용\n' "$w"
      printf '  4) 거절:            %s --optout %q\n'            "$h" "$w"
      printf '  5) 임시 건너뜀(2h):  %s --skip %q\n'              "$h" "$w"
    }
    pending_guide "$helper" "$suggested" "$workdir"
    exit 0
  fi
  if [ "$reason" = "optout" ] || [ "$reason" = "risky" ]; then
    exit 0
  fi

  # SessionStart sweep: flush any debounced wiki-compile batch (best-effort, background).
  if [ -n "${QMD_BACKEND_MANAGER:-}" ] && [ -x "$QMD_BACKEND_MANAGER" ]; then
    bash "$QMD_BACKEND_MANAGER" kick-wiki-compile "$workdir" --flush >/dev/null 2>&1 &
  fi

  # First-run disclosure: extractor configured but not yet announced for this project.
  notice_engines="$(python3 - "$workdir" "$(dirname "$0")" <<'PY' 2>/dev/null || true
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[2])
import config as qmd_config
cfg = qmd_config.find_project_config(sys.argv[1])["config"]
comp = cfg.get("compile") if isinstance(cfg.get("compile"), dict) else {}
ext = comp.get("extractor") if isinstance(comp.get("extractor"), dict) else {}
backends = ext.get("backends") if isinstance(ext.get("backends"), dict) else {}
builtins = ext.get("builtins") if isinstance(ext.get("builtins"), list) else []
engines = sorted(set(backends.keys()) | {e for e in builtins if isinstance(e, str)})
print(",".join(engines) if engines else "")
PY
)"
  if [ -n "$notice_engines" ]; then
    marker="$workdir/.auto-context/compile/.notice-shown"
    if [ ! -f "$marker" ]; then
      echo "[qmd] wiki auto-compile이 활성화되어 있습니다 (엔진: $notice_engines)."
      echo "      raw/session 컬렉션의 .md를 편집하면 백그라운드로 해당 CLI를 실행해 wiki 초안(generated)을 만듭니다."
      echo "      끄려면 .auto-context/settings.json의 compile.extractor 를 제거하세요."
      mkdir -p "$workdir/.auto-context/compile" 2>/dev/null || true
      : > "$marker" 2>/dev/null || true
    fi
  fi

  # Retroactive wiki dedup hint: if a scan (this run's or a past one's) queued
  # pairs that haven't been resolved yet, surface a spawn instruction. Cheap
  # file test + text extraction only -- no daemon call -- since this runs in
  # the hot synchronous SessionStart path.
  dedup_queue="$workdir/.auto-context/compile/dedup-needed.jsonl"
  if [ -s "$dedup_queue" ]; then
    agent_file="$(cd "$(dirname "$0")/.." && pwd)/agents/wiki-dedup-resolver.md"
    if [ -f "$agent_file" ]; then
      dedup_workflow="$(awk '/<!-- WORKFLOW:START -->/{f=1;next}/<!-- WORKFLOW:END -->/{f=0}f' "$agent_file")"
      if [ -n "$dedup_workflow" ]; then
        echo "Claude Code는 Agent 도구로 subagent_type 'wiki-dedup-resolver'를 스폰해서, Codex는 자체 multi-agent delegation으로 아래 프롬프트를 그대로 스폰해 처리해."
        printf '%s\n' "$dedup_workflow"
      fi
    fi
  fi

  # Write-time semantic gate merge-review hint: same shape as the dedup hint
  # above, but for merge-needed.jsonl -- the queue core/wiki_compile.py
  # populates when a new candidate looks similar to an existing page instead
  # of auto-writing it. Cheap file test + text extraction only, no daemon call.
  # Unlike dedup-needed.jsonl (intentionally hardcoded), this path is
  # configurable (compile.mergeNeededPath) and already read as such by both
  # the producer (wiki_compile.py) and consumer (wiki_review.py) -- reuse the
  # already-loaded $config_json rather than hardcode the default here too.
  merge_needed_rel="$(printf '%s' "$config_json" | python3 -c 'import json,sys
try:
    cfg = json.load(sys.stdin)
except Exception:
    cfg = {}
compile_cfg = cfg.get("compile") if isinstance(cfg.get("compile"), dict) else {}
rel = compile_cfg.get("mergeNeededPath")
print(rel if isinstance(rel, str) and rel else ".auto-context/compile/merge-needed.jsonl")' 2>/dev/null)"
  [ -z "$merge_needed_rel" ] && merge_needed_rel=".auto-context/compile/merge-needed.jsonl"
  merge_queue="$workdir/$merge_needed_rel"
  if [ -s "$merge_queue" ]; then
    review_agent_file="$(cd "$(dirname "$0")/.." && pwd)/agents/wiki-review-resolver.md"
    if [ -f "$review_agent_file" ]; then
      review_workflow="$(awk '/<!-- WORKFLOW:START -->/{f=1;next}/<!-- WORKFLOW:END -->/{f=0}f' "$review_agent_file")"
      if [ -n "$review_workflow" ]; then
        echo "Claude Code는 Agent 도구로 subagent_type 'wiki-review-resolver'를 스폰해서, Codex는 자체 multi-agent delegation으로 아래 프롬프트를 그대로 스폰해 처리해."
        printf '%s\n' "$review_workflow"
      fi
    fi
  fi

  # 헬스체크: config·reason 검사 통과 후, fork 직전 1회 실행 (main() 호출에서만).
  # --resolve-only 내부 재귀호출(--cwd 포함)과 --worker 경로에서는 실행 안 됨.
  # 실패 시 stdout 1줄 표면화(무음 사망 방지, TTL 억제) — update fork는 계속 진행.
  if qmd_healthcheck; then
    notice_clear daemon-down "$workdir"
  else
    notice_once daemon-down "$workdir" "[qmd] 검색 데몬 미응답 — 이 세션은 문서 recall이 동작하지 않을 수 있습니다."
  fi

  # 색인 대기열 적체 표면화: 이 프로젝트 컬렉션 라인만 집계(데몬 호출 없는 파일 검사만 —
  # 동기 SessionStart 경로 원칙). 임계는 config staleQueueThreshold(기본 20).
  queue_file="${QMD_DIRTY_QUEUE:-$HOME/.config/qmd/dirty-queue}"
  stale_msg=""
  if [ -s "$queue_file" ]; then
    # config는 argv로 전달(heredoc이 stdin을 차지하므로 pipe 불가 — config_event_enabled와 동일 패턴).
    stale_msg=$(python3 - "$queue_file" "$config_json" <<'PY' 2>/dev/null || true
import json, sys
try:
    cfg = json.loads(sys.argv[2])
except Exception:
    cfg = {}
names = {c for c in cfg.get("collections", []) if isinstance(c, str)}
try:
    threshold = int(cfg.get("staleQueueThreshold", 20))
except (TypeError, ValueError):
    threshold = 20
if threshold <= 0:
    threshold = 20
count = 0
if names:
    try:
        with open(sys.argv[1], encoding="utf-8") as f:
            for line in f:
                if line.split("\t", 1)[0] in names:
                    count += 1
    except OSError:
        pass
if count >= threshold:
    print(f"[qmd] 색인 대기열에 이 프로젝트 문서 {count}건 적체 — recall 결과가 오래됐을 수 있습니다.")
PY
)
  fi
  if [ -n "$stale_msg" ]; then
    notice_once stale-queue "$workdir" "$stale_msg"
  else
    notice_clear stale-queue "$workdir"
  fi

  nohup bash "$0" --worker "$workdir" </dev/null >>"$LOG" 2>&1 &
  exit 0
}

if [ "$1" = "--skip" ]; then
  shift
  target="${1:-$PWD}"
  python3 - "$target" <<'PY'
import hashlib, os, sys, pathlib

target = sys.argv[1]
real = os.path.realpath(target)
h = hashlib.sha256(real.encode()).hexdigest()
skip_dir = pathlib.Path.home() / ".config" / "qmd" / "skip"
skip_dir.mkdir(parents=True, exist_ok=True)
marker = skip_dir / h
marker.touch()
print(f"[qmd] skip 마커 생성: {marker} (TTL 2h). 이번 세션에서 '{real}'의 gate deny가 해제됩니다.")
PY
  exit 0
fi

if [ "$1" = "--migrate-config" ]; then
  shift
  target="${1:-$PWD}"
  result=$(migrate_config_json "$target")
  migrated=$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("migrated"))' 2>/dev/null || echo "False")
  reason=$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("reason") or "")' 2>/dev/null || echo "")
  from_path=$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("from") or "")' 2>/dev/null || echo "")
  to_path=$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("to") or "")' 2>/dev/null || echo "")
  if [ "$migrated" = "True" ]; then
    printf '[qmd] Migrated %s -> %s\n' "$from_path" "$to_path"
  else
    printf '[qmd] No migration needed: %s\n' "${reason:-unknown}"
  fi
  exit 0
fi

if [ "$1" = "--init-wiki" ]; then
  shift
  preset="default"
  if [ "$1" = "--preset" ]; then
    preset="${2:-default}"
    shift 2
  fi
  target="${1:-$PWD}"
  python3 - "$target" "$preset" <<'PY'
import json
import os
from pathlib import Path
import sys
import tempfile

target = Path(sys.argv[1]).resolve()
preset = sys.argv[2] if len(sys.argv) > 2 else "default"
settings_dir = target / ".auto-context"
settings = settings_dir / "settings.json"

def ensure_settings_dir() -> None:
    if settings_dir.exists():
        if settings_dir.is_symlink() or not settings_dir.is_dir():
            print(f"[qmd] unsafe .auto-context path: {settings_dir}", file=sys.stderr)
            sys.exit(1)
    else:
        settings_dir.mkdir(parents=True, exist_ok=False)
    try:
        resolved = settings_dir.resolve()
        resolved.relative_to(target)
    except (OSError, ValueError):
        print(f"[qmd] unsafe .auto-context path: {settings_dir}", file=sys.stderr)
        sys.exit(1)
    if resolved != settings_dir:
        print(f"[qmd] unsafe .auto-context path: {settings_dir}", file=sys.stderr)
        sys.exit(1)

if settings.exists():
    try:
        config = json.loads(settings.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[qmd] invalid settings.json preserved: {settings}: {exc}", file=sys.stderr)
        sys.exit(1)
    if not isinstance(config, dict):
        print(f"[qmd] invalid settings.json preserved: {settings}: expected object", file=sys.stderr)
        sys.exit(1)
else:
    config = {}

ensure_settings_dir()
wiki = settings_dir / "wiki"

def ensure_project_dir(path: Path, label: str) -> None:
    if path.exists():
        if path.is_symlink() or not path.is_dir():
            print(f"[qmd] unsafe {label} path: {path}", file=sys.stderr)
            sys.exit(1)
    else:
        path.mkdir(parents=False, exist_ok=False)
    try:
        resolved = path.resolve()
        resolved.relative_to(target)
    except (OSError, ValueError):
        print(f"[qmd] unsafe {label} path: {path}", file=sys.stderr)
        sys.exit(1)
    if resolved != path:
        print(f"[qmd] unsafe {label} path: {path}", file=sys.stderr)
        sys.exit(1)


def ensure_project_file(path: Path, content: str) -> bool:
    if path.is_symlink():
        print(f"[qmd] unsafe wiki file path: {path}", file=sys.stderr)
        sys.exit(1)
    if path.exists():
        if not path.is_file():
            print(f"[qmd] unsafe wiki file path: {path}", file=sys.stderr)
            sys.exit(1)
        return False
    path.write_text(content, encoding="utf-8")
    return True

base_dirs = ["concepts", "entities", "decisions", "sessions", "comparisons", "queries"]
novel_dirs = ["characters", "world", "timeline", "plot", "style", "discarded", "decisions", "sessions"]
dir_names = novel_dirs if preset == "novel" else base_dirs
dirs = [wiki] + [wiki / name for name in dir_names]
for path in dirs:
    ensure_project_dir(path, "wiki")

files = {
    wiki / "SCHEMA.md": "# Auto-context Wiki Schema\n\nThis wiki stores promoted, durable project knowledge. Do not paste full transcripts here.\n",
    wiki / "index.md": "# Auto-context Wiki Index\n\n- decisions/\n- concepts/\n- entities/\n- sessions/\n",
    wiki / "log.md": "# Auto-context Wiki Log\n\nAppend notable wiki maintenance events here.\n",
}
created = []
for path, content in files.items():
    if ensure_project_file(path, content):
        created.append(str(path))

def slug(name: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in name).strip("-")
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned or "project"

wiki_collection = f"{slug(target.name)}-wiki"
collections = config.get("collections") if isinstance(config.get("collections"), list) else []
collections = [item for item in collections if isinstance(item, str)]
if wiki_collection not in collections:
    collections.append(wiki_collection)
config["collections"] = collections

collection_paths = config.get("collectionPaths") if isinstance(config.get("collectionPaths"), dict) else {}
collection_paths = {key: value for key, value in collection_paths.items() if isinstance(key, str) and isinstance(value, str)}
collection_paths[wiki_collection] = ".auto-context/wiki"
config["collectionPaths"] = collection_paths

collection_roles = config.get("collectionRoles") if isinstance(config.get("collectionRoles"), dict) else {}
collection_roles = {key: value for key, value in collection_roles.items() if isinstance(key, str) and isinstance(value, str)}
for collection in collections:
    collection_roles.setdefault(collection, "raw")
collection_roles[wiki_collection] = "wiki"
config["collectionRoles"] = collection_roles
config["recallStrategy"] = "hierarchical"
config.setdefault("wikiPath", ".auto-context/wiki")
if preset == "novel":
    compile_config = config.get("compile") if isinstance(config.get("compile"), dict) else {}
    compile_config.setdefault("enabled", True)
    compile_config.setdefault("mode", "auto-wiki")
    compile_config.setdefault("autoWrite", True)
    compile_config.setdefault("defaultStatus", "generated")
    compile_config.setdefault("requireReviewForCanon", True)
    compile_config.setdefault("candidatePath", ".auto-context/compile/candidates.jsonl")
    compile_config.setdefault("tombstonePath", ".auto-context/compile/tombstones.jsonl")
    compile_config.setdefault("manifestPath", ".auto-context/compile/generated-manifest.jsonl")
    compile_config.setdefault("excludeStatusesFromRecall", ["discarded", "contested"])
    compile_config.setdefault("lowPriorityStatuses", ["generated", "tentative"])
    compile_config.setdefault("triggers", ["manual", "explicit_user_approval", "post_session_summary"])
    compile_config.setdefault("maxAutoPageLines", 120)
    config["compile"] = compile_config
if "indexing" not in config:
    config["indexing"] = True

fd, tmp = tempfile.mkstemp(dir=str(settings_dir), prefix="settings.", suffix=".tmp")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(config, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp, settings)
except BaseException:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise

print(f"[qmd] wiki scaffold ready: {wiki} ({len(created)} files created)")
PY
  exit 0
fi

if [ "$1" = "--enable-compile" ]; then
  shift
  engines=""
  if [ "$1" = "--engines" ]; then engines="$2"; shift 2; fi
  target="${1:-$PWD}"
  if [ -n "$1" ]; then shift; fi
  if [ "$1" = "--engines" ]; then engines="$2"; shift 2; fi
  core_dir="$(cd "$(dirname "$0")" && pwd)"

  # Guard: project must be opted in via the modern .auto-context/settings.json format
  # (configFormat == "auto-context-dir") AT target itself. Walking up to HOME is intentional
  # for recall, but --enable-compile must write to target's own settings.json.
  # Refuse if: (a) not opted in at all, (b) opted-in via legacy config, or (c) config lives
  # in an ancestor directory — any of these would shadow or corrupt the legacy config.
  state="$(python3 - "$target" "$core_dir" <<'PY'
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[2])
import config as qmd_config
found = qmd_config.find_project_config(sys.argv[1])
cfg = found["config"]
fmt = found.get("configFormat", "none")
own_root = Path(found["projectRoot"]).resolve() == Path(sys.argv[1]).resolve()
if cfg.get("indexing") is True and own_root and fmt == "auto-context-dir":
    print("optin")
elif cfg.get("indexing") is True and own_root and fmt in ("auto-context-json", "agents-legacy"):
    print("legacy")
else:
    print("no")
PY
)"
  if [ "$state" = "legacy" ]; then
    printf '[qmd] 이 프로젝트는 레거시 config(.auto-context.json 또는 .agents/qmd-recall.json)로 opt-in되어 있습니다.\n'
    printf '      --enable-compile을 실행하면 새 .auto-context/settings.json이 레거시 config를 섀도잉해 기존 설정이 유실됩니다.\n'
    printf '      먼저 레거시 config를 마이그레이션한 뒤 다시 실행하세요:\n'
    printf '      bash core/update.sh --migrate-config %s\n' "$(printf %q "$target")"
    printf '      bash core/update.sh --enable-compile %s\n' "$(printf %q "$target")"
    exit 0
  fi
  if [ "$state" != "optin" ]; then
    echo "[qmd] 이 폴더는 아직 opt-in되지 않았습니다. 먼저 다음 중 하나를 실행하세요:"
    echo "      bash core/update.sh --optin --recommended $(printf %q "$target")"
    echo "      bash core/update.sh --optin $(printf %q "$target")"
    exit 0
  fi

  # Reuse --init-wiki for scaffold + recall config (idempotent, recall-only).
  bash "$0" --init-wiki "$target" >/dev/null 2>&1 || true

  # Merge the shared compile block (portable built-in engines, resolved by worker).
  python3 - "$target" "$core_dir" "$engines" <<'PY'
import json, os, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[2])
import wiki_compile_defaults as d

target = Path(sys.argv[1]).resolve()
engines = d.parse_engines(sys.argv[3] or None)
root = d.plugin_root()
settings = target / ".auto-context" / "settings.json"
cfg = json.loads(settings.read_text(encoding="utf-8"))

block = d.compile_block(root, engines)
existing = cfg.get("compile") if isinstance(cfg.get("compile"), dict) else {}
# Merge: block wins for the keys it sets (extractor/batch/enabled/...); unrelated existing keys are preserved.
merged = {**existing, **block}
existing_extractor = existing.get("extractor") if isinstance(existing.get("extractor"), dict) else {}
block_extractor = block.get("extractor") if isinstance(block.get("extractor"), dict) else {}
if existing_extractor:
    # Existing extractor config is explicit user/runtime configuration. Keep it ahead
    # of generated portable built-in defaults so --enable-compile stays non-destructive.
    merged["extractor"] = {**block_extractor, **existing_extractor}
trig = existing.get("triggers") if isinstance(existing.get("triggers"), list) else []
merged["triggers"] = list(dict.fromkeys(["post_tool_source", *trig, *block["triggers"]]))
cfg["compile"] = merged

fd, tmp = tempfile.mkstemp(dir=str(settings.parent), prefix="settings.", suffix=".tmp")
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    json.dump(cfg, fh, ensure_ascii=False, indent=2); fh.write("\n")
os.replace(tmp, settings)
print(f"[qmd] wiki auto-compile 활성화: {target}")
print(f"      엔진: {', '.join(engines)} (해당 host CLI가 없으면 자동 skip)")
print("      이제 raw/session 컬렉션의 .md를 편집하면 백그라운드로 해당 CLI를 실행해")
print("      wiki 페이지(status: generated)를 초안 작성합니다.")
print("      끄려면 settings.json의 compile.extractor 를 제거하세요.")
PY
  exit 0
fi

if [ "$1" = "--recommend" ]; then
  shift
  json_flag=""
  if [ "$1" = "--json" ]; then json_flag="--json"; shift; fi
  target="${1:-$PWD}"
  exec python3 "$(dirname "$0")/recommend_config.py" --cwd "$target" $json_flag
fi

if [ "$1" = "--optin" ] || [ "$1" = "--optout" ]; then
  mode="$1"; shift
  # --optin --recommended <path> 모드 감지
  if [ "$mode" = "--optin" ] && [ "$1" = "--recommended" ]; then
    shift
    target="${1:-$PWD}"
    python3 - "$target" "$(dirname "$0")" <<'PY'
import json, os, sys, tempfile, subprocess
from pathlib import Path
target = Path(sys.argv[1]).resolve()
core_dir = sys.argv[2]
sys.path.insert(0, str(Path(core_dir).resolve()))
import config as qmd_config
settings_dir = target / ".auto-context"
dest = settings_dir / "settings.json"
legacy_root = target / ".auto-context.json"
legacy = target / ".agents" / "qmd-recall.json"

def ensure_settings_dir() -> None:
    if settings_dir.exists():
        if settings_dir.is_symlink() or not settings_dir.is_dir():
            print(f"[qmd] unsafe .auto-context path: {settings_dir}", file=sys.stderr)
            sys.exit(1)
    else:
        settings_dir.mkdir(parents=True, exist_ok=False)
    try:
        resolved = settings_dir.resolve()
        resolved.relative_to(target)
    except (OSError, ValueError):
        print(f"[qmd] unsafe .auto-context path: {settings_dir}", file=sys.stderr)
        sys.exit(1)
    if resolved != settings_dir:
        print(f"[qmd] unsafe .auto-context path: {settings_dir}", file=sys.stderr)
        sys.exit(1)

# 기존 config 존재 시 미덮음
if dest.exists() or legacy_root.exists() or legacy.exists():
    existing = dest if dest.exists() else (legacy_root if legacy_root.exists() else legacy)
    print(f"[qmd] --optin --recommended: {existing} 이(가) 이미 존재합니다. 덮어쓰지 않습니다.", file=sys.stderr)
    sys.exit(1)
# recommend_config.py 호출
result = subprocess.run(
    [sys.executable, str(Path(core_dir) / "recommend_config.py"), "--cwd", str(target), "--json"],
    capture_output=True, text=True
)
if result.returncode != 0:
    print(f"[qmd] recommend_config.py 실패: {result.stderr.strip()}", file=sys.stderr)
    sys.exit(1)
try:
    rec = json.loads(result.stdout)
except json.JSONDecodeError as e:
    print(f"[qmd] recommend_config.py JSON 파싱 실패: {e}", file=sys.stderr)
    sys.exit(1)
if not rec.get("available"):
    print("[qmd] 추천 가능한 경로를 찾지 못했습니다. --optin 또는 .auto-context/settings.json 직접 작성을 쓰세요.", file=sys.stderr)
    sys.exit(1)
config = rec["config"]
ensure_settings_dir()
fd, tmp = tempfile.mkstemp(dir=str(settings_dir), prefix="settings.", suffix=".tmp")
try:
    with os.fdopen(fd, "w") as fh:
        json.dump(config, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, dest)
except BaseException:
    try: os.unlink(tmp)
    except OSError: pass
    raise
qmd_config.clear_local_optout(target)
print(f"[qmd] --optin --recommended 완료: {dest} ({config.get('collections')}). 다음 세션부터 인덱싱됩니다.")
PY
    # Scaffold wiki if the written config contains a wiki collection.
    # detect wikiPath or any collection whose collectionPaths entry is .auto-context/wiki
    _needs_wiki="$(python3 - "$target" <<'PYWIKI'
import json, sys
from pathlib import Path
settings = Path(sys.argv[1]) / ".auto-context" / "settings.json"
try:
    cfg = json.loads(settings.read_text(encoding="utf-8"))
except Exception:
    print("no"); sys.exit(0)
paths = cfg.get("collectionPaths") if isinstance(cfg.get("collectionPaths"), dict) else {}
if any(v == ".auto-context/wiki" for v in paths.values()) or cfg.get("wikiPath") == ".auto-context/wiki":
    print("yes")
else:
    print("no")
PYWIKI
)"
    if [ "$_needs_wiki" = "yes" ]; then
      bash "$0" --init-wiki "$target" >/dev/null 2>&1 || true
    fi
    exit 0
  fi
  target="${1:-$PWD}"
  python3 - "$mode" "$target" "$(dirname "$0")" <<'PY'
import json, os, sys, tempfile
from pathlib import Path
mode, target, core_dir = sys.argv[1], Path(sys.argv[2]).resolve(), sys.argv[3]
sys.path.insert(0, str(Path(core_dir).resolve()))
import config as qmd_config
settings_dir = target / ".auto-context"
dest = settings_dir / "settings.json"
legacy_root = target / ".auto-context.json"
legacy = target / ".agents" / "qmd-recall.json"

def ensure_settings_dir() -> None:
    if settings_dir.exists():
        if settings_dir.is_symlink() or not settings_dir.is_dir():
            print(f"[qmd] unsafe .auto-context path: {settings_dir}", file=sys.stderr)
            sys.exit(1)
    else:
        settings_dir.mkdir(parents=True, exist_ok=False)
    try:
        resolved = settings_dir.resolve()
        resolved.relative_to(target)
    except (OSError, ValueError):
        print(f"[qmd] unsafe .auto-context path: {settings_dir}", file=sys.stderr)
        sys.exit(1)
    if resolved != settings_dir:
        print(f"[qmd] unsafe .auto-context path: {settings_dir}", file=sys.stderr)
        sys.exit(1)

if mode == "--optout":
    marker = qmd_config.write_local_optout(target)
    print(f"[qmd] opt-out 완료: {target}. 로컬 decision store에 기록했습니다: {marker}. 이 폴더는 인덱싱·검색하지 않습니다.")
    sys.exit(0)

base = {}
used_legacy = False
used_root_legacy = False
for src in (dest, legacy_root, legacy):
    if src.exists():
        try:
            base = json.loads(src.read_text())
            if not isinstance(base, dict): base = {}
        except (OSError, json.JSONDecodeError): base = {}
        used_legacy = (src == legacy)   # 레거시를 base로 읽었는지(=dest 없었음)
        used_root_legacy = (src == legacy_root)
        break
if mode == "--optin":
    base["indexing"] = True
    if not base.get("collections"):
        base["collections"] = [target.name.replace(" ", "-")]
    msg = f"[qmd] opt-in 완료: {target} ({base['collections']}). 다음 세션부터 인덱싱됩니다."
ensure_settings_dir()
fd, tmp = tempfile.mkstemp(dir=str(settings_dir), prefix="settings.", suffix=".tmp")
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
if used_root_legacy and legacy_root.exists():
    legacy_root.unlink()
qmd_config.clear_local_optout(target)
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
    # set -e 가드: 데몬 부재는 resolve-only 실패가 아니다.
    qmd_healthcheck || true
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
