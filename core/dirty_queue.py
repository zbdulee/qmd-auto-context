#!/usr/bin/env python3
import fcntl
import os
from pathlib import Path


def queue_path():
    return Path(os.environ.get(
        "QMD_DIRTY_QUEUE",
        str(Path.home() / ".config" / "qmd" / "dirty-queue"),
    ))


def enqueue_collections(selected):
    if not selected:
        return
    q = queue_path()
    q.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"{name}\t{selected[name]}\n"
        for name in sorted(selected)
    ]
    with open(q, "a", encoding="utf-8") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        f.writelines(lines)
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)
