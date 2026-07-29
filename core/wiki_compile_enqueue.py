#!/usr/bin/env python3
"""Enqueue source markdown files for automatic wiki compile.

This hook-side command is intentionally silent. It records source metadata only;
it never stores source content or calls an extractor/LLM.
"""

import json
import fcntl
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
import posttool
from collection_match import select_collections


DEFAULT_ENGINE = "unknown"

# compile source가 절대 될 수 없는 segment. `.auto-context`는 이 플러그인의 관리 영역
# (wiki 카드·큐·로그)이라 소스로 승격하면 카드가 자기 자신을 재컴파일해 증식한다.
# 나머지는 collectionPaths에 등록될 일이 거의 없지만 방어적으로 막는다.
DENIED_SOURCE_SEGMENTS = frozenset({".auto-context", ".git", ".hg", ".svn", "node_modules"})


def _utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _is_hidden_source_path(rel_path: str) -> bool:
    return any(part.startswith(".") for part in Path(rel_path).parts)


def _is_denied_source_path(rel_path: str) -> bool:
    return any(part in DENIED_SOURCE_SEGMENTS for part in Path(rel_path).parts)


def _engine(payload):
    value = payload.get("engine") or os.environ.get("QMD_ENGINE") or DEFAULT_ENGINE
    return value if isinstance(value, str) and value.strip() else DEFAULT_ENGINE


def _safe_queue_path(project_root, configured_path):
    if not isinstance(configured_path, str) or not configured_path:
        configured_path = ".auto-context/compile/source-queue.jsonl"
    rel = Path(configured_path)
    if rel.is_absolute() or ".." in rel.parts:
        return None
    if len(rel.parts) < 3 or rel.parts[0] != ".auto-context" or rel.parts[1] != "compile":
        return None
    root = Path(project_root).resolve()
    target = root / rel
    current = root
    for part in rel.parts[:-1]:
        current = current / part
        if current.exists() and current.is_symlink():
            return None
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        resolved_parent = target.parent.resolve()
        resolved_parent.relative_to(root)
    except (OSError, ValueError):
        return None
    if target.exists() and target.is_symlink():
        return None
    return target


def _queue_lock_path(path):
    return path.with_name(f"{path.name}.lock")


def _append_jsonl(path, records):
    if not records:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = _queue_lock_path(path)
    with open(lock_path, "a", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            with open(path, "a", encoding="utf-8") as handle:
                for record in records:
                    handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _source_record(path_value, cwd, project_root, config, engine):
    source_path = Path(path_value)
    abs_path = source_path if source_path.is_absolute() else Path(cwd) / source_path
    try:
        resolved = abs_path.resolve()
    except OSError:
        return None
    if resolved.suffix.lower() != ".md":
        return None
    selected = select_collections([str(resolved)], project_root, config)
    if not selected:
        return None
    # select_collections returns at most one collection for one edited path.
    collection = next(iter(selected.keys()))
    roles = config.get("collectionRoles") if isinstance(config.get("collectionRoles"), dict) else {}
    role = roles.get(collection, "raw")
    if role not in ("raw", "session"):
        return None
    try:
        rel_path = resolved.relative_to(Path(project_root).resolve()).as_posix()
    except ValueError:
        return None
    if _is_denied_source_path(rel_path):
        return None
    # dot-prefix 정책은 유지하되 적용 범위를 "등록된 collection 루트 아래"로 좁힌다.
    # 루트 자체의 dot segment(예: `.nova/06_Sessions`)는 사용자가 collectionPaths에
    # 직접 적어 넣은 소스라 면제하고, 그 아래에서 새로 나타나는 dot segment
    # (`.claude`, `docs/.draft`, `.hidden.md`)는 그대로 배제한다.
    # 이 좁히기가 완화를 자동으로 봉쇄한다: collectionPaths가 `.`이면 면제되는
    # 접두부가 비어 있어 rel_path 전체가 여전히 dot 검사를 받는다.
    try:
        inner_rel = resolved.relative_to(Path(selected[collection]).resolve()).as_posix()
    except (OSError, ValueError):
        inner_rel = rel_path
    if _is_hidden_source_path(inner_rel):
        return None
    return {
        "ts": _utc_now(),
        "trigger": "post_tool_source",
        "engine": engine,
        "cwd": str(Path(project_root).resolve()),
        "source": {
            "kind": "file",
            "path": rel_path,
            "collection": collection,
        },
    }


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
    found = qmd_config.find_project_config(cwd)
    config = found["config"]
    project_root = found["projectRoot"]
    if config.get("indexing") is not True:
        return 0
    if not config.get("collections"):
        return 0
    if not qmd_config.event_enabled(config, "postToolUse"):
        return 0
    compile_cfg = config.get("compile") if isinstance(config.get("compile"), dict) else {}
    if not compile_cfg.get("enabled") or compile_cfg.get("mode", "off") == "off":
        return 0
    raw_triggers = compile_cfg.get("triggers")
    triggers = raw_triggers if isinstance(raw_triggers, list) else []
    if "post_tool_source" not in triggers:
        return 0

    queue_path = _safe_queue_path(project_root, compile_cfg.get("sourceQueuePath"))
    if queue_path is None:
        return 0

    records = []
    seen = set()
    for edited_path in posttool.edited_paths(payload):
        if not isinstance(edited_path, str):
            continue
        record = _source_record(edited_path, cwd, project_root, config, _engine(payload))
        if record is None:
            continue
        key = (record["cwd"], record["source"]["path"], record["source"]["collection"])
        if key in seen:
            continue
        seen.add(key)
        records.append(record)
    _append_jsonl(queue_path, records)
    return 0


if __name__ == "__main__":
    import hook_main
    sys.exit(hook_main.run(main))
