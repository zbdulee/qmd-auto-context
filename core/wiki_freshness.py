#!/usr/bin/env python3
"""Current-source revision snapshots and fail-closed wiki freshness checks.

``sourceHash`` identifies a generated card.  It is deliberately not the source
content hash, so this module owns the separate source-revision comparison used
by the compile worker and recall guard.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import compile_paths as cp
import yaml_scalars

FRESH = "fresh"
STALE = "stale"
UNKNOWN = "unknown"
PENDING_REFRESH = "pending_refresh"
RESOLVED = "resolved"
PENDING_COMPACT_BYTES = 256 * 1024


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _pending_path(root: Path) -> Path | None:
    return cp.ledger(Path(root).resolve(), cp.SOURCE_REFRESH_PENDING)


def _pending_lock_path(path: Path) -> Path:
    return path.with_name(f"{path.name}.lock")


def _safe_source_path(value) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        return None
    normalized = path.as_posix()
    return normalized if normalized not in ("", ".") else None


def _pending_key(row: dict) -> tuple[str, str, str] | None:
    source = _safe_source_path(row.get("sourcePath"))
    ts = row.get("ts")
    engine = row.get("engine")
    if source is None or not isinstance(ts, str) or not ts or not isinstance(engine, str) or not engine:
        return None
    return source, ts, engine


def _resolved_key(row: dict) -> tuple[str, str, str] | None:
    source = _safe_source_path(row.get("sourcePath"))
    ts = row.get("pendingTs")
    engine = row.get("pendingEngine")
    if source is None or not isinstance(ts, str) or not ts or not isinstance(engine, str) or not engine:
        return None
    return source, ts, engine


def _valid_event(row) -> bool:
    if not isinstance(row, dict):
        return False
    if row.get("state") == PENDING_REFRESH:
        return _pending_key(row) is not None
    if row.get("state") == RESOLVED:
        return (
            _resolved_key(row) is not None
            and isinstance(row.get("ts"), str)
            and yaml_scalars.normalize_source_revision(row.get("sourceRevision")) is not None
        )
    return False


def _read_events_unlocked(path: Path, strict: bool = False) -> list[dict] | None:
    if not path.exists():
        return []
    try:
        text = path.read_text(encoding="utf-8", errors="strict")
    except (OSError, UnicodeError):
        return None if strict else []
    rows = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            if strict:
                return None
            continue
        if not _valid_event(row):
            if strict:
                return None
            continue
        rows.append(row)
    return rows


def _append_event_unlocked(path: Path, event: dict) -> bool:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    except OSError:
        return False
    return True


def record_pending_refresh(root: Path, source_path: str, engine: str) -> dict | None:
    """Durably invalidate one source before its separate queue append."""
    source = _safe_source_path(source_path)
    path = _pending_path(root)
    if source is None or path is None:
        return None
    event = {
        "ts": _now_iso(),
        "sourcePath": source,
        "state": PENDING_REFRESH,
        "engine": engine if isinstance(engine, str) and engine.strip() else "unknown",
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with _pending_lock_path(path).open("a", encoding="utf-8") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            if not _append_event_unlocked(path, event):
                return None
    except OSError:
        return None
    compact_pending_refreshes(root)
    return event


def read_pending_refreshes(root: Path) -> list[dict]:
    path = _pending_path(root)
    if path is None:
        return []
    rows = _read_events_unlocked(path)
    return rows if rows is not None else []


def unresolved_pending_refreshes(root: Path) -> list[dict]:
    """Return the latest unresolved pending event for each source."""
    latest: dict[str, dict] = {}
    resolved: set[tuple[str, str, str]] = set()
    for row in read_pending_refreshes(root):
        if row.get("state") == PENDING_REFRESH:
            key = _pending_key(row)
            if key is not None:
                latest[key[0]] = row
        elif row.get("state") == RESOLVED:
            key = _resolved_key(row)
            if key is not None:
                resolved.add(key)
    return [row for row in latest.values() if _pending_key(row) not in resolved]


def same_revision(left, right) -> bool:
    left_norm = yaml_scalars.normalize_source_revision(left)
    right_norm = yaml_scalars.normalize_source_revision(right)
    return left_norm is not None and left_norm == right_norm


def resolve_pending_refresh(
    root: Path, pending: dict, captured_revision: dict, compiled_revisions: list[dict]
) -> bool:
    """Resolve only the latest event with the captured bytes the writer returned."""
    pending_key = _pending_key(pending) if isinstance(pending, dict) else None
    captured = yaml_scalars.normalize_source_revision(captured_revision)
    compiled = [yaml_scalars.normalize_source_revision(item) for item in compiled_revisions]
    path = _pending_path(root)
    if (
        pending_key is None or captured is None or path is None
        or captured.get("path") != pending_key[0]
        or any(item is None for item in compiled)
        or captured not in compiled
    ):
        return False
    root = Path(root).resolve()
    source = (root / pending_key[0]).resolve()
    try:
        source.relative_to(root)
    except ValueError:
        return False
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with _pending_lock_path(path).open("a", encoding="utf-8") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            rows = _read_events_unlocked(path, strict=True)
            if rows is None:
                return False
            latest = None
            resolved = set()
            for row in rows:
                if row.get("state") == PENDING_REFRESH and row.get("sourcePath") == pending_key[0]:
                    latest = row
                elif row.get("state") == RESOLVED:
                    key = _resolved_key(row)
                    if key is not None:
                        resolved.add(key)
            if latest is None or _pending_key(latest) != pending_key or pending_key in resolved:
                return False
            current = snapshot_file(source)
            if current is None or current["sha256"] != captured["sha256"]:
                return False
            event = {
                "ts": _now_iso(),
                "sourcePath": pending_key[0],
                "state": RESOLVED,
                "pendingTs": pending_key[1],
                "pendingEngine": pending_key[2],
                "sourceRevision": captured,
            }
            if not _append_event_unlocked(path, event):
                return False
    except OSError:
        return False
    compact_pending_refreshes(root)
    return True


def compact_pending_refreshes(root: Path, force: bool = False) -> bool:
    """Atomically retain each source's latest pending event and resolved pair."""
    path = _pending_path(root)
    if path is None or not path.exists():
        return False
    try:
        if not force and path.stat().st_size < PENDING_COMPACT_BYTES:
            return True
        with _pending_lock_path(path).open("a", encoding="utf-8") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            rows = _read_events_unlocked(path, strict=True)
            if rows is None:
                return False
            latest: dict[str, tuple[int, dict]] = {}
            resolved: dict[tuple[str, str, str], tuple[int, dict]] = {}
            for index, row in enumerate(rows):
                if row.get("state") == PENDING_REFRESH:
                    key = _pending_key(row)
                    if key is not None:
                        latest[key[0]] = (index, row)
                else:
                    key = _resolved_key(row)
                    if key is not None:
                        resolved[key] = (index, row)
            kept: list[tuple[int, dict]] = []
            for pending_item in latest.values():
                kept.append(pending_item)
                pair = resolved.get(_pending_key(pending_item[1]))
                if pair is not None and pair[0] > pending_item[0]:
                    kept.append(pair)
            kept.sort(key=lambda item: item[0])
            tmp = path.with_suffix(path.suffix + ".compact.tmp")
            with tmp.open("w", encoding="utf-8") as handle:
                for _index, row in kept:
                    handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, path)
            try:
                dir_fd = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(dir_fd)
                finally:
                    os.close(dir_fd)
            except OSError:
                pass
    except OSError:
        return False
    return True


