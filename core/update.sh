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

run_update() {
  normalize_qmd_path
  command -v qmd >/dev/null 2>&1 || exit 0

  workdir="$1"
  cd "$workdir" 2>/dev/null || exit 0
  
  log "START: cwd=$workdir"

  local migration_result
  migration_result=$(migrate_config_json "$workdir" 2>&1 || true)
  [ -n "$migration_result" ] && log "CONFIG MIGRATION: $migration_result"

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
      LOG="$LOG" EMBED_LOCK="$EMBED_LOCK" QMD_DAEMON_PORT="${QMD_DAEMON_PORT:-8483}" QMD_BACKEND_MANAGER="${QMD_BACKEND_MANAGER:-}" nohup bash -c '
        echo "$$" > "$EMBED_LOCK/pid" 2>/dev/null || true
        trap "rm -f \"$EMBED_LOCK/pid\" 2>/dev/null; rmdir \"$EMBED_LOCK\" 2>/dev/null" EXIT
        out=$(qmd embed 2>&1); printf "%s\n" "$out" >> "$LOG"
        if printf "%s" "$out" | grep -qiE "embedded|chunks"; then
          # SIGTERM 으로 graceful shutdown 유도 → 데몬이 SQLite clean close 하며 WAL checkpoint.
          # SIGKILL 강제종료는 clean close 차단 → WAL checkpoint 누락 → vec query 저하.
          if [ -n "${QMD_BACKEND_MANAGER:-}" ] && [ -x "$QMD_BACKEND_MANAGER" ]; then
            "$QMD_BACKEND_MANAGER" reload >> "$LOG" 2>&1 || true
          else
            printf "[%s] EMBED reload skipped: QMD_BACKEND_MANAGER unavailable\n" "$(date +%H:%M:%S)" >> "$LOG"
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

  # 헬스체크: config·reason 검사 통과 후, fork 직전 1회 실행 (main() 호출에서만).
  # --resolve-only 내부 재귀호출(--cwd 포함)과 --worker 경로에서는 실행 안 됨.
  qmd_healthcheck

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
print(f"[qmd] --optin --recommended 완료: {dest} ({config.get('collections')}). 다음 세션부터 인덱싱됩니다.")
PY
    exit 0
  fi
  target="${1:-$PWD}"
  python3 - "$mode" "$target" <<'PY'
import json, os, sys, tempfile
from pathlib import Path
mode, target = sys.argv[1], Path(sys.argv[2]).resolve()
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
else:
    base["indexing"] = False
    msg = f"[qmd] opt-out 완료: {target}. 이 폴더는 인덱싱·검색하지 않습니다."
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
