#!/usr/bin/env python3
"""Current-source revision snapshots and fail-closed wiki freshness checks.

``sourceHash`` identifies a generated card.  It is deliberately not the source
content hash, so this module owns the separate source-revision comparison used
by the compile worker and recall guard.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import yaml_scalars

FRESH = "fresh"
STALE = "stale"
UNKNOWN = "unknown"


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
