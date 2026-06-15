#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

say() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[DRY-RUN] %s\n' "$*"
  else
    printf '%s\n' "$*"
  fi
}

platforms=()
if [[ -n "${QMD_FAKE_PLATFORMS:-}" ]]; then
  IFS=',' read -r -a platforms <<< "$QMD_FAKE_PLATFORMS"
else
  [[ -d "$HOME/.claude" ]] && platforms+=("claude")
  [[ -d "$HOME/.codex" ]] && platforms+=("codex")
  [[ -d "$HOME/.gemini" ]] && platforms+=("gemini")
fi

config_path_for() {
  case "$1" in
    claude) printf '%s/.claude/settings.json\n' "$HOME" ;;
    codex) printf '%s/.codex/hooks.json\n' "$HOME" ;;
    gemini) printf '%s/.gemini/settings.json\n' "$HOME" ;;
    *) return 1 ;;
  esac
}

latest_backup_for() {
  local config="$1"
  local latest=""
  latest="$(ls -t "$config".bak-* 2>/dev/null | head -n 1 || true)"
  printf '%s\n' "$latest"
}

remove_adapter_hooks() {
  local platform="$1"
  local config="$2"
  local latest
  latest="$(latest_backup_for "$config")"

  if [[ -n "$latest" ]]; then
    say "$platform restore 복원: $latest -> $config; remove 제거 adapter hooks via .bak"
    [[ "$DRY_RUN" == "1" ]] || cp -p "$latest" "$config"
    return
  fi

  say "$platform remove 제거 adapter hooks from $config; no .bak restore 복원 candidate"
  if [[ "$DRY_RUN" == "1" || ! -f "$config" ]]; then
    return
  fi

  python3 - "$platform" "$config" <<'PY'
import json
import os
import sys

platform, config_path = sys.argv[1:3]
with open(config_path, "r", encoding="utf-8") as f:
    try:
        data = json.load(f)
    except json.JSONDecodeError:
        sys.exit(0)

hooks = data.get("hooks")
if not isinstance(hooks, dict):
    sys.exit(0)

needle = f"/adapters/{platform}/wrapper.py"
for hook_name in list(hooks):
    current = hooks.get(hook_name)
    if not isinstance(current, list):
        continue
    filtered = [
        item for item in current
        if not (isinstance(item, dict) and needle in str(item.get("command", "")))
    ]
    if filtered:
        hooks[hook_name] = filtered
    else:
        del hooks[hook_name]

with open(config_path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY
}

for platform in "${platforms[@]}"; do
  [[ -z "$platform" ]] && continue
  case "$platform" in
    claude|codex|gemini)
      remove_adapter_hooks "$platform" "$(config_path_for "$platform")"
      ;;
    *)
      say "unknown platform skip: $platform"
      ;;
  esac
done
