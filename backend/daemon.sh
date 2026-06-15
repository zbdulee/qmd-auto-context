#!/bin/bash
# qmd HTTP MCP 데몬 런처 (LaunchAgent에서 foreground 실행).
#
# 배경: 홈 node_modules의 better-sqlite3 네이티브 모듈은 특정 Node ABI(MODULE_VERSION)로만
# 빌드돼 있어, 맞지 않는 node로 qmd를 실행하면 `ERR_DLOPEN_FAILED`로 즉사한다.
# fnm 설치 node 버전이 여러 개이고 default alias가 어디를 가리킬지 보장되지 않으므로,
# 버전을 하드코딩하지 않고(=CLAUDE.md 원칙) 후보 node들로 better-sqlite3 native load를 probe 하여
# ABI가 맞는 첫 node를 런타임에 선택한다.
#
# foreground(`mcp --http`, --daemon 아님)로 실행해야 launchd KeepAlive가 프로세스를 추적/재기동한다.
set -euo pipefail

export PATH="$HOME/.bun/bin:$PATH"
QMD_BIN="$(command -v qmd || echo "$HOME/.bun/bin/qmd")"
PORT="${QMD_DAEMON_PORT:-8483}"
FNM_ROOT="$HOME/.local/share/fnm/node-versions"

# qmd 의 bin/qmd 런처는 dist/cli/qmd.js 를 child 로 spawn 한다(2단 프로세스).
# 그러면 launchd KeepAlive 가 런처(직속 자식)만 감시하고 실제 서버(손자)가 죽어도 복구를 보장 못 한다.
# 런처를 따라가 dist/cli/qmd.js 를 직접 exec 하여 single 프로세스로 만든다(launchd 가 서버를 직접 감시).
QMD_REAL="$(realpath "$QMD_BIN" 2>/dev/null || readlink -f "$QMD_BIN" 2>/dev/null || echo "$QMD_BIN")"
QMD_ENTRY="$(dirname "$(dirname "$QMD_REAL")")/dist/cli/qmd.js"
if [ ! -f "$QMD_ENTRY" ]; then
  # dist 진입점을 못 찾으면 런처로 폴백하는데, 이러면 런처가 child 를 spawn 해 2단 프로세스가 되어
  # launchd KeepAlive 가 실제 서버를 감시 못 한다. 조용히 넘어가지 않고 경고를 남긴다.
  echo "[qmd-daemon] WARN: dist/cli/qmd.js 없음($QMD_ENTRY). 런처로 폴백 — 2단 프로세스가 되어 KeepAlive 신뢰성 저하." >&2
  QMD_ENTRY="$QMD_BIN"
fi

# qmd bin/qmd 런처는 MCP 모드에서 native quiet/Metal env 를 세팅한다(dist/cli/qmd.js 직접 실행 시 누락됨).
# 이 누락은 단순 로그 노이즈가 아니라 실제 vec 쿼리 성능 저하(GGML_METAL_NO_RESIDENCY 미설정 등)를 유발하므로
# 런처와 동일하게 복제한다. (참조: bin/qmd 의 `if (process.argv[2] === "mcp")` 블록)
export LLAMA_LOG_LEVEL="${LLAMA_LOG_LEVEL:-error}"
export GGML_LOG_LEVEL="${GGML_LOG_LEVEL:-error}"
export GGML_BACKEND_SILENT="${GGML_BACKEND_SILENT:-1}"
if [ "$(uname)" = "Darwin" ] && [ "${QMD_METAL_KEEP_RESIDENCY:-}" != "1" ]; then
  export GGML_METAL_NO_RESIDENCY="${GGML_METAL_NO_RESIDENCY:-1}"
fi

pick_compatible_node_bin() {
  # better-sqlite3 네이티브 모듈이 이 node ABI로 dlopen 되는지만 검증한다(ABI 전용 probe).
  # qmd status 는 DB/cache/config 문제로도 실패할 수 있어 ABI 판별용으로는 취약하므로 쓰지 않는다.
  local bin
  for bin in $(ls -d "$FNM_ROOT"/v*/installation/bin 2>/dev/null | sort -rV); do
    if ( cd "$HOME" && PATH="$bin:$PATH" node -e "require('better-sqlite3')" ) >/dev/null 2>&1; then
      echo "$bin"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(pick_compatible_node_bin || true)"
if [ -n "$NODE_BIN" ]; then
  export PATH="$NODE_BIN:$PATH"
  echo "[qmd-daemon] ABI 호환 node 선택: $NODE_BIN" >&2
else
  # ABI 호환 node를 못 찾으면 데몬은 어차피 ERR_DLOPEN_FAILED 로 즉사한다. 명확히 실패시킨다.
  echo "[qmd-daemon] FATAL: better-sqlite3 ABI 호환 node를 fnm($FNM_ROOT)에서 찾지 못함. 데몬을 띄우지 않음." >&2
  exit 1
fi

# KeepAlive LaunchAgent 의 직접 자식이므로 stdout/stderr 는 plist StandardOutPath 로 간다.
echo "[qmd-daemon] starting: node=$(command -v node) entry=$QMD_ENTRY port=$PORT" >&2
exec node "$QMD_ENTRY" mcp --http --port "$PORT"
