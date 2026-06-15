#!/usr/bin/env python3
import sys
import os
import subprocess
from pathlib import Path

def main():
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: wrapper.py <recall|update|posttool>\n")
        return 1

    action = sys.argv[1]
    
    # Resolve core scripts
    base_dir = Path(__file__).parent.parent.parent.resolve()
    core_dir = base_dir / "core"
    
    if action == "recall":
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
    env["QMD_RECALL_LOG"] = env.get("QMD_RECALL_LOG", "/tmp/codex-qmd-hook.log")
    env["QMD_ENGINE"] = "codex"

    # Pass stdin, stdout, stderr directly through to the core script
    try:
        proc = subprocess.run(
            cmd,
            input=sys.stdin.read(),
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
