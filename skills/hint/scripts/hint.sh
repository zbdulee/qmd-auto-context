#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
TARGET_CWD="${1:-$PWD}"
if [ "$#" -gt 0 ]; then shift; fi
FILE_PATH="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi
CONTENT="$*"

if [ -z "$FILE_PATH" ]; then
  echo "usage: hint.sh <cwd> <file-path> [content]" >&2
  exit 2
fi

if [ -n "$CONTENT" ]; then
  payload="$(python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"PostToolUse","cwd":sys.argv[1],"tool_input":{"file_path":sys.argv[2],"content":sys.argv[3]}}, ensure_ascii=False))' "$TARGET_CWD" "$FILE_PATH" "$CONTENT")"
elif [ -f "$FILE_PATH" ]; then
  payload="$(python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"PostToolUse","cwd":sys.argv[1],"tool_input":{"file_path":sys.argv[2],"content":sys.stdin.read()}}, ensure_ascii=False))' "$TARGET_CWD" "$FILE_PATH" < "$FILE_PATH")"
else
  payload="$(python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"PostToolUse","cwd":sys.argv[1],"tool_input":{"file_path":sys.argv[2],"content":""}}, ensure_ascii=False))' "$TARGET_CWD" "$FILE_PATH")"
fi

printf '%s' "$payload" | python3 "$PLUGIN_ROOT/core/posttool.py"
