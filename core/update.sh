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
STATUS=""
STATUS_WORKDIR=""

# stdout: line1=canonical realpath, line2=status 파일 경로. realpath+sha256을
# 한 프로세스에서 함께 계산해 canonical_workdir/status_path_for_workdir 각각의
# 별도 python3 스폰(SessionStart 1회당 부기용 프로세스 4개)을 줄인다.
resolve_workdir_meta() {
  python3 - "$_QMD_CACHE_DIR" "$1" <<'PY'
import hashlib
import os
import sys

cache_dir, cwd = sys.argv[1:3]
real = os.path.realpath(cwd)
digest = hashlib.sha256(real.encode("utf-8")).hexdigest()[:16]
print(real)
print(os.path.join(cache_dir, f"update-status-{digest}.txt"))
PY
}

set_status_for_workdir() {
  if [ -n "${QMD_UPDATE_STATUS:-}" ] && [ -n "${QMD_CANONICAL_WORKDIR:-}" ]; then
    STATUS="$QMD_UPDATE_STATUS"
    STATUS_WORKDIR="$QMD_CANONICAL_WORKDIR"
    return 0
  fi
  local meta
  meta="$(resolve_workdir_meta "$1")"
  # STATUS(마지막 줄)를 먼저 tail로 떼어내고 나머지 전부를 STATUS_WORKDIR로
  # 취급한다. STATUS는 해시 기반 파일명이라 항상 개행 없는 단일 줄이 보장되지만,
  # STATUS_WORKDIR(cwd)는 이론상 경로에 개행이 섞인 pathological 케이스가 있을
  # 수 있어 sed -n 1p/2p 같은 위치 기반 파싱은 그 경우 값이 어긋난다.
  STATUS_WORKDIR="$(printf '%s\n' "$meta" | sed '$d')"
  if [ -n "${QMD_UPDATE_STATUS:-}" ]; then
    STATUS="$QMD_UPDATE_STATUS"
  else
    STATUS="$(printf '%s\n' "$meta" | tail -n 1)"
  fi
}

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
  # localhost(not 127.0.0.1): 데몬은 IPv6 ::1 바인딩. IPv4로 찌르면 false-dead 판정 → "데몬 미응답" 오탐.
  if curl -sf -m "$timeout" "http://localhost:${port}/health" >/dev/null 2>&1; then
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
  local key="$1" project="$2" message="$3" marker ttl now mtime age
  [ -n "${QMD_SUPPRESS_NOTICE:-}" ] && return 0
  marker="$(_notice_marker "$key" "$project")"
  ttl="${QMD_NOTICE_TTL_SECS:-14400}"
  case "$ttl" in ''|*[!0-9]*) ttl=14400 ;; esac
  if [ -f "$marker" ]; then
    now=$(date +%s)
    mtime=$(stat -f %m "$marker" 2>/dev/null || stat -c %Y "$marker" 2>/dev/null || echo 0)
    age=$((now - mtime))
    # 미래 mtime 가드(시계 되돌림·백업 복원·파일시스템 이관). age가 음수면 `-lt $ttl`이
    # 참이 되어 그 marker가 **모든 알림을 영구 억제**한다 — 이 함수는 orphan 회수 실패·
    # unregister 실패·source_missing·invalid role 등 **모든 종점**이 사용자에게 닿는
    # 유일한 채널이므로, 여기서 조용해지면 다른 어떤 가드도 표면화되지 않는다.
    # python 쪽 동일 규칙은 `core/cooldown.py:window_elapsed`(관용 60초)다.
    if [ "$age" -ge -60 ] && [ "$age" -lt "$ttl" ]; then
      return 0
    fi
  fi
  echo "$message"
  : > "$marker" 2>/dev/null || true
}

notice_clear() {
  rm -f "$(_notice_marker "$1" "$2")" 2>/dev/null || true
}

# worker → main 신호 파일. worker(백그라운드 fork)의 stdout은 사용자에게 닿지 않으므로
# "role source 컬렉션의 qmd 등록 해제에 실패했다"는 사실을 파일로 남기고, 다음
# SessionStart의 동기 경로가 읽어 notice_once로 알린다(dedup/merge 힌트와 같은
# "값싼 파일 검사 + 텍스트 추출" 패턴 — hot path에서 qmd/데몬을 부르지 않는다).
# 위치는 notice marker와 같은 캐시 디렉터리이고 키도 같은 해시라 프로젝트별로 갈린다.
#
# **키(`-state` 접미사)를 notice 키와 반드시 다르게 유지할 것.** `notice_once`는 marker
# 파일의 **존재와 mtime**을 TTL 억제에 쓰므로, 상태 파일이 같은 경로면 worker가 상태를
# 쓰는 순간 그것이 곧 "방금 알렸다"는 marker가 되어 **notice가 자기 자신을 억제한다**
# (한 글자 차이로 신호가 통째로 죽는다 — 처음 구현이 정확히 이랬다).
unregister_failed_state() {
  printf '%s' "$(_notice_marker unregister-failed-state "$1")"
}

# orphan 벡터 회수의 1차 트리거. `qmd collection remove`가 **실제로 성공**한 직후에만
# 부른다 — 그 순간 orphan 벡터가 생긴 것이 확실하므로(qmd 2.5.3 `removeCollection`은
# 벡터를 지우지 않는다) 비율 임계를 따지지 않고 회수 대상으로 표시한다.
#
# 마커 경로는 core/orphan_reclaim.py가 SSOT다(전역 1개 — qmd 인덱스가 전역 파일이므로
# "orphan이 있다"는 사실도 프로젝트별이 아니다). 여기서 경로를 다시 적지 않고 스크립트를
# 부른다: 두 벌로 갈리면 쓰는 쪽과 읽는 쪽이 다른 파일을 보게 되고, 그 실패는 조용하다.
# 제거는 드문 이벤트라 python 스폰 1회는 문제가 되지 않는다(hot path 아님).
mark_orphan_reclaim_pending() {
  python3 "$_QMD_CORE_DIR/orphan_reclaim.py" --mark-pending >/dev/null 2>&1 || true
}

# main()이 회수 실패를 notice로 표면화할 때 읽는 전역 상태 파일. 경로는
# orphan_reclaim.failed_path()와 **반드시 같아야** 한다(양쪽 주석에 명시).
orphan_reclaim_failed_state() {
  printf '%s' "$_QMD_CACHE_DIR/orphan-reclaim-failed"
}

