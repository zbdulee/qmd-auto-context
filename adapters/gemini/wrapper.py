#!/usr/bin/env python3
import sys
import os
import json
import subprocess
from pathlib import Path

def command_mentions_qmd_recall(value):
    if isinstance(value, dict):
        command = value.get("command")
        if isinstance(command, str):
            lowered = command.lower()
            if "qmd" in lowered and "recall" in lowered:
                return True
        return any(command_mentions_qmd_recall(v) for v in value.values())
    if isinstance(value, list):
        return any(command_mentions_qmd_recall(item) for item in value)
    return False

def should_yield_to_local_recall(raw_input):
    try:
        payload = json.loads(raw_input)
    except (json.JSONDecodeError, ValueError):
        return False
    cwd = payload.get("cwd") if isinstance(payload, dict) else None
    if not isinstance(cwd, str) or not cwd:
        return False

    for filename in ("settings.json", "hooks.json"):
        hook_file = Path(cwd) / ".gemini" / filename
        try:
            with open(hook_file, "r", encoding="utf-8") as handle:
                settings = json.load(handle)
        except (OSError, json.JSONDecodeError, ValueError):
            continue

        hooks = settings.get("hooks", {}) if isinstance(settings, dict) else {}
        if not isinstance(hooks, dict):
            continue
        if command_mentions_qmd_recall(hooks.get("BeforeAgent")) or command_mentions_qmd_recall(hooks.get("UserPromptSubmit")):
            return True
    return False

def main():
    # If GEMINI_SANDBOX is set or --sandbox option is in sys.argv, exit immediately with no output
    if os.environ.get("GEMINI_SANDBOX") or "--sandbox" in sys.argv:
        return 0

    if len(sys.argv) < 2:
        sys.stderr.write("Usage: wrapper.py <recall|update|posttool>\n")
        return 1

    action = sys.argv[1]
    raw_input = sys.stdin.read()
    
    # Resolve core scripts
    base_dir = Path(__file__).parent.parent.parent.resolve()
    core_dir = base_dir / "core"
    
    if action == "recall":
        if should_yield_to_local_recall(raw_input):
            return 0
        script_path = core_dir / "recall.py"
        cmd = ["python3", str(script_path)]
    elif action == "update":
        script_path = core_dir / "update.sh"
        cmd = ["bash", str(script_path)]
    elif action == "posttool":
        script_path = core_dir / "posttool.py"
        cmd = ["python3", str(script_path)]
    else:
        sys.stderr.write(f"Unknown action: {action}\n")
        return 1

    # Prepare environment variables
    env = os.environ.copy()
    env["QMD_RECALL_LOG"] = env.get("QMD_RECALL_LOG", "/tmp/gemini-qmd-hook.log")
    env["QMD_ENGINE"] = "gemini"

    # Pass stdin, stdout, stderr directly through to the core script
    try:
        proc = subprocess.run(
            cmd,
            input=raw_input,
            capture_output=True,
            text=True,
            env=env
        )
        sys.stdout.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        return proc.returncode
    except subprocess.SubprocessError as e:
        sys.stderr.write(f"Adapter error: {e}\n")
        return 1

if __name__ == "__main__":
    sys.exit(main())
