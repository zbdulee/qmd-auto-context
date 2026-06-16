#!/usr/bin/env python3
import sys
import os
import json
import re
import subprocess
from pathlib import Path

# Add current directory to path to import core sibling modules
sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config

MAX_TEXT_CHARS = 1600

def normalize_path(path_str: str, cwd: str) -> str:
    if not path_str:
        return ""
    p = Path(path_str)
    try:
        if p.is_absolute():
            return p.resolve().relative_to(Path(cwd).resolve()).as_posix()
    except (OSError, ValueError):
        pass
    normalized = path_str.replace("\\", "/")
    if normalized.startswith("./"):
        return normalized[2:]
    return normalized

def is_story_path(path_str: str, cwd: str, config: dict) -> bool:
    normalized = normalize_path(path_str, cwd)
    
    col_paths = config.get("collectionPaths", {})
    if not isinstance(col_paths, dict) or not col_paths:
        return False

    story_dirs = []
    for val in col_paths.values():
        if isinstance(val, str):
            val_clean = val.strip("/")
            if val_clean and val_clean not in story_dirs:
                story_dirs.append(val_clean)
                
    for d in story_dirs:
        if normalized == d or normalized.startswith(d + "/"):
            return True
    return False

def paths_from_patch(patch: str) -> list[str]:
    paths = []
    for line in patch.splitlines():
        match = re.match(r"\*\*\* (?:Update|Add|Delete) File: (.+)", line)
        if match:
            paths.append(match.group(1).strip())
    return paths

def added_text_from_patch(patch: str) -> str:
    lines = []
    for line in patch.splitlines():
        if not line.startswith("+") or line.startswith("+++"):
            continue
        text = line[1:].strip()
        if text:
            lines.append(text)
    return "\n".join(lines)

def extract_text(payload: dict) -> str:
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return ""

    chunks = []
    for key in ("content", "new_string", "command"):
        value = tool_input.get(key)
        if isinstance(value, str):
            chunks.append(value)

    patch = tool_input.get("patch")
    if isinstance(patch, str):
        chunks.append(added_text_from_patch(patch))

    edits = tool_input.get("edits")
    if isinstance(edits, list):
        for edit in edits:
            if isinstance(edit, dict):
                value = edit.get("new_string") or edit.get("content")
                if isinstance(value, str):
                    chunks.append(value)

    text = "\n".join(chunk for chunk in chunks if chunk.strip())
    return text[:MAX_TEXT_CHARS]

def story_paths_touched(payload: dict, cwd: str, config: dict) -> bool:
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return False

    paths = []
    for key in ("file_path", "path"):
        value = tool_input.get(key)
        if isinstance(value, str):
            paths.append(value)

    patch = tool_input.get("patch")
    if isinstance(patch, str):
        paths.extend(paths_from_patch(patch))

    edits = tool_input.get("edits")
    if isinstance(edits, list):
        for edit in edits:
            if isinstance(edit, dict):
                value = edit.get("file_path") or edit.get("path")
                if isinstance(value, str):
                    paths.append(value)

    return any(is_story_path(p, cwd, config) for p in paths)

def main():
    # If QMD_SANDBOX is set or --sandbox option is in sys.argv, exit immediately with no output
    if os.environ.get("QMD_SANDBOX") or "--sandbox" in sys.argv:
        return 0

    raw = sys.stdin.read().strip()
    if not raw:
        return 0
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return 0

    event_name = payload.get("hook_event_name")
    if event_name not in (None, "PostToolUse", "AfterTool"):
        return 0

    cwd = payload.get("cwd") or os.getcwd()
    
    # Load config to get collection paths
    # Same logic as recall.py
    path = Path(cwd).resolve()
    config_file = None
    target = path / ".agents" / "qmd-recall.json"
    if target.exists():
        config_file = target
    else:
        for parent in path.parents:
            target = parent / ".agents" / "qmd-recall.json"
            if target.exists():
                config_file = target
                break
                
    if config_file:
        try:
            with open(config_file, "r", encoding="utf-8") as f:
                config = qmd_config.normalize_config(json.load(f))
        except (json.JSONDecodeError, OSError):
            config = qmd_config.normalize_config({})
    else:
        config = qmd_config.normalize_config({})

    if not qmd_config.event_enabled(config, "postToolUse"):
        return 0

    if not story_paths_touched(payload, cwd, config):
        return 0

    text = extract_text(payload)
    if len(text.strip()) < 10:
        return 0

    # Delegate recall query to core/recall.py
    recall_script = str(Path(__file__).parent / "recall.py")
    recall_input = {
        "prompt": text,
        "cwd": cwd
    }
    
    # Pass along external environment variables (QMD_QUERY_FIXTURE, QMD_DAEMON_URL, PATH for mock CLI etc.)
    env = os.environ.copy()
    env["QMD_ENGINE"] = env.get("QMD_ENGINE", "posttool")
    
    try:
        proc = subprocess.run(
            ["python3", recall_script],
            input=json.dumps(recall_input),
            capture_output=True,
            text=True,
            env=env
        )
        
        # If recall succeeded and output something, print it
        output = proc.stdout.strip()
        if output:
            # Format event name to PostToolUse
            try:
                parsed = json.loads(output)
                if "hookSpecificOutput" in parsed:
                    parsed["hookSpecificOutput"]["hookEventName"] = "PostToolUse"
                    print(json.dumps(parsed, ensure_ascii=False))
            except json.JSONDecodeError:
                pass
    except subprocess.SubprocessError:
        pass
        
    return 0

if __name__ == "__main__":
    sys.exit(main())