wiki_compile_notice_info() {
  local cwd="$1"
  local core_dir="$2"
  python3 - "$cwd" "$core_dir" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import sys

try:
    if os.environ.get("QMD_SUPPRESS_NOTICE"):
        print(json.dumps({"engines": "", "show": False}))
        raise SystemExit(0)

    cwd = Path(sys.argv[1]).resolve()
    core_dir = Path(sys.argv[2]).resolve()
    sys.path.insert(0, str(core_dir))
    import config as qmd_config

    info = qmd_config.find_project_config(str(cwd))
    config = info.get("config") if isinstance(info.get("config"), dict) else {}
    compile_config = config.get("compile") if isinstance(config.get("compile"), dict) else {}
    extractor = compile_config.get("extractor") if isinstance(compile_config.get("extractor"), dict) else {}
    backends = extractor.get("backends") if isinstance(extractor.get("backends"), dict) else {}
    builtins = extractor.get("builtins") if isinstance(extractor.get("builtins"), list) else []
    engines = sorted(set(backends.keys()) | {engine for engine in builtins if isinstance(engine, str)})
    if not engines:
        print(json.dumps({"engines": "", "show": False}))
        raise SystemExit(0)

    # find_project_config is the source of truth for parent-config inheritance.
    # resolve() makes symlink entry points share the same project identity.
    project_root = Path(info.get("projectRoot") or cwd).resolve()
    project_hash = hashlib.sha256(str(project_root).encode("utf-8")).hexdigest()
    state_dir_value = os.environ.get("QMD_NOTICE_STATE_DIR")
    state_dir = Path(state_dir_value).expanduser() if state_dir_value else (
        Path.home() / ".config" / "qmd" / "notice-state" / "wiki-auto-compile"
    )
    local_marker = state_dir / f"{project_hash}.notice-shown"
    legacy_marker = project_root / ".auto-context" / "compile" / ".notice-shown"

    if local_marker.is_file():
        show = False
    elif legacy_marker.is_file():
        # Legacy compatibility is read-only with respect to the project. The
        # user-local marker is best-effort, so a state-dir failure is harmless.
        try:
            local_marker.parent.mkdir(parents=True, exist_ok=True)
            local_marker.touch(exist_ok=True)
        except OSError:
            pass
        show = False
    else:
        # Claim the first-run notice atomically where possible. If the state
        # directory cannot be written, retain the old fail-open behavior and
        # still emit the notice without failing the hook.
        try:
            local_marker.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        try:
            fd = os.open(local_marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(fd)
            show = True
        except FileExistsError:
            show = False
        except OSError:
            show = True

    print(json.dumps({"engines": ",".join(engines), "show": show}))
except Exception:
    # A first-run disclosure must never break SessionStart.
    print(json.dumps({"engines": "", "show": False}))
PY
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

# --- qmd 레지스트리 조회 (SSOT) -------------------------------------------
#
# "이 컬렉션이 qmd에 실제로 등록돼 있는가"를 묻는 곳이 세 군데(preflight / prune /
# unregister)라 파서를 한 벌로 모은다. 파서가 갈리면 한 곳만 조용히 빈 목록을 받는다.
#
# **파싱 실패와 "등록 0건"을 구분하지 않고 둘 다 `unknown`으로 본다.** 출력 형식이
# 바뀌어(예: 들여쓰기) awk가 빈 결과를 내면 "등록 안 됨"으로 읽히는데, 그 오독의
# 대가가 경로마다 다르다 — prune에서는 **되돌릴 수 없는 고아 등록**이 된다. 그래서
# 판정을 boolean이 아니라 3값(yes/no/unknown)으로 내고 호출부가 각자 안전한 쪽을 고른다.
_QMD_REGISTRY=""
_QMD_REGISTRY_LOADED=0

qmd_registry_invalidate() { _QMD_REGISTRY_LOADED=0; _QMD_REGISTRY=""; }

qmd_registry_load() {
  [ "$_QMD_REGISTRY_LOADED" = 1 ] && return 0
  _QMD_REGISTRY=$(qmd collection list 2>/dev/null | awk '/^[^ ]/ {print $1}')
  _QMD_REGISTRY_LOADED=1
}

# 0=등록됨 / 1=등록 안 됨 / 2=알 수 없음(레지스트리를 읽지 못했다)
qmd_collection_registered() {
  qmd_registry_load
  [ -z "$_QMD_REGISTRY" ] && return 2
  printf '%s\n' "$_QMD_REGISTRY" | grep -qxF -- "$1" && return 0
  return 1
}

preflight_remove_risky() {
  qmd_registry_load
  printf '%s\n' "$_QMD_REGISTRY" | while read -r name; do
    [ -z "$name" ] && continue
    path=$(qmd collection show "$name" 2>/dev/null | awk -F': +' '/^ *Path|^ *Root/ {print $2; exit}')
    [ -z "$path" ] && continue
    if path_refused_by_resolver "$path"; then
      log "PREFLIGHT: removing risky collection '$name' (path=$path)"
      # 이 루프는 `| while`이라 서브셸이다 — 변수로 신호를 올릴 수 없으므로 마커 파일을 쓴다
      # (mark_orphan_reclaim_pending이 파일 기반인 이유 중 하나).
      qmd collection remove "$name" >>"$LOG" 2>&1 && mark_orphan_reclaim_pending || true
    fi
  done
  # while이 서브셸이라 캐시 무효화가 부모로 전파되지 않는다 — 여기서 명시적으로 버린다.
  qmd_registry_invalidate
}

# role `source`로 전환된 컬렉션을 qmd 인덱스에서 **실제로** 제거한다.
#
# 등록만 건너뛰는 것으로는 부족하다: 이미 인덱싱된 문서는 recall 질의 대상(collection
# scope)에서만 빠지고 전역 FTS/vec 후보 창은 계속 점유한다 — 8단계가 측정하려는
# crowding이 정확히 그 점유이므로, 남겨 두면 `raw` → `source` 전환의 전후 비교가
# 무의미해진다.
#
# **settings.json은 건드리지 않는다.** collections/collectionPaths에 그대로 남으므로
# role을 `raw`로 되돌리면 다음 SessionStart의 `collection add` + `qmd update` + `embed`가
# 재등록·재인덱싱한다(가역성 — 되돌림에 필요한 것은 role 한 글자뿐이고 재색인 비용만 든다).
# 이것이 root가 사라진 컬렉션을 설정에서 지우는 prune_missing_settings_collections와
# 다른 점이다 — 저기는 소스 자체가 없어졌고, 여기는 사용자가 "색인만 빼라"고 말한 것이다.
#
# role 판정은 resolve_paths.py가 이미 끝냈다(`sourceEntries`). 여기서 role 문자열을 다시
# 비교하지 않는다 — 판정이 두 벌로 갈리면 한쪽만 새 role을 알게 된다.
#
# **상류 한계(qmd 2.5.3, 우리 코드 결함 아님)**: `qmd collection remove`
# (`dist/store.js:2265` `removeCollection`)는 `documents`·`content`만 DELETE하고
# **벡터를 지우지 않는다.** 라이브 인덱스 실측으로 `content_vectors` 41,285행 중
# orphan 26,267행(63.6%)이 확인됐고, qmd는 벡터 후보를 `vectors_vec` 상위 limit×3에서
# **orphan 포함**으로 뽑는다. 따라서 이 함수가 성공해도 제거되는 것은 **FTS 점유뿐이고
# 벡터 점유는 남는다** — 로드맵 8단계의 raw on/off A/B는 vec 경로에서 차이를 만들지
# 못한다. 해결(벡터 직접 purge / 인덱스 재구축 / vec 측정 불가 확정)은 사용자 판단이
# 필요한 별건이다. 이 주석을 지우면 코드가 "제거했다"고 전제하는 것처럼 읽힌다.
#
# 실패는 **조용히 넘기지 않는다**(종점 신호). 재시도 자체는 self-healing이라 옳지만,
# 실패가 로그에만 남으면 "색인하지 마라"고 말한 컬렉션이 무한정 인덱싱·전역 검색된다.
# 이 함수는 worker(백그라운드 fork)에서 돌아 stdout이 사용자에게 닿지 않으므로,
# 상태를 파일로 남기고 다음 SessionStart의 동기 경로(main)가 notice_once로 알린다.
unregister_source_collections() {
  local resolved_json="$1" workdir="$2"
  local state
  state="$(unregister_failed_state "$workdir")"
  [ -z "$resolved_json" ] && return 0
  local source_names
  source_names=$(printf '%s' "$resolved_json" | python3 -c 'import json,sys
try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
if not isinstance(data, dict) or data.get("refused"):
    raise SystemExit(0)
for entry in data.get("sourceEntries") or []:
    if isinstance(entry, dict) and isinstance(entry.get("name"), str):
        print(entry["name"])' 2>>"$LOG") || return 0
  if [ -z "$source_names" ]; then
    # role source가 하나도 없으면 지난 실패 기록은 더 이상 유효하지 않다(조건 해소).
    rm -f "$state" 2>/dev/null || true
    return 0
  fi

  local failed=""
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    # bare 호출은 set -e 아래에서 worker를 죽인다 — 반드시 `|| rc=$?`로 받는다.
    local registered_rc=0
    qmd_collection_registered "$name" || registered_rc=$?
    case "$registered_rc" in
      0)
        log "UNREGISTER SOURCE COLLECTION: $name (role=source)"
        if qmd collection remove "$name" >>"$LOG" 2>&1; then
          qmd_registry_invalidate
          mark_orphan_reclaim_pending
        else
          # 등록돼 있는 것을 확인했는데 제거가 실패했다 = 사용자에게 알릴 사실.
          log "UNREGISTER SOURCE COLLECTION FAILED: $name"
          failed="${failed}${failed:+, }${name}"
        fi
        ;;
      1)
        : # 등록돼 있지 않다 — 지울 것이 없다(정상).
        ;;
      *)
        # 레지스트리를 읽지 못했다. 시도는 하되 실패를 알리지는 않는다 — "등록 안 됨"과
        # "제거 실패"를 구분할 수 없어서, 알리면 한 번도 색인된 적 없는 source 컬렉션마다
        # 매 세션 거짓 경보가 난다. notice는 "등록을 확인했는데 실패"일 때만 낸다.
        log "UNREGISTER SOURCE COLLECTION: $name (registry unreadable, attempting)"
        qmd collection remove "$name" >>"$LOG" 2>&1 \
          && { qmd_registry_invalidate; mark_orphan_reclaim_pending; } \
          || log "UNREGISTER SOURCE COLLECTION: $name remove failed (registry unknown)"
        ;;
    esac
  done <<EOF
$source_names
EOF

  if [ -n "$failed" ]; then
    printf '%s\n' "$failed" >"$state" 2>/dev/null || true
  else
    rm -f "$state" 2>/dev/null || true
  fi
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
    [ -n "$STATUS_WORKDIR" ] && echo "cwd: $STATUS_WORKDIR"
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
        # role은 **넘기지 않는다**. "role source는 등록된 적 없으니 remove를 건너뛴다"는
        # 판정은 unregister가 이미 성공한 경우에만 참인데 prune이 unregister보다 **먼저**
        # 돌아서, 아직 등록돼 있는 source를 settings에서만 지워 **되돌릴 수 없는 고아
        # 등록**을 만들었다(이름이 사라지면 sourceEntries에도 prune에도 다시 안 나타난다).
        # 대신 셸이 실제 등록 여부를 확인한다 — role과 무관하게 옳고, "raw인데 한 번도
        # 등록되지 않은" 경우(원래 skip을 만든 WARN 반복)도 같이 해결한다.
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
    # 등록 여부로 판정한다(role 아님 — 위 heredoc 주석 참고). 레지스트리를 읽지
    # 못했으면(`unknown`) **지우는 쪽을 시도한다**: 잘못 건너뛰면 고아 등록이 남아
    # 복구 경로가 없고, 잘못 시도하면 실패 로그 한 줄에 settings 정리가 미뤄질 뿐
    # (다음 세션이 재시도한다). 비대칭이 명확하므로 회복 가능한 쪽으로 튄다.
    # `|| rc=$?`로 받는다 — bare 호출은 set -e 아래에서 worker를 죽인다.
    local registered_rc=0
    qmd_collection_registered "$name" || registered_rc=$?
    if [ "$registered_rc" = 1 ]; then
      log "PRUNE MISSING COLLECTION: $name is not registered in qmd, settings cleanup only"
      successful="${successful}${name}
"
    elif qmd collection remove "$name" >>"$LOG" 2>&1; then
      qmd_registry_invalidate
      mark_orphan_reclaim_pending
      successful="${successful}${name}
"
    else
      log "PRUNE MISSING COLLECTION FAILED: $name (registered=${registered_rc})"
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
  set_status_for_workdir "$workdir"
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
  unregister_source_collections "$resolved" "$workdir"

  # 3. Add collections
  #
  # entries 추출에 f-string 을 쓰지 않는다. `-c` 인수는 single-quote 안에 들어가므로
  # f-string 표현식에 `\"` 이스케이프가 섞이면 SyntaxError 가 되고(Python 3.13 에서도),
  # 예전에는 그 stderr 를 /dev/null 로 버려 **while 루프가 조용히 0회 돌았다** —
  # collections_ok 는 초기값 1 로 남아 `qmd update` 만 성공하고 END rc=0 이 찍혀서
  # 실패가 성공처럼 보였다. 즉 SessionStart 는 collection add 를 한 번도 하지 않았고
  # 컬렉션 등록·경로 변경이 반영되지 않았다(index_worker 경로가 대신 등록해 증상이 가려짐).
  # stderr 는 버리지 말고 LOG 로 보내고, entries 가 비면 명시적으로 경고를 남긴다.
  #
  # `indexEntries`(role이 INDEXED_ROLES인 것만)를 쓴다. `entries`를 쓰면 role `source`
  # 컬렉션까지 qmd에 등록돼 "compile 입력이지만 인덱싱·recall 대상 아님"이라는 role의
  # 정의가 무너진다. 필터는 resolve_paths.py가 하고 여기서 role 문자열을 다시 비교하지
  # 않는다(판정 이중화 방지).
  local entries_tsv
  entries_tsv=$(echo "$resolved" | python3 -c 'import json,sys; [print(e["name"] + "\t" + e["path"]) for e in json.load(sys.stdin).get("indexEntries", [])]' 2>>"$LOG")
  if [ -z "$entries_tsv" ]; then
    log "WARN: no collection entries resolved — collection add skipped"
  fi
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
  done <<< "$entries_tsv"

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
    
    if [ -n "${QMD_SKIP_BACKGROUND_EMBED:-}" ]; then
      # 백그라운드 fork(embed + retroactive dedup scan)를 건너뛴다. 이 fork는 detached라
      # 호출자가 반환된 뒤에도 workdir에 쓰므로, 임시 디렉터리를 정리하는 호출자(테스트)와
      # 경합해 ENOTEMPTY를 낸다 — 실측: 스위트 4회 중 1회 간헐 실패. 스위트를 커밋 게이트로
      # 쓰는 한 "0 fail"의 신호 가치를 지켜야 하므로 명시적 스위치를 둔다. fork 자체를
      # 검증하는 테스트는 이 값을 끄고 자식의 로그를 기다린다.
      log "EMBED: skipped (QMD_SKIP_BACKGROUND_EMBED)"
    elif ! mkdir "$EMBED_LOCK" 2>/dev/null; then
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
        # orphan 벡터 회수. **embed 다음에 두는 것이 직렬화 수단이다** — `qmd cleanup`은
        # vacuum을 하므로 우리 자신의 embed와 겹치면 서로를 기다린다(SQLite busy timeout).
        # 데몬은 멈추지 않는다: 실측으로 `qmd cleanup`은 데몬이 DB를 잡고 열린 read
        # 트랜잭션을 들고 있어도 성공하고(rc=0), 배타적 write 트랜잭션이 있으면 5.1s를
        # 기다린 뒤 성공한다. 새 스케줄러를 만들지 않고 기존 배수 경로(3단계 dedup scan과
        # 같은 자리)를 재사용한다.
        python3 "$CORE_DIR/orphan_reclaim.py" --cwd "$WORKDIR" --qmd-bin "$QMD_BIN_RESOLVED" >> "$LOG" 2>&1 || true
      ' >/dev/null 2>&1 &
      log "EMBED: started in background (pid=$!)"
    fi
  else
    write_failure_status "qmd update" "$LAST_OUT"
    log "END rc=1 - status written to $STATUS"
  fi

  # 소스 소실 스캔(로드맵 3단계). 여기(worker 경로)인 이유:
  #   (a) blocking hook 예산을 쓰지 않는다 — worker는 이미 백그라운드 fork다.
  #   (b) 데몬·embed·LLM에 의존하지 않는 파일시스템 stat 검사이므로 dedup 스캔처럼
  #       embed 서브셸 안에 둘 이유가 없다. 그 안에 두면 embed lock 경합이나
  #       `qmd update` 실패로 소실 감지가 조용히 건너뛰어진다.
  #   (c) 새 스케줄러를 만들지 않고 기존 배수 경로를 재사용한다.
  # 비용 상한과 순환 커서는 스캐너 안에 있다(compile.sourceScan.maxCardsPerScan).
  python3 "$(dirname "$0")/wiki_source_scan.py" --cwd "$workdir" >> "$LOG" 2>&1 || true
}

