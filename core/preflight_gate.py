#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import config as qmd_config
import resolve_paths as rp

GATED_TOOLS = {"Edit", "Write", "apply_patch", "MultiEdit"}


def is_sandbox():
    return bool(os.environ.get("QMD_SANDBOX") or os.environ.get("GEMINI_SANDBOX")
                or os.environ.get("CODEX_SANDBOX") or os.environ.get("CLAUDE_HEADLESS") == "1")


def has_skip_marker(cwd, payload):
    """Task 7에서 실제 구현. 이 Task에서는 항상 False 반환(stub)."""
    return False


def main():
    if is_sandbox():
        return 0
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return 0
    tool = payload.get("tool_name", "")
    if tool not in GATED_TOOLS:
        return 0  # Read/Bash 등은 차단 안 함 (matcher가 1차 필터, 여기 2차 방어)
    cwd = payload.get("cwd") or os.getcwd()
    config = qmd_config.load_project_config(cwd)
    result = rp.resolve_paths(cwd, json.dumps(config))
    reason = result.get("reason")
    # pending이 아니면(동의/거절/risky/정상) 통과. pending이어도 skip이면 통과.
    if reason != "pending":
        return 0
    if has_skip_marker(cwd, payload):   # Task 7에서 구현
        return 0
    hint = " (collections가 비어 pending입니다)" if not config.get("collections") else ""
    msg = (f"⛔ qmd-auto-context: 이 프로젝트는 인덱싱 미설정(pending){hint}이라 편집이 보류됩니다. "
           f"사용자에게 묻고 'update.sh --recommend {cwd}'로 추천 확인 후 "
           f"--optin --recommended (또는 --optin/--optout/--skip)를 실행하세요. Read·검색은 허용됩니다.")
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": msg,
    }}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
