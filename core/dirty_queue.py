#!/usr/bin/env python3
import fcntl
import os
from pathlib import Path


def queue_path():
    return Path(os.environ.get(
        "QMD_DIRTY_QUEUE",
        str(Path.home() / ".config" / "qmd" / "dirty-queue"),
    ))


def enqueue_collections(selected, *, project_root=None):
    if not selected:
        return
    q = queue_path()
    q.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"{name}\t{selected[name]}" + (f"\t{project_root}" if project_root else "") + "\n"
        for name in sorted(selected)
    ]
    with open(q, "a", encoding="utf-8") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        f.writelines(lines)
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)


def enqueue_project_collections(project_root, selected):
    """Retain selected-index ownership even for external collection roots."""
    if not selected:
        return
    import qmd_route
    root = Path(project_root).resolve()
    route = qmd_route.project_paths(root)
    enqueue_collections(selected, project_root=str(root) if route['selected'] else None)