def snapshot_bytes(path: Path) -> tuple[dict, bytes] | None:
    """Read one stable file image as ``(revision, bytes)`` or return ``None``.

    The two fstats are deliberately on the same opened descriptor.  Callers
    that need bounded source text must use these returned bytes, not re-open
    the path after receiving the revision.
    """
    try:
        with path.open("rb") as handle:
            before = os.fstat(handle.fileno())
            data = handle.read()
            after = os.fstat(handle.fileno())
    except OSError:
        return None
    if (before.st_ino, before.st_size, before.st_mtime_ns) != (
        after.st_ino, after.st_size, after.st_mtime_ns,
    ):
        return None
    return {
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": after.st_size,
        "mtimeNs": after.st_mtime_ns,
    }, data


def snapshot_file(path: Path) -> dict | None:
    """Return a stable source revision without retaining source bytes."""
    snapshot = snapshot_bytes(path)
    return snapshot[0] if snapshot is not None else None


def compare_revision(path: Path, expected: dict) -> tuple[str, str]:
    """Compare a previously captured source revision with a safe resolved path.

    Path containment is intentionally not duplicated here.  ``check_card``
    first asks ``recall.resolve_existing_source`` for the project's shared
    allow-root decision, then passes its resolved result here.
    """
    if yaml_scalars.normalize_source_revision(expected) is None:
        return UNKNOWN, "invalid_source_revision"
    snapshot = snapshot_file(path)
    if snapshot is None:
        return UNKNOWN, "source_snapshot_failed"
    if snapshot["sha256"] != expected["sha256"]:
        return STALE, "content_hash_mismatch"
    return FRESH, ""


def _source_revisions(card: dict) -> tuple[list[dict] | None, str]:
    if not isinstance(card, dict):
        return None, "invalid_card"
    raw = card.get("sourceRevisions")
    if not isinstance(raw, list) or not raw:
        return None, "missing_source_revisions"
    revisions = []
    for entry in raw:
        if isinstance(entry, dict):
            revision = yaml_scalars.normalize_source_revision(entry)
        elif isinstance(entry, str):
            revision = yaml_scalars.parse_source_revision(entry)
        else:
            revision = None
        if revision is None:
            return None, "invalid_source_revision"
        revisions.append(revision)
    return revisions, ""


def check_card(card: dict, project_root: Path, allow_roots: list[Path]) -> dict:
    """Return the current freshness state for compiler-owned card provenance.

    ``unknown`` never authorizes recall: provenance problems, allow-root
    rejection, and read/stat/hash failures are all fail-closed.  A genuinely
    absent source is distinguishable and stale, so diagnostics can route it to
    the existing missing-source workflow.
    """
    revisions, problem = _source_revisions(card)
    if revisions is None:
        return {"state": UNKNOWN, "reason": problem}

    # Import lazily so recall can later import this module without a module-load
    # cycle.  This remains the one source containment decision for all users.
    import recall

    for expected in revisions:
        resolved, reason = recall.resolve_existing_source(
            expected["path"], project_root, allow_roots)
        if resolved is None:
            state = STALE if reason == "missing" else UNKNOWN
            return {"state": state, "reason": reason or "source_unavailable"}
        state, reason = compare_revision(resolved, expected)
        if state != FRESH:
            return {"state": state, "reason": reason}
    return {"state": FRESH, "checked": len(revisions)}
