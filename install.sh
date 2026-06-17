#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN=0
MIGRATE_ONLY=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
elif [[ "${1:-}" == "--migrate-only" ]]; then
  MIGRATE_ONLY=1
elif [[ "${1:-}" == "--agy-local" ]]; then
  target="${2:-$PWD}"
  python3 "$REPO_ROOT/core/agy_local_install.py" "$target" "$REPO_ROOT"
  exit 0
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
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

backup_unmanaged_if_needed() {
  local dest="$1"
  if [[ ! -f "$dest" ]] || has_managed_marker "$dest"; then
    return 0
  fi

  local backup="${dest}.bak-${timestamp}"
  local n=1
  while [[ -e "$backup" ]]; do
    backup="${dest}.bak-${timestamp}-${n}"
    n=$((n + 1))
  done
  say "backend unmanaged backup: $dest -> $backup"
  [[ "$DRY_RUN" == "1" ]] || cp -p "$dest" "$backup"
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

backup_if_qmd_related() {
  local platform="$1"
  local config="$2"
  local backup="${config}.bak-original"

  if [[ -f "$config" ]]; then
    if [[ -f "$backup" ]]; then
      say "$platform original backup exists: $backup"
    else
      say "$platform original backup: $config -> $backup"
      [[ "$DRY_RUN" == "1" ]] || cp -p "$config" "$backup"
    fi
  else
    say "$platform original backup check: no config at $config"
  fi
}

cleanup_legacy_global_hooks() {
  local platform="$1"
  local config="$2"

  say "$platform legacy hook cleanup: $config"
  if [[ "$DRY_RUN" == "1" ]]; then
    return
  fi

  # codex: CODEX_HOME 기반 경로 계산
  local codex_home="${CODEX_HOME:-$HOME/.codex}"

  # 정리 대상 경로 목록 (platform별)
  local paths_to_clean=()
  if [[ "$platform" == "gemini" ]]; then
    paths_to_clean=(
      "$HOME/.gemini/settings.json"
      "$HOME/.gemini/antigravity-cli/settings.json"
    )
  elif [[ "$platform" == "codex" ]]; then
    paths_to_clean=(
      "$codex_home/hooks.json"
    )
    # codex config.toml inline [hooks] 경고 출력 (자동 편집 안 함 — repo-local/profile도 동일)
    local config_toml="$codex_home/config.toml"
    if [[ -f "$config_toml" ]] && grep -q '^\[hooks\]' "$config_toml" 2>/dev/null; then
      say "WARNING: $config_toml 에 inline [hooks] 섹션 발견. managed marker 있으면 수동 확인 필요."
    fi
    # profile *.config.toml 경고
    for profile_toml in "$codex_home"/*.config.toml; do
      [[ -f "$profile_toml" ]] && grep -q '^\[hooks\]' "$profile_toml" 2>/dev/null \
        && say "WARNING: profile config with [hooks]: $profile_toml — 수동 확인 필요."
    done
    # repo-local .codex/ 경고
    if [[ -f "$PWD/.codex/hooks.json" ]] || ([[ -f "$PWD/.codex/config.toml" ]] && grep -q '^\[hooks\]' "$PWD/.codex/config.toml" 2>/dev/null); then
      say "WARNING: repo-local .codex/ hook 설정 발견 ($PWD/.codex) — 자동 편집 안 함, 수동 확인 필요."
    fi
  else
    paths_to_clean=("$config")
  fi

  for target_config in "${paths_to_clean[@]}"; do
    [[ -f "$target_config" ]] || continue
    python3 - "$platform" "$target_config" <<'PY'
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
    print(f"skip: {config_path} is not a JSON object", file=sys.stderr)
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
  done
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

  for script in daemon.sh keepalive.sh logrotate.sh index_worker.sh; do
    dest="$qmd_config/$script"
    if [[ "$DRY_RUN" == "1" ]]; then
      say "backend copy plan: $REPO_ROOT/backend/$script -> $dest"
      backup_unmanaged_if_needed "$dest"
    else
      mkdir -p "$qmd_config"
      backup_unmanaged_if_needed "$dest"
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
      say "launchctl load plan: $dest (reload if already loaded and changed)"
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
      local changed=0
      backup_unmanaged_if_needed "$dest"
      if [[ ! -f "$dest" ]] || ! cmp -s "$tmp" "$dest"; then
        cp "$tmp" "$dest"
        changed=1
      fi
      rm -f "$tmp"

      label="${name%.plist}"
      if command -v launchctl >/dev/null 2>&1; then
        if launchctl list "$label" >/dev/null 2>&1; then
          if [[ "$changed" == "1" ]]; then
            say "launchctl reload: $label plist changed"
            launchctl unload "$dest" >/dev/null 2>&1 || true
            launchctl load "$dest"
          else
            say "launchctl load skip: $label already loaded"
          fi
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
import shutil
from datetime import datetime

scan_root, dry_run = sys.argv[1], sys.argv[2] == "1"
prefix = "[DRY-RUN] " if dry_run else ""
timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
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
        backup_path = f"{path}.bak-{timestamp}"
        n = 1
        while os.path.exists(backup_path):
            backup_path = f"{path}.bak-{timestamp}-{n}"
            n += 1
        shutil.copy2(path, backup_path)
        data["collectionPaths"] = collection_paths
        tmp_path = path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp_path, path)

if changed == 0:
    print(f"{prefix}collectionPaths 마이그레이션: no changes needed")
PY
}

migrate_legacy_to_auto_context() {
  local scan_root="${QMD_MIGRATE_SCAN:-$HOME/work/novel}"
  say "레거시 → .auto-context.json 마이그레이션 scan: $scan_root"
  python3 - "$scan_root" "$DRY_RUN" <<'PY'
import json, os, sys, tempfile, shutil, glob
scan_root, dry = sys.argv[1], sys.argv[2] == "1"
prefix = "[DRY-RUN] " if dry else ""
if not os.path.isdir(scan_root):
    print(f"{prefix}.auto-context 마이그레이션: scan root 없음, skip"); sys.exit(0)
migrated = 0
for root, _, files in os.walk(scan_root):
    if os.path.basename(root) != ".agents" or "qmd-recall.json" not in files:
        continue
    legacy = os.path.join(root, "qmd-recall.json")
    proj = os.path.dirname(root)                 # .agents의 부모 = 프로젝트 루트
    dest = os.path.join(proj, ".auto-context.json")
    if os.path.exists(dest):                     # 이미 마이그레이션됨 → 멱등 skip
        continue
    try:
        data = json.load(open(legacy, encoding="utf-8"))
        if not isinstance(data, dict):
            continue
    except Exception:
        continue
    data.setdefault("indexing", True)
    if dry:
        print(f"{prefix}migrate: {legacy} -> {dest}"); migrated += 1; continue
    fd, tmp = tempfile.mkstemp(dir=proj, prefix=".auto-context.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, dest)
    except BaseException:
        try: os.unlink(tmp)
        except OSError: pass
        raise
    # 레거시 제거. collectionPaths 마이그레이션이 이미 .bak-*(원본)를 남겼으면 중복 백업하지 않는다.
    if glob.glob(legacy + ".bak-*"):
        os.remove(legacy)
    else:
        shutil.move(legacy, legacy + ".bak-migrated")
    print(f"migrated: {legacy} -> {dest}")
    migrated += 1
if migrated == 0:
    print(f"{prefix}.auto-context 마이그레이션: 대상 없음")
PY
}

if [[ "$MIGRATE_ONLY" == "1" ]]; then
  if [[ "${QMD_CLEANUP_ONLY:-}" == "1" ]]; then
    # 백엔드/마이그레이션 없이 레거시 글로벌 hook 정리만 수행
    for platform in "${platforms[@]}"; do
      [[ -z "$platform" ]] && continue
      case "$platform" in
        claude|codex|gemini)
          config="$(config_path_for "$platform")"
          cleanup_legacy_global_hooks "$platform" "$config"
          ;;
        *)
          say "unknown platform skip: $platform"
          ;;
      esac
    done
    exit 0
  fi
  migrate_collection_paths
  migrate_legacy_to_auto_context
  exit 0
fi

for platform in "${platforms[@]}"; do
  [[ -z "$platform" ]] && continue
  case "$platform" in
    claude|codex|gemini)
      config="$(config_path_for "$platform")"
      backup_if_qmd_related "$platform" "$config"
      cleanup_legacy_global_hooks "$platform" "$config"
      ;;
    *)
      say "unknown platform skip: $platform"
      ;;
  esac
done

if [[ "${QMD_INSTALL_SKIP_BACKEND:-}" == "1" ]]; then
  say "backend install skip: QMD_INSTALL_SKIP_BACKEND=1"
else
  install_backend
fi
migrate_collection_paths
migrate_legacy_to_auto_context

if [[ "${QMD_INSTALL_SKIP_SELFTEST:-}" == "1" ]]; then
  say "self-test skip: QMD_INSTALL_SKIP_SELFTEST=1"
elif [[ "$DRY_RUN" != "1" ]]; then
  (cd "$REPO_ROOT" && npm test)
fi
