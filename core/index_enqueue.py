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
    # dirty 큐는 **인덱싱 큐**다. role `source`는 qmd에 등록되지 않으므로 넣으면
    # index_worker가 `collection add`로 도로 등록해 role을 무력화한다 — 즉 여기서
    # 거르지 않으면 update.sh의 unregister와 매 편집마다 싸운다.
    # collection_match 자체는 필터하지 않는다(compile enqueue가 같은 매핑을 쓰고
    # 거기서는 source가 정상 입력이다). 필터는 소비자별로 여기 한 줄이다.
    roles = qmd_config.role_map(config)
    selected = {
        name: path for name, path in selected.items()
        if qmd_config.is_indexed_collection(roles, name)
    }
    if not selected:
        return 0
    enqueue(selected)
    return 0


if __name__ == "__main__":
    import hook_main
    sys.exit(hook_main.run(main))
