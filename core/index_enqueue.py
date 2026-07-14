#!/usr/bin/env python3
import sys
import os
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
import dirty_queue
import posttool
from collection_match import select_collections


def queue_path():
    return dirty_queue.queue_path()


def enqueue(selected):
    dirty_queue.enqueue_collections(selected)


def main():
    if os.environ.get("QMD_SANDBOX") or "--sandbox" in sys.argv:
        return 0
    raw = sys.stdin.read().strip()
    if not raw:
        return 0
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return 0
    if payload.get("hook_event_name") not in (None, "PostToolUse", "AfterTool"):
        return 0
    cwd = payload.get("cwd") or os.getcwd()
    config = qmd_config.load_project_config(cwd)
    if not config.get("collections"):
        return 0
    if not qmd_config.event_enabled(config, "postToolUse"):
        return 0
    selected = select_collections(posttool.edited_paths(payload), cwd, config)
    if not selected:
        return 0
    enqueue(selected)
    return 0


if __name__ == "__main__":
    import hook_main
    sys.exit(hook_main.run(main))
