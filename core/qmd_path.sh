#!/usr/bin/env bash
# Shared qmd CLI path resolution for non-interactive hook environments.

qmd_candidate_dirs() {
  [ -n "${QMD_BIN:-}" ] && dirname "$QMD_BIN"

  [ -n "${HOME:-}" ] || return 0
  for dir in \
    "$HOME/.bun/bin" \
    "$HOME/.local/bin" \
    "$HOME/.npm-global/bin" \
    "$HOME/.volta/bin" \
    "/opt/homebrew/bin" \
    "/usr/local/bin"
  do
    [ -d "$dir" ] && printf '%s\n' "$dir"
  done

  python3 - "$HOME/.local/share/fnm/node-versions" "$HOME/.nvm/versions/node" <<'PY' 2>/dev/null || true
import re
import sys
from pathlib import Path

for root_arg in sys.argv[1:]:
    root = Path(root_arg)
    candidates = []
    for path in root.glob("v*/installation/bin") if root_arg.endswith("node-versions") else root.glob("v*/bin"):
        version_dir = path.parent.parent if root_arg.endswith("node-versions") else path.parent
        match = re.match(r"^v(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$", version_dir.name)
        if match:
            candidates.append((tuple(int(x) for x in match.groups()), path))
    for _, path in sorted(candidates, reverse=True):
        print(path)
PY
}

normalize_qmd_path() {
  local prefix="" dir
  while IFS= read -r dir; do
    [ -n "$dir" ] && [ -d "$dir" ] || continue
    case ":$prefix:" in
      *":$dir:"*) continue ;;
    esac
    if [ -z "$prefix" ]; then
      prefix="$dir"
    else
      prefix="$prefix:$dir"
    fi
  done < <(qmd_candidate_dirs)

  [ -n "$prefix" ] && PATH="$prefix:$PATH"
  export PATH
}

resolve_qmd_bin() {
  if [ -n "${QMD_BIN:-}" ]; then
    [ -x "$QMD_BIN" ] || return 1
    printf '%s\n' "$QMD_BIN"
    return 0
  fi

  normalize_qmd_path
  command -v qmd
}