main() {
  # SessionStart hook은 항상 exit 0이어야 한다(hook_main.run과 동일한 불변식의
  # bash판). 이 동기 경로는 notice 계산 + worker fork가 전부이고 모두 fail-open이
  # 목표라, set -e를 꺼서 어떤 command substitution 실패(빈/비JSON stdin에 python3
  # crash, cd 실패, notice 계산 중 파일 소실 등)도 hook 전체를 non-zero exit로
  # 떨어뜨리지 못하게 한다. 실패는 빈 값/스킵으로 흘리고 아래 fallback·worker가
  # 처리한다. worker(run_update)는 별도 프로세스 재실행이라 자체 set -e를 유지한다.
  set +e
  raw=$(cat)
  workdir=$(printf '%s' "$raw" | python3 -c 'import json,sys,os; print((json.load(sys.stdin).get("cwd") or os.getcwd()))' 2>/dev/null)
  [ -z "$workdir" ] && workdir="$PWD"
  set_status_for_workdir "$workdir"

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

  # First-run disclosure: extractor configured but not yet announced for this
  # project. State is keyed by config.py's canonical projectRoot, never by
  # the raw cwd, so nested sessions cannot create project-local marker files.
  notice_info="$(wiki_compile_notice_info "$workdir" "$(dirname "$0")" 2>/dev/null || true)"
  notice_engines="$(printf '%s' "$notice_info" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("engines") or "")' 2>/dev/null || true)"
  notice_show="$(printf '%s' "$notice_info" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin).get("show") else "no")' 2>/dev/null || true)"
  if [ -n "$notice_engines" ] && [ "$notice_show" = "yes" ]; then
    echo "[qmd] wiki auto-compile이 활성화되어 있습니다 (엔진: $notice_engines)."
    echo "      raw/session/source 컬렉션의 .md를 편집하면 백그라운드로 해당 CLI를 실행해 wiki 초안(generated)을 만듭니다."
    echo "      끄려면 .auto-context/settings.json의 compile.extractor 를 제거하세요."
  fi

  # role source 등록 해제 실패 표면화. 판정은 worker가 끝냈고(등록을 확인했는데
  # `qmd collection remove`가 실패) 여기서는 신호 파일만 읽는다 — hot path에서 qmd를
  # 부르지 않는 dedup/merge 힌트와 같은 "값싼 파일 검사 + 텍스트 추출" 패턴이다.
  # 재시도는 worker가 매 세션 계속하므로 self-healing이고, 이 notice는 그 재시도가
  # 계속 실패한다는 **종점 신호**다(없으면 "색인하지 마라"고 말한 컬렉션이 조용히
  # 무한정 인덱싱된다). 해제에 성공하거나 role이 source가 아니게 되면 worker가 파일을
  # 지우므로 조건 해소 시 자동으로 재무장한다.
  unregister_failed=""
  unregister_state="$(unregister_failed_state "$workdir")"
  [ -s "$unregister_state" ] && unregister_failed="$(cat "$unregister_state" 2>/dev/null || true)"
  if [ -n "$unregister_failed" ]; then
    notice_once unregister-failed "$workdir" "[qmd] role source 컬렉션을 qmd 인덱스에서 제거하지 못했습니다: ${unregister_failed}. 그때까지 이 컬렉션은 계속 색인·검색됩니다. 'qmd collection remove <이름>'을 직접 실행하거나 qmd 데몬 상태를 확인하세요."
  else
    notice_clear unregister-failed "$workdir"
  fi

  # orphan 벡터 회수 실패 표면화(같은 종점 패턴). 회수는 백그라운드 fork에서 돌아
  # stdout이 사용자에게 닿지 않으므로 실패 사유를 전역 파일에 남기고 여기서 읽는다.
  # 이 notice가 없으면 죽은 벡터가 계속 쌓이고 vec 후보 창을 갉아먹는 것이 조용히
  # 진행된다(8단계에서 63.8%까지 쌓여 있었다). 재시도는 cooldown 주기로 계속되며
  # (기본 24h) 성공 시 orphan_reclaim.py가 파일을 지워 자동 재무장한다.
  orphan_reclaim_failed=""
  orphan_reclaim_state="$(orphan_reclaim_failed_state)"
  [ -s "$orphan_reclaim_state" ] && orphan_reclaim_failed="$(head -n 1 "$orphan_reclaim_state" 2>/dev/null || true)"
  if [ -n "$orphan_reclaim_failed" ]; then
    notice_once orphan-reclaim "$workdir" "[qmd] 죽은(orphan) 벡터 회수에 실패했습니다: ${orphan_reclaim_failed}. 쌓이면 검색 후보 창을 잠식합니다. 'qmd cleanup'을 직접 실행하거나 로그(~/.cache/qmd/orphan-reclaim.log)를 확인하세요."
  else
    notice_clear orphan-reclaim "$workdir"
  fi

  # 미지 role 값 표면화. `collectionRoles`에 **키가 있는데 값이 닫힌 집합
  # (raw/wiki/session/source) 밖**이면 그 컬렉션을 인덱싱·recall·compile에서 전부
  # 제외한다(fail-closed). 키 자체가 없는 것과 구분하는 것이 핵심이다 —
  # 키 없음은 role 도입 전 프로젝트라 `raw`가 맞지만, 키가 있다는 것은 사용자가
  # 무언가를 의도했는데 우리가 못 읽었다는 뜻이고, 그때 `raw`로 fail-open하면
  # `"sourse"` 오타 하나가 "색인 제외"를 **실제 색인**으로 뒤집는다(사용자 데이터가
  # 의도치 않게 인덱싱되는 방향). 대신 제외 상태가 조용히 지속되면 안 되므로
  # 여기가 종점이다: 이미 로드된 settings로 판정하고(설정 파일 재독해 0 — 다만
  # python 기동과 config import 비용은 있다) notice_once로 TTL 억제하며, 값을
  # 고치면 재무장한다.
  # config는 argv로 전달한다 — heredoc이 stdin을 차지하므로 파이프는 무시된다
  # (stale-queue·root-path 안내와 동일 패턴).
  invalid_roles=$(python3 - "$(dirname "$0")" "$config_json" <<'PY' 2>/dev/null || true
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
import config as qmd_config

try:
    cfg = json.loads(sys.argv[2] or "{}")
except Exception:
    raise SystemExit(0)
if not isinstance(cfg, dict):
    raise SystemExit(0)
collections = [c for c in (cfg.get("collections") or []) if isinstance(c, str)]
names = qmd_config.invalid_role_collections(cfg.get("collectionRoles"), collections)
if names:
    print(", ".join(names))
PY
)
  if [ -n "$invalid_roles" ]; then
    notice_once role-invalid "$workdir" "[qmd] collectionRoles의 role 값을 인식할 수 없어 색인·recall·compile에서 제외했습니다: ${invalid_roles}. 허용값은 raw, wiki, session, source 입니다."
  else
    notice_clear role-invalid "$workdir"
  fi

  # 제거된 설정 키 알림. 스키마 정리로 사라진 키는 normalize_config()가 **조용히**
  # 무시하므로(하위호환 없음), 사용자는 `verify.maxPerRun: 15`가 여전히 검수 예산인
  # 줄 안다. 판정도 문구도 python이 SSOT다(config.deprecated_key_notice) — 키 목록과
  # 행선지가 bash에 복제되면 갈리는 순간 알림이 틀린 행선지를 말한다.
  #
  # **marker 쓰기가 여기(update 동기 경로)에만 있는 것이 요점이다.** 감지 함수 자체는
  # 무해하지만 recall/posttool 같은 blocking hook이 notice_once를 부르면 그 훅이
  # marker를 선점해 TTL 동안 SessionStart 알림 전체가 삼켜진다(Hermes
  # QMD_SUPPRESS_NOTICE가 막으려는 것과 같은 클래스).
  #
  # 이미 로드된 $config_json(raw, 정규화 전)을 argv로 넘긴다 — heredoc이 stdin을
  # 차지하므로 파이프는 무시된다(role-invalid·stale-queue와 동일 패턴). 정규화된
  # config를 보면 제거된 키는 이미 사라진 뒤라 아무것도 감지되지 않는다.
  deprecated_msg=$(python3 - "$(dirname "$0")" "$config_json" <<'PY' 2>/dev/null || true
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
import config as qmd_config

try:
    cfg = json.loads(sys.argv[2] or "{}")
except Exception:
    raise SystemExit(0)
if not isinstance(cfg, dict):
    raise SystemExit(0)
message = qmd_config.deprecated_key_notice(cfg)
if message:
    print(message)
PY
)
  if [ -n "$deprecated_msg" ]; then
    notice_once deprecated-keys "$workdir" "$deprecated_msg"
  else
    notice_clear deprecated-keys "$workdir"
  fi

  # Retroactive wiki dedup hint: if a scan (this run's or a past one's) queued
  # pairs that haven't been resolved yet, surface it two ways. Cheap file test +
  # text extraction only -- no daemon call -- since this runs in the hot
  # synchronous SessionStart path.
  #   (a) A user-facing notice (TTL-suppressed, same notice_once pattern as
  #       daemon-down/stale-queue) so the human sees the backlog and can trigger
  #       the `wiki-dedup` skill even when the model ignores the spawn hint.
  #   (b) The model-facing spawn hint. WORKFLOW stays SSOT in
  #       agents/wiki-dedup-resolver.md (read here, never re-copied).
  dedup_queue="$workdir/.auto-context/compile/dedup-needed.jsonl"
  if [ -s "$dedup_queue" ]; then
    dedup_count=$(grep -c '[^[:space:]]' "$dedup_queue" 2>/dev/null || echo 0)
    notice_once wiki-dedup "$workdir" "[qmd] wiki 중복 후보 ${dedup_count}건 대기 — 정리하려면 '/wiki-dedup' 또는 '위키 중복 정리해줘'라고 요청하세요."
    agent_file="$(cd "$(dirname "$0")/.." && pwd)/agents/wiki-dedup-resolver.md"
    if [ -f "$agent_file" ]; then
      dedup_workflow="$(awk '/<!-- WORKFLOW:START -->/{f=1;next}/<!-- WORKFLOW:END -->/{f=0}f' "$agent_file")"
      if [ -n "$dedup_workflow" ]; then
        echo "이것은 사용자 요청과 독립적인 백그라운드 유지보수 작업이다 — 지금 즉시 처리해라. Claude Code는 Agent 도구로 subagent_type 'wiki-dedup-resolver'를 스폰해서, Codex는 자체 multi-agent delegation으로 아래 프롬프트를 그대로 스폰해 처리해."
        printf '%s\n' "$dedup_workflow"
      fi
    fi
  else
    notice_clear wiki-dedup "$workdir"
  fi

  # Write-time semantic gate merge-review hint: same shape as the dedup hint
  # above, but for merge-needed.jsonl -- the queue core/wiki_compile.py
  # populates when a new candidate looks similar to an existing page instead
  # of auto-writing it. Cheap file test only, no daemon call and no python.
  # The location is a constant now (core/compile_paths.py :: MERGE_NEEDED); the
  # old `compile.mergeNeededPath` setting is gone, so the producer
  # (wiki_compile.py), the consumer (wiki_review.py) and this hint all read the
  # same literal. Keep this string in sync with that table -- if it drifts, the
  # review notice goes silent with no other symptom.
  merge_queue="$workdir/.auto-context/compile/merge-needed.jsonl"
  if [ -s "$merge_queue" ]; then
    # Symmetric with the dedup hint above: (a) user-facing notice so the human
    # sees the backlog and can trigger the `wiki-review` skill, (b) model-facing
    # spawn hint. WORKFLOW stays SSOT in agents/wiki-review-resolver.md.
    merge_count=$(grep -c '[^[:space:]]' "$merge_queue" 2>/dev/null || echo 0)
    notice_once wiki-review "$workdir" "[qmd] wiki 병합 검토 후보 ${merge_count}건 대기 — 정리하려면 '/wiki-review' 또는 'wiki review 해줘'라고 요청하세요."
    review_agent_file="$(cd "$(dirname "$0")/.." && pwd)/agents/wiki-review-resolver.md"
    if [ -f "$review_agent_file" ]; then
      review_workflow="$(awk '/<!-- WORKFLOW:START -->/{f=1;next}/<!-- WORKFLOW:END -->/{f=0}f' "$review_agent_file")"
      if [ -n "$review_workflow" ]; then
        echo "이것은 사용자 요청과 독립적인 백그라운드 유지보수 작업이다 — 지금 즉시 처리해라. Claude Code는 Agent 도구로 subagent_type 'wiki-review-resolver'를 스폰해서, Codex는 자체 multi-agent delegation으로 아래 프롬프트를 그대로 스폰해 처리해."
        printf '%s\n' "$review_workflow"
      fi
    fi
  else
    notice_clear wiki-review "$workdir"
  fi

  # 소스 소실 표면화(로드맵 3단계): 원장(source-missing.jsonl)의 대기 건수를 1줄 알린다.
  # dedup/merge 힌트와 **같은 notice_once 구조**를 쓰되 모델용 spawn 힌트는 두지 않는다 —
  # 복구(소스 재지정)는 사람이 "이 파일이 그 문서다"를 확인해야 하는 판단이고, 자율
  # 에이전트가 잘못 매칭하면 카드가 무관한 원문을 가리킨 채 verify에서 삭제될 수 있다.
  # 대기 판정("최신 행이 detected")은 Python이 SSOT다(bash에서 재구현하지 않는다).
  # compile 디렉터리가 없으면 원장도 없으므로 python3 호출 자체를 생략한다.
  if [ -d "$workdir/.auto-context/compile" ]; then
    source_missing_json="$(python3 "$(dirname "$0")/wiki_source_missing.py" --cwd "$workdir" --pending-summary 2>/dev/null || true)"
    source_missing_pending="$(printf '%s' "$source_missing_json" | python3 -c 'import json,sys
try:
    print(int(json.load(sys.stdin).get("pending") or 0))
except Exception:
    print(0)' 2>/dev/null || echo 0)"
    source_missing_verified="$(printf '%s' "$source_missing_json" | python3 -c 'import json,sys
try:
    print(int(json.load(sys.stdin).get("verified") or 0))
except Exception:
    print(0)' 2>/dev/null || echo 0)"
    if [ "${source_missing_pending:-0}" -gt 0 ] 2>/dev/null; then
      notice_once source-missing "$workdir" "[qmd] wiki 카드 원문 소실 ${source_missing_pending}건 대기(검수 카드 ${source_missing_verified}건) — 고치려면 '/wiki-source-repair' 또는 '소스 소실 카드 고쳐줘'라고 요청하세요."
    else
      notice_clear source-missing "$workdir"
    fi

    # fail-closed 원장에 쓸 수 없으면 기계 검수가 **아무 카드도 검수하지 못한다**(유료 호출
    # 전 preflight가 멈춘다). 그 상태로 두면 새 카드가 계속 `generated`로 쌓이고
    # `recallVerifiedOnly` 기본값에서 recall에 하나도 나오지 않는데, 흔적은 트림되는
    # verify-log 뿐이라 사용자가 알 방법이 없었다. 판정은 Python이 SSOT다(bash 재구현 금지) —
    # worker의 preflight와 **같은 함수**(preflight_block_reason)를 부르므로 두 판정이 갈릴 수
    # 없다. 사유는 삭제 감사 원장(verify-deleted)과 inconclusive 억제 마커(verify-skipped)로
    # 갈린다.
    ledger_blocked="$(python3 -c 'import sys
sys.path.insert(0, sys.argv[1])
import config as c, wiki_verify_worker as v
found = c.find_project_config(sys.argv[2])
cfg = found["config"]
compile_cfg = cfg.get("compile") if isinstance(cfg.get("compile"), dict) else {}
vcfg = v.verify_cfg_of(compile_cfg)
if not c.compile_active(compile_cfg) or not vcfg.get("enabled", True):
    print("")
else:
    import pathlib
    root = pathlib.Path(found["projectRoot"]).resolve()
    print(v.preflight_block_reason(root, vcfg))
' "$(dirname "$0")" "$workdir" 2>/dev/null || true)"
    case "$ledger_blocked" in
      audit_ledger_unwritable)
        notice_once verify-ledger "$workdir" "[qmd] 기계 검수 중단 — 삭제 감사 원장(.auto-context/compile/verify-deleted.jsonl)에 쓸 수 없습니다. 새 wiki 카드가 검수되지 않아 recall에 나오지 않습니다. compile 디렉터리 권한(.auto-context/compile)을 확인하세요."
        ;;
      suppression_ledger_unwritable)
        notice_once verify-ledger "$workdir" "[qmd] 기계 검수 중단 — 억제 원장(.auto-context/compile/verify-skipped.jsonl)에 쓸 수 없습니다. 이 원장 없이 inconclusive 삭제를 진행하면 같은 소스가 반복 재컴파일되어 유료 호출이 되풀이됩니다. compile 디렉터리 권한(.auto-context/compile)을 확인하세요."
        ;;
      *)
        notice_clear verify-ledger "$workdir"
        ;;
    esac
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

  local discard_ledger="$workdir/.auto-context/compile/discard-ledger.jsonl"
  local discard_cursor="$workdir/.auto-context/compile/.discard-ledger.cursor"
  if [ -s "$discard_ledger" ]; then
    local cur_lines last_lines=0
    cur_lines=$(wc -l < "$discard_ledger" 2>/dev/null || echo 0)
    cur_lines=$((cur_lines + 0))
    if [ -f "$discard_cursor" ]; then
      last_lines=$(cat "$discard_cursor" 2>/dev/null || echo 0)
      last_lines=$((last_lines + 0))
    fi
    if [ "$cur_lines" -lt "$last_lines" ]; then
      last_lines=$cur_lines
      echo "$cur_lines" > "$discard_cursor" 2>/dev/null || true
      notice_clear discard-ledger "$workdir"
    fi
    if [ "$cur_lines" -gt "$last_lines" ]; then
      local marker_path="$(_notice_marker discard-ledger "$workdir")"
      local mtime_before=0
      if [ -f "$marker_path" ]; then
        mtime_before=$(stat -f %m "$marker_path" 2>/dev/null || stat -c %Y "$marker_path" 2>/dev/null || echo 0)
      fi
      notice_once discard-ledger "$workdir" "[qmd] 고아 배치 회수 중 초과 재시도로 폐기된 잡이 있습니다 — 원장(.auto-context/compile/discard-ledger.jsonl)을 확인하세요."
      local mtime_after=0
      if [ -f "$marker_path" ]; then
        mtime_after=$(stat -f %m "$marker_path" 2>/dev/null || stat -c %Y "$marker_path" 2>/dev/null || echo 0)
      fi
      if [ "$mtime_after" -gt "$mtime_before" ]; then
        echo "$cur_lines" > "$discard_cursor" 2>/dev/null || true
      fi
    fi
  else
    rm -f "$discard_cursor" 2>/dev/null || true
    notice_clear discard-ledger "$workdir"
  fi

  # 루트 collectionPath 표면화: collectionPaths가 저장소 루트(".")로 해석되는 컬렉션이
  # 있으면 저장소 전체 Markdown이 색인 대상이 된다. update는 `qmd collection add "$path"`로
  # 디렉터리만 넘기므로(glob·ignore 인수 없음) 색인 범위를 줄이는 유일한 수단이
  # collectionPaths를 좁히는 것이다 — skipPaths/.auto-context-ignore는 recall 결과
  # 필터라 색인을 막지 못한다(docs/settings.md "인덱싱 범위를 줄이는 방법").
  # recommend_config.py는 "."을 추천하지 않지만 수동 설정을 막지는 못한다.
  #
  # 판정은 이미 계산된 $resolved(entries)를 재사용한다 — resolve_paths.py가
  # collectionPaths fnmatch 매칭과 "미지정 → ." 기본값의 SSOT이므로 여기서 재구현하면
  # 갈라진다(특히 collections에만 있고 collectionPaths에 없는 컬렉션도 "."이다).
  #
  # recallStrategy가 wikiOnly면 안내하지 않는다: wikiOnly는 wiki role 컬렉션만
  # 질의하므로 raw가 아무리 넓게 색인돼도 recall 결과에 들어오지 않는다 —
  # "recall 노이즈가 늘어난다"가 사실이 아니고, 컬렉션을 쪼개는 것 말고는 좁힐
  # 수단도 없어(qmd CLI에 pattern/ignore 인수 없음, collectionPaths는 단일 문자열)
  # 실익 없는 조언이 TTL마다 반복된다. hierarchical(raw backfill)·flat(항상 raw)은
  # 실제로 raw를 조회하므로 유지한다. 전략 판정은 이미 로드된 $config_json을
  # normalize_config(SSOT)로 통과시켜 얻고, 스캔 "전"에 종료해 md walk 비용도
  # 지불하지 않는다(동기 SessionStart 경로). 이때 메시지가 비므로 아래 else의
  # notice_clear가 과거 marker를 정리해 전략을 바꾼 프로젝트도 즉시 조용해진다.
  #
  # 작은 저장소에서 "."은 무해하므로 크기 가드를 함께 본다(recommend_config.py의
  # 200파일/5MB와 같은 수준, 대상만 .md로 좁힘). 임계 초과 즉시 스캔을 중단하므로
  # 알림이 뜨는 케이스는 빠르다. 임계에 못 미치는 거대 트리에서 walk가 길어지지
  # 않도록 entry budget 상한을 두고, 소진되면 조용히 포기한다(동기 SessionStart
  # 경로 원칙 — 판정 못 하면 무출력). QMD_SUPPRESS_NOTICE면 스캔 자체를 건너뛴다
  # (notice_clear까지 생략 — 타 호스트 marker를 지우지 않기 위함).
  if [ -z "${QMD_SUPPRESS_NOTICE:-}" ]; then
    root_path_msg=""
    if [ -n "$resolved" ]; then
      # config/resolved는 argv로 전달(heredoc이 stdin을 차지 — stale-queue와 동일 패턴).
      root_path_msg=$(python3 - "$workdir" "$resolved" "$config_json" "$(dirname "$0")" <<'PY' 2>/dev/null || true
import json, os, sys
from pathlib import Path


def recall_strategy(raw, core_dir):
    """이미 로드된 config_json의 recallStrategy를 config.py 기준으로 정규화한다."""
    try:
        parsed = json.loads(raw) if raw else {}
    except Exception:
        parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}
    try:
        sys.path.insert(0, str(Path(core_dir).resolve()))
        import config as qmd_config

        return qmd_config.normalize_config(parsed).get("recallStrategy")
    except Exception:
        # config.py를 못 읽어도 explicit wikiOnly는 존중한다(잘못된 안내 방지).
        return parsed.get("recallStrategy")


