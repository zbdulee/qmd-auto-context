#!/usr/bin/env python3
import sys
import os
import json
import fcntl
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
import posttool
from collection_match import select_collections


def queue_path():
    return Path(os.environ.get("QMD_DIRTY_QUEUE",
                               str(Path.home() / ".config" / "qmd" / "dirty-queue")))


def enqueue(selected):
    q = queue_path()
    q.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"{name}\t{path}\n" for name, path in selected.items()]
    # flock은 fd가 필요하므로 open 후 획득이 정상(advisory lock). open(a) 자체의
    # O_APPEND write는 POSIX atomic이라 동시 append도 줄이 섞이지 않으며, flock은
    # writelines 다중 라인 묶음의 원자성을 advisory로 보강한다.
    with open(q, "a", encoding="utf-8") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        f.writelines(lines)
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)


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
    sys.exit(main())
