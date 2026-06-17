#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi
MANAGED_MARKER="managed-by: qmd-auto-context"

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
  latest="$(ls -t "$config".bak-* 2>/dev/null | grep -v '\.bak-original$' | head -n 1 || true)"
  printf '%s\n' "$latest"
}

restore_backup() {
  local platform="$1"
  local config="$2"
  local original="${config}.bak-original"
  local latest

  if [[ -f "$original" ]]; then
    say "$platform restore 복원 original backup: $original -> $config"
    if [[ "$DRY_RUN" != "1" ]]; then
      cp -p "$original" "$config" || {
        say "$platform restore failed: $original -> $config"
        return 1
      }
    fi
    return 0
  fi

  latest="$(latest_backup_for "$config")"
  if [[ -n "$latest" ]]; then
    say "$platform restore 복원: $latest -> $config"
    if [[ "$DRY_RUN" != "1" ]]; then
      cp -p "$latest" "$config" || {
        say "$platform restore failed: $latest -> $config"
        return 1
      }
    fi
    return 0
  fi

  say "$platform restore 복원: no .bak restore candidate"
  return 1
}

remove_adapter_hooks() {
  local platform="$1"
  local config="$2"

  if restore_backup "$platform" "$config"; then
    say "$platform remove 제거 adapter hooks skip: restored backup"
    return
  fi
  say "$platform remove 제거 adapter hooks from $config"
  if [[ "$DRY_RUN" == "1" || ! -f "$config" ]]; then
    return
  fi

  python3 - "$platform" "$config" <<'PY'
import json
import os
import sys

platform, config_path = sys.argv[1:3]

try:
    with open(config_path, "r", encoding="utf-8") as f:
        data = json.load(f)
except json.JSONDecodeError as exc:
    print(f"invalid JSON in {config_path}: {exc}", file=sys.stderr)
    sys.exit(0)

if not isinstance(data, dict):
    sys.exit(0)

hooks = data.get("hooks")
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
for hook_name in list(hooks):
    current = hooks.get(hook_name)
    if not isinstance(current, list):
        continue
    filtered = [
        it for it in current
        if not (isinstance(it, dict)
                and (is_legacy_qmd_entry(it) or is_auto_context_adapter_entry(it)))
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

uninstall_backend() {
  local launch_agents="$HOME/Library/LaunchAgents"
  local qmd_config="$HOME/.config/qmd"
  local label
  local plist
  local script

  for label in com.qmd-mcp-daemon com.qmd-keepalive com.qmd-logrotate; do
    plist="$launch_agents/$label.plist"
    if [[ "$DRY_RUN" == "1" ]]; then
      say "backend launchctl unload plan: $plist ($label)"
      say "backend remove launchd plist plan if managed: $plist"
    else
      if [[ -f "$plist" ]] && has_managed_marker "$plist"; then
        if command -v launchctl >/dev/null 2>&1; then
          launchctl unload "$plist" >/dev/null 2>&1 || launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
        fi
        rm -f "$plist"
      fi
    fi
  done

  for script in daemon.sh keepalive.sh logrotate.sh; do
    local path="$qmd_config/$script"
    if [[ "$DRY_RUN" == "1" ]]; then
      say "backend remove .config/qmd script plan if managed: $path"
    else
      if has_managed_marker "$path"; then
        rm -f "$path"
      fi
    fi
  done
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

uninstall_backend