def int_env(name, default):
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value > 0 else default


# recommend_config.py의 크기 가드와 같은 수준. env override는 테스트/튜닝용.
MAX_FILES = int_env("QMD_ROOT_PATH_MAX_FILES", 200)
MAX_BYTES = int_env("QMD_ROOT_PATH_MAX_BYTES", 5 * 1024 * 1024)
ENTRY_BUDGET = int_env("QMD_ROOT_PATH_SCAN_BUDGET", 50000)
MD_SUFFIXES = (".md", ".markdown")

STRATEGY = recall_strategy(sys.argv[3] if len(sys.argv) > 3 else "", sys.argv[4] if len(sys.argv) > 4 else ".")
if STRATEGY == "wikiOnly":
    # raw 인덱스 폭이 recall과 무관 → 판정 결과를 쓸 곳이 없으니 스캔도 하지 않는다.
    raise SystemExit(0)

try:
    resolved = json.loads(sys.argv[2])
except Exception:
    resolved = {}
if not isinstance(resolved, dict) or resolved.get("refused"):
    raise SystemExit(0)
# 색인 범위 안내이므로 색인되는 컬렉션만 본다(role `source`는 qmd에 등록되지 않는다).
entries = resolved.get("indexEntries")
if not isinstance(entries, list):
    raise SystemExit(0)

