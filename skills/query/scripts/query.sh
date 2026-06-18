#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
TARGET_CWD="${1:-$PWD}"
QUERY_TEXT="${2:-}"

if [ "$#" -gt 0 ]; then shift; fi
if [ "$#" -gt 0 ]; then shift; fi
if [ -z "$QUERY_TEXT" ]; then
  QUERY_TEXT="$(cat)"
fi

payload="$(python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"UserPromptSubmit","prompt":sys.argv[2],"cwd":sys.argv[1]}, ensure_ascii=False))' "$TARGET_CWD" "$QUERY_TEXT")"
printf '%s' "$payload" | python3 "$PLUGIN_ROOT/core/recall.py"
