#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN=0
MANAGED_MARKER="managed-by: qmd-auto-context"

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

has_managed_marker() {
  local file="$1"
  [[ -f "$file" ]] && grep -q "$MANAGED_MARKER" "$file"
}

platforms=()
if [[ -n "${QMD_FAKE_PLATFORMS:-}" ]]; then
  IFS=',' read -r -a platforms <<< "$QMD_FAKE_PLATFORMS"
else
  [[ -d "$HOME/.claude" ]] && platforms+=("claude")
  [[ -d "${CODEX_HOME:-$HOME/.codex}" ]] && platforms+=("codex")
  [[ -d "$HOME/.gemini" ]] && platforms+=("gemini")
fi

config_path_for() {
  case "$1" in
    claude) printf '%s/.claude/settings.json\n' "$HOME" ;;
    codex) printf '%s/hooks.json\n' "${CODEX_HOME:-$HOME/.codex}" ;;
    gemini) printf '%s/.gemini/settings.json\n' "$HOME" ;;
    *) return 1 ;;
  esac
}

cleanup_hook_file() {
  local platform="$1"
  local config_path="$2"

  [[ -f "$config_path" ]] || return 0
  say "$platform legacy hook cleanup: $config_path"
  [[ "$DRY_RUN" == "1" ]] && return 0

  python3 - "$platform" "$config_path" <<'PY'
import json
import os
import sys

platform, config_path = sys.argv[1], sys.argv[2]

try:
    with open(config_path, "r", encoding="utf-8") as f:
        data = json.load(f)
except json.JSONDecodeError as exc:
    print(f"invalid JSON in {config_path}: {exc}", file=sys.stderr)
    sys.exit(1)

if not isinstance(data, dict):
    sys.exit(0)

hooks = data.get("hooks", {})
if not isinstance(hooks, dict):
    sys.exit(0)

needle = f"/adapters/{platform}/wrapper.py"

def command_strings(value):
    if isinstance(value, dict):
        command = value.get("command")
        if isinstance(command, str):
            yield command
        for item in value.values():
            yield from command_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from command_strings(item)

def is_legacy_qmd_entry(item):
    return any(
        "qmd" in command.lower() and "auto-context" not in command.lower()
        for command in command_strings(item)
    )

def is_auto_context_adapter_entry(item):
    return any(needle in command for command in command_strings(item))

changed = False
for hook_name, current in list(hooks.items()):
    if not isinstance(current, list):
        continue
    filtered = [
        item for item in current
        if not (
            isinstance(item, dict)
            and (is_legacy_qmd_entry(item) or is_auto_context_adapter_entry(item))
        )
    ]
    if len(filtered) != len(current):
        changed = True
    if filtered:
        hooks[hook_name] = filtered
    else:
        del hooks[hook_name]

if not changed:
    sys.exit(0)

tmp_path = config_path + ".tmp"
with open(tmp_path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
os.replace(tmp_path, config_path)
PY
}

cleanup_platform() {
  local platform="$1"
  local codex_home="${CODEX_HOME:-$HOME/.codex}"
  local paths_to_clean=()

  case "$platform" in
    claude)
      paths_to_clean=("$(config_path_for "$platform")")
      ;;
    codex)
      paths_to_clean=("$codex_home/hooks.json")
      if [[ -f "$codex_home/config.toml" ]] && grep -q '^\[hooks\]' "$codex_home/config.toml" 2>/dev/null; then
        say "WARNING: $codex_home/config.toml has inline [hooks]; check manually."
      fi
      for profile_toml in "$codex_home"/*.config.toml; do
        [[ -f "$profile_toml" ]] && grep -q '^\[hooks\]' "$profile_toml" 2>/dev/null \
          && say "WARNING: profile config with [hooks]: $profile_toml; check manually."
      done
      if [[ -f "$PWD/.codex/hooks.json" ]] || ([[ -f "$PWD/.codex/config.toml" ]] && grep -q '^\[hooks\]' "$PWD/.codex/config.toml" 2>/dev/null); then
        say "WARNING: repo-local .codex hook config found at $PWD/.codex; check manually."
      fi
      ;;
    gemini)
      paths_to_clean=(
        "$HOME/.gemini/settings.json"
        "$HOME/.gemini/antigravity-cli/settings.json"
      )
      ;;
    *)
      say "unknown platform skip: $platform"
      return 0
      ;;
  esac

  local target_config
  for target_config in "${paths_to_clean[@]}"; do
    cleanup_hook_file "$platform" "$target_config"
  done
}

cleanup_backend() {
  local launch_agents="$HOME/Library/LaunchAgents"
  local qmd_config="$HOME/.config/qmd"
  local label plist script path

  for label in com.qmd-mcp-daemon com.qmd-keepalive com.qmd-logrotate com.qmd-index-worker; do
    plist="$launch_agents/$label.plist"
    if [[ "$DRY_RUN" == "1" ]]; then
      say "legacy backend cleanup plan if managed: $plist"
    elif has_managed_marker "$plist"; then
      if command -v launchctl >/dev/null 2>&1; then
        launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || launchctl unload "$plist" >/dev/null 2>&1 || true
      fi
      rm -f "$plist"
      say "removed legacy LaunchAgent: $plist"
    fi
  done

  for script in daemon.sh keepalive.sh logrotate.sh index_worker.sh; do
    path="$qmd_config/$script"
    if [[ "$DRY_RUN" == "1" ]]; then
      say "legacy backend cleanup plan if managed: $path"
    elif has_managed_marker "$path"; then
      rm -f "$path"
      say "removed legacy backend script: $path"
    fi
  done
}

for platform in "${platforms[@]}"; do
  [[ -z "$platform" || "$platform" == "none" ]] && continue
  cleanup_platform "$platform"
done

cleanup_backend

if [[ -x "$REPO_ROOT/core/backend_manager.sh" && "$DRY_RUN" != "1" ]]; then
  "$REPO_ROOT/core/backend_manager.sh" cleanup-legacy >/dev/null 2>&1 || true
fi