root = Path(sys.argv[1]).resolve()
names = []
for entry in entries:
    if not isinstance(entry, dict):
        continue
    name = entry.get("name")
    rel = entry.get("path")
    if not isinstance(name, str) or not isinstance(rel, str):
        continue
    try:
        candidate = Path(rel).expanduser()
        if not candidate.is_absolute():
            candidate = root / candidate
        if candidate.resolve() == root:
            names.append(name)
    except OSError:
        continue
if not names:
    raise SystemExit(0)

files = 0
total = 0
budget = ENTRY_BUDGET
over = False
# .git만 prune한다(Markdown이 없어 집계에 무의미). node_modules/.worktrees는
# 실제로 색인되는 .md를 담으므로 세는 쪽이 실태에 가깝다.
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d != ".git"]
    budget -= len(dirnames) + len(filenames)
    for filename in filenames:
        if not filename.lower().endswith(MD_SUFFIXES):
            continue
        files += 1
        try:
            total += (Path(dirpath) / filename).stat().st_size
        except OSError:
            pass
        if files > MAX_FILES or total > MAX_BYTES:
            over = True
            break
    if over or budget <= 0:
        break
if not over:
    raise SystemExit(0)

label = ", ".join(repr(n) for n in names)
print(
    f"[qmd] 컬렉션 {label}의 collectionPath가 저장소 루트(.)라 md {files}개 이상이 "
    f"색인 대상입니다 — recallStrategy가 {STRATEGY}라 raw를 조회하므로 recall 노이즈도 "
    "함께 늘어납니다. .auto-context/settings.json의 collectionPaths를 docs 같은 좁은 "
    "경로로 지정하세요(색인 범위를 줄이는 유일한 수단 — docs/settings.md "
    "\"인덱싱 범위를 줄이는 방법\")."
)
PY
)
    fi
    if [ -n "$root_path_msg" ]; then
      notice_once root-collection-path "$workdir" "$root_path_msg"
    else
      notice_clear root-collection-path "$workdir"
    fi
  fi

  # main()이 이미 계산한 STATUS/STATUS_WORKDIR을 worker에 env로 넘겨 재계산을
  # 없앤다(resolve_workdir_meta의 QMD_UPDATE_STATUS+QMD_CANONICAL_WORKDIR 단락).
  QMD_UPDATE_STATUS="$STATUS" QMD_CANONICAL_WORKDIR="$STATUS_WORKDIR" \
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

