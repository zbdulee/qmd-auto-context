#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
TARGET_CWD="${1:-$PWD}"
FILE_PATH="${2:-}"
CONTENT="${3:-}"

if [ -z "$FILE_PATH" ]; then
  echo "usage: hint.sh <cwd> <file-path> [content]" >&2
  exit 2
fi
if [ -z "$CONTENT" ] && [ -f "$FILE_PATH" ]; then
  CONTENT="$(cat "$FILE_PATH")"
fi

payload="$(python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"PostToolUse","cwd":sys.argv[1],"tool_input":{"file_path":sys.argv[2],"content":sys.argv[3]}}, ensure_ascii=False))' "$TARGET_CWD" "$FILE_PATH" "$CONTENT")"
printf '%s' "$payload" | python3 "$PLUGIN_ROOT/core/posttool.py"
