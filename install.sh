#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

timestamp="$(date +%Y%m%d-%H%M%S)"

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

backup_if_qmd_related() {
  local platform="$1"
  local config="$2"
  local backup="${config}.bak-${timestamp}"

  if [[ -f "$config" ]]; then
    if grep -Eiq 'qmd|wrapper\.py|auto-context' "$config"; then
      say "$platform backup: $config -> $backup"
      [[ "$DRY_RUN" == "1" ]] || cp -p "$config" "$backup"
    else
      say "$platform backup check: $config has no qmd hooks; no .bak needed"
    fi
  else
    say "$platform backup check: no config at $config; .bak backup would be used if qmd hooks existed"
  fi
}

register_hooks() {
  local platform="$1"
  local config="$2"
  local wrapper="$REPO_ROOT/adapters/$platform/wrapper.py"

  say "$platform hook register: python3 $wrapper"
  if [[ "$DRY_RUN" == "1" ]]; then
    return
  fi

  mkdir -p "$(dirname "$config")"
  python3 - "$platform" "$config" "$wrapper" <<'PY'
import json
import os
import sys

platform, config_path, wrapper = sys.argv[1:4]

if os.path.exists(config_path):
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError:
        data = {}
else:
    data = {}

if not isinstance(data, dict):
    data = {}

hooks = data.setdefault("hooks", {})
if not isinstance(hooks, dict):
    hooks = {}
    data["hooks"] = hooks

entries = {
    "claude": [
        ("SessionStart", {"command": f"python3 {wrapper} update"}),
        ("UserPromptSubmit", {"command": f"python3 {wrapper} recall"}),
        ("PostToolUse", {"command": f"python3 {wrapper} posttool"}),
    ],
    "codex": [
        ("session_start", {"command": f"python3 {wrapper} update"}),
        ("user_prompt_submit", {"command": f"python3 {wrapper} recall"}),
        ("post_tool_use", {"command": f"python3 {wrapper} posttool"}),
    ],
    "gemini": [
        ("SessionStart", {"command": f"python3 {wrapper} update"}),
        ("BeforeAgent", {"command": f"python3 {wrapper} recall"}),
        ("AfterTool", {"command": f"python3 {wrapper} posttool", "matcher": "write_file|replace"}),
    ],
}[platform]

needle = f"/adapters/{platform}/wrapper.py"
for hook_name, entry in entries:
    current = hooks.get(hook_name, [])
    if not isinstance(current, list):
        current = []
    current = [
        item for item in current
        if not (isinstance(item, dict) and needle in str(item.get("command", "")))
    ]
    current.append(entry)
    hooks[hook_name] = current

with open(config_path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY
}

install_backend() {
  if command -v qmd >/dev/null 2>&1; then
    say "qmd command found: $(command -v qmd)"
  else
    say "qmd command not found on PATH; backend install will continue"
  fi

  local qmd_config="$HOME/.config/qmd"
  local launch_agents="$HOME/Library/LaunchAgents"
  local script
  local dest

  for script in daemon.sh keepalive.sh logrotate.sh; do
    dest="$qmd_config/$script"
    if [[ "$DRY_RUN" == "1" ]]; then
      say "backend copy plan: $REPO_ROOT/backend/$script -> $dest"
    else
      mkdir -p "$qmd_config"
      if [[ ! -f "$dest" ]] || ! cmp -s "$REPO_ROOT/backend/$script" "$dest"; then
        cp "$REPO_ROOT/backend/$script" "$dest"
      fi
    fi
  done

  local plist
  for plist in "$REPO_ROOT"/backend/launchd/*.plist; do
    local name
    name="$(basename "$plist")"
    dest="$launch_agents/$name"
    if [[ "$DRY_RUN" == "1" ]]; then
      say "launchd plist plan: replace @@HOME@@ with $HOME in $plist -> $dest"
      say "launchctl load plan: $dest (skip if already loaded)"
    else
      mkdir -p "$launch_agents"
      local tmp
      tmp="$(mktemp)"
      python3 - "$plist" "$tmp" "$HOME" <<'PY'
import sys
src, dest, home = sys.argv[1:4]
with open(src, "r", encoding="utf-8") as f:
    content = f.read().replace("@@HOME@@", home)
with open(dest, "w", encoding="utf-8") as f:
    f.write(content)
PY
      if [[ ! -f "$dest" ]] || ! cmp -s "$tmp" "$dest"; then
        cp "$tmp" "$dest"
      fi
      rm -f "$tmp"

      label="${name%.plist}"
      if command -v launchctl >/dev/null 2>&1; then
        if launchctl list "$label" >/dev/null 2>&1; then
          say "launchctl load skip: $label already loaded"
        else
          launchctl load "$dest"
        fi
      else
        say "launchctl not found; skip load for $dest"
      fi
    fi
  done
}

migrate_collection_paths() {
  local scan_root="${QMD_MIGRATE_SCAN:-$HOME/work/novel}"
  say "collectionPaths 마이그레이션 scan: $scan_root"
  python3 - "$scan_root" "$DRY_RUN" <<'PY'
import json
import os
import sys

scan_root, dry_run = sys.argv[1], sys.argv[2] == "1"
prefix = "[DRY-RUN] " if dry_run else ""
suffix_map = {
    "-manuscript": "04_Manuscript",
    "-plot": "03_Plot",
    "-settings": "01_Settings",
    "-sessions": ".nova/06_Sessions",
}

if not os.path.isdir(scan_root):
    print(f"{prefix}collectionPaths 마이그레이션: scan root not found, skip")
    sys.exit(0)

changed = 0
for root, _, files in os.walk(scan_root):
    if "qmd-recall.json" not in files or os.path.basename(root) != ".agents":
        continue
    path = os.path.join(root, "qmd-recall.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:
        print(f"{prefix}collectionPaths migrate skip invalid JSON: {path}: {exc}")
        continue
    if "collectionPaths" in data:
        continue
    collections = data.get("collections", [])
    if not isinstance(collections, list):
        collections = []
    collection_paths = {}
    for collection in collections:
        if not isinstance(collection, str):
            continue
        for suffix, target in suffix_map.items():
            if collection.endswith(suffix):
                collection_paths[collection] = target
                break
    if not collection_paths:
        continue
    changed += 1
    print(f"{prefix}collectionPaths 마이그레이션 계획: {path} -> {collection_paths}")
    if not dry_run:
        data["collectionPaths"] = collection_paths
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")

if changed == 0:
    print(f"{prefix}collectionPaths 마이그레이션: no changes needed")
PY
}

for platform in "${platforms[@]}"; do
  [[ -z "$platform" ]] && continue
  case "$platform" in
    claude|codex|gemini)
      config="$(config_path_for "$platform")"
      backup_if_qmd_related "$platform" "$config"
      register_hooks "$platform" "$config"
      ;;
    *)
      say "unknown platform skip: $platform"
      ;;
  esac
done

install_backend
migrate_collection_paths

if [[ "$DRY_RUN" != "1" ]]; then
  (cd "$REPO_ROOT" && npm test)
fi