# scaffold는 **자동 compile이 실제로 채울 수 있는** 타입 디렉터리만 만든다.
# extractors/lib.ALLOWED_TYPES(프롬프트가 모델에게 제시하는 집합)가 그 목록이고
# 현재 concept/entity/decision/comparison 4종이다. `sessions`·`queries`는 그 집합에
# 없어 자동으로는 영영 비어 있었다(라이브 ai-proxy 실측 0건/0건, service-engineering은
# 두 디렉터리가 아예 없이 정상 동작). 미리 만들 이유가 없는 이유는 두 가지다 —
# (1) wiki_compile이 카드를 쓰기 전에 `target.parent.mkdir(parents=True)` 하므로
#     수동 wiki-compile로 session 카드를 쓰면 그때 생긴다(기능은 그대로다),
# (2) 빈 디렉터리는 "여기에 뭔가 쌓여야 하는데 안 쌓인다"로 읽혀 오진을 부른다.
# 즉 여기서 지운 것은 **미리 만드는 것**이지 타입 지원이 아니다 —
# wiki_compile.ALLOWED_TYPES/TYPE_DIRS의 session·query 항목은 그대로 둔다.
# 목록이 프롬프트와 갈리지 않는지는 test/update.test.mjs가 코드에서 유도해 단정한다.
base_dirs = ["concepts", "entities", "decisions", "comparisons"]
novel_dirs = ["characters", "world", "timeline", "plot", "style", "discarded", "decisions", "sessions"]
dir_names = novel_dirs if preset == "novel" else base_dirs
dirs = [wiki] + [wiki / name for name in dir_names]
for path in dirs:
    ensure_project_dir(path, "wiki")

files = {
    wiki / "SCHEMA.md": "# Auto-context Wiki Schema\n\nThis wiki stores promoted, durable project knowledge. Do not paste full transcripts here.\n",
    wiki / "index.md": "# Auto-context Wiki Index\n\n- decisions/\n- concepts/\n- entities/\n- comparisons/\n",
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
# recallStrategy "hierarchical"·wikiPath ".auto-context/wiki"는 DEFAULT_CONFIG 기본값과
# 같으므로 쓰지 않는다(생성기 delta-only). recallStrategy는 예전에 **대입**이라 기존 값을
# 강제로 덮었으므로, 안 쓰는 것만으로는 부족하고 키를 지워야 같은 결과가 된다
# ("키 없음 → 기본값 hierarchical"). wikiPath는 setdefault라 지우면 사용자 커스텀 경로를
# 파괴하므로 **줄만 없앤다**(없으면 기본값, 있으면 그대로).
config.pop("recallStrategy", None)
if preset == "novel":
    compile_config = config.get("compile") if isinstance(config.get("compile"), dict) else {}
    # 기본값과 다른 키만 채운다(생성기 delta-only). 활성화는 `mode` 한 값이 담당한다 —
    # `enabled`·`autoWrite`는 스키마에서 사라졌으므로 쓰면 정규화에서 무시되는 죽은 키다.
    compile_config.setdefault("mode", "auto-wiki")
    # post_session_summary는 host가 compact session summary를 hook에 넘겨줄 때만
    # 자동으로 발화할 수 있고 그런 host가 아직 없다(수동 skills/wiki-compile 경로의
    # 라벨로만 소비된다). 자동 수집을 실제로 담당하는 트리거는 post_tool_source이므로
    # 반드시 포함시킨다 — 없으면 세션 노트를 채워도 카드가 생기지 않는다.
    compile_config.setdefault(
        "triggers", ["post_tool_source", "manual", "explicit_user_approval", "post_session_summary"]
    )
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
import config as qmd_config

target = Path(sys.argv[1]).resolve()
engines = d.parse_engines(sys.argv[3] or None)
root = d.plugin_root()
settings = target / ".auto-context" / "settings.json"
cfg = json.loads(settings.read_text(encoding="utf-8"))

block = d.compile_block(root, engines)
existing = cfg.get("compile") if isinstance(cfg.get("compile"), dict) else {}
# Merge: block wins for the keys it sets (extractor/enabled/mode/...); unrelated existing keys are preserved.
merged = {**existing, **block}
# 생성기가 delta라 "기본값과 같아서 안 쓴 키"는 block에 없다. 그런 키가 기존 설정에
# 비기본값으로 남아 있으면 예전 동작(전체 블록이 덮어써서 기본값으로 리셋)과 갈리므로
# 여기서 지운다 — "키 없음 → 기본값"이 예전의 "기본값을 명시"와 같은 결과다.
for key in d.default_valued_compile_keys(root, engines):
    merged.pop(key, None)
existing_extractor = existing.get("extractor") if isinstance(existing.get("extractor"), dict) else {}
block_extractor = block.get("extractor") if isinstance(block.get("extractor"), dict) else {}
if existing_extractor:
    # Existing extractor config is explicit user/runtime configuration. Keep it ahead
    # of generated portable built-in defaults so --enable-compile stays non-destructive.
    merged["extractor"] = {**block_extractor, **existing_extractor}
trig = existing.get("triggers") if isinstance(existing.get("triggers"), list) else []
merged["triggers"] = list(dict.fromkeys(["post_tool_source", *trig, *block["triggers"]]))
# 스키마에서 사라진 키를 걷어낸다. block(delta)에 없는 키는 기존 파일의 사본이 그대로
# 살아남고, 그러면 도구가 방금 원자적으로 다시 쓴 자기 출력물에 대해 SessionStart가
# deprecated 알림을 4h마다 낸다(자기 잔소리 루프). enabled/autoWrite의 의미는
# compile_config가 이미 mode로 번역했으므로 여기서는 흔적만 지우면 된다.
# **extractor 병합 뒤에 둔다** — 위에서 지우면 existing_extractor 병합이 dispatch/default를
# 되살린다(실측).
def _dig(root_map, dotted, create=False):
    """"compile." 접두를 뗀 dotted 경로의 (부모 dict, 마지막 키). 없으면 (None, key)."""
    parts = dotted.split(".")[1:]
    node = root_map
    for part in parts[:-1]:
        child = node.get(part)
        if not isinstance(child, dict):
            if not create:
                return None, parts[-1]
            child = {}
            node[part] = child
        node = child
    return node, parts[-1]

# 값 읽기는 **원본(existing)** 에서 한다. merged 쪽은 위 default_valued 정리가 verify·batch
# 서브트리를 통째로 지운 뒤라 relocated 값이 이미 사라져 있다(실측: verifyPerRun 15,
# extractorPerRun 4가 조용히 유실됐다).
for record in qmd_config.deprecated_keys({"compile": existing}):
    src, src_key = _dig(existing, record["key"])
    value = src.get(src_key) if src is not None else None
    # 옮겨진 키는 값이 여전히 유효하므로 새 자리로 이식한다. 지우기만 하면 사용자가 적어 둔
    # verify.maxPerRun 15가 조용히 기본값 3으로 떨어진다. 새 키에 이미 값이 있으면 그쪽이
    # 사용자의 최신 의사이므로 덮지 않는다.
    dest = record.get("replacement")
    if dest and value is not None:
        parent, dest_key = _dig(merged, dest, create=True)
        if parent is not None:
            parent.setdefault(dest_key, value)
    # 흔적 제거는 merged에서. enabled/autoWrite의 의미는 compile_config가 이미 mode로
    # 번역했으므로 여기서는 키만 걷어내면 된다.
    dead, dead_key = _dig(merged, record["key"])
    if dead is not None:
        dead.pop(dead_key, None)
cfg["compile"] = merged

fd, tmp = tempfile.mkstemp(dir=str(settings.parent), prefix="settings.", suffix=".tmp")
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    json.dump(cfg, fh, ensure_ascii=False, indent=2); fh.write("\n")
os.replace(tmp, settings)
print(f"[qmd] wiki auto-compile 활성화: {target}")
print(f"      엔진: {', '.join(engines)} (해당 host CLI가 없으면 자동 skip)")
print("      이제 raw/session/source 컬렉션의 .md를 편집하면 백그라운드로 해당 CLI를 실행해")
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
