#!/usr/bin/env python3
"""One-shot offline migration from legacy human-review wiki metadata.

This is release maintenance, never a SessionStart scan.  It keeps foreign
cards byte-for-byte, serializes with live card writers, and never creates a
verification job.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import compile_paths as cp
import config as qmd_config
import recall as qmd_recall
import wiki_compile as wc

LEGACY_TRUST_STATUSES = {"reviewed", "canon", "manual"}
EXCLUDED_STATUS_GUARDS = {"superseded", "contested", "discarded"}


@dataclass(frozen=True)
class MigrationReport:
    scanned: int
    changed_cards: int
    foreign_card_retained: int
    unchanged_cards: int
    write_failures: int
    audit_rows: int
    audit_write_failed: bool


def _audit_keys(text: str) -> set[tuple[str, str]]:
    keys: set[tuple[str, str]] = set()
    for line in text.splitlines():
        try:
            row = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(row, dict):
            continue
        path = row.get("path")
        action = row.get("action")
        if isinstance(path, str) and isinstance(action, str):
            keys.add((path, action))
    return keys


def _rewrite_qmd_card(text: str) -> tuple[str | None, str]:
    match = wc.FRONTMATTER_RE.match(text)
    if match is None:
        return None, "foreign_card_retained"
    meta, ok = wc.parse_frontmatter(text)
    sections = wc._frontmatter_sections(match.group(1))
    if not ok or sections is None or meta.get("createdBy") != "qmd-auto-context":
        return None, "foreign_card_retained"

    status = str(meta.get("status") or "").strip().lower()
    revisions = qmd_recall.frontmatter_source_revisions(match.group(1))
    normalize = (
        status in LEGACY_TRUST_STATUSES
        or (status not in EXCLUDED_STATUS_GUARDS and not revisions)
    )
    proof_fields = set(qmd_config.VERIFY_PROOF_FIELDS)
    rewritten: list[str] = []
    saw_status = False
    for key, lines in sections:
        if key == "reviewed":
            continue
        if normalize and key in proof_fields:
            continue
        if key == "status":
            saw_status = True
            rewritten.extend(["status: generated"] if normalize else lines)
            continue
        rewritten.extend(lines)
    if normalize and not saw_status:
        rewritten.append("status: generated")

    updated = "---\n" + "\n".join(rewritten) + "\n---\n" + text[match.end():]
    if updated == text:
        return text, "unchanged"
    return updated, "normalized_generated" if normalize else "reviewed_removed"


def _append_audit_atomic(path: Path, original: str, rows: list[dict]) -> bool:
    if not rows:
        return True
    prefix = original
    if prefix and not prefix.endswith("\n"):
        prefix += "\n"
    addition = "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows)
    return wc.write_text_atomic(path, prefix + addition)


def migrate_reviewed_state(root: Path) -> MigrationReport:
    """Normalize legacy qmd cards under ``wikiPath`` while holding CARD_WRITE_LOCK."""
    found = qmd_config.find_project_config(str(Path(root).resolve()))
    project_root = Path(found["projectRoot"]).resolve()
    config = found["config"]
    wiki_root = (project_root / config.get("wikiPath", ".auto-context/wiki")).resolve()
    try:
        wiki_root.relative_to(project_root)
    except ValueError as exc:
        raise ValueError("unsafe wikiPath") from exc
    if wiki_root.exists() and (wiki_root.is_symlink() or not wiki_root.is_dir()):
        raise ValueError("unsafe wikiPath")

    scanned = changed = foreign = unchanged = failures = 0
    new_audit_rows: list[dict] = []
    audit_failed = False
    with cp.card_write_lock(project_root):
        audit_path = cp.ledger(project_root, cp.REVIEWED_MIGRATION)
        if audit_path is None:
            raise ValueError("unsafe migration audit path")
        try:
            audit_text = audit_path.read_text(encoding="utf-8") if audit_path.exists() else ""
        except OSError:
            audit_text = ""
        audited = _audit_keys(audit_text)

        pages = sorted(wiki_root.rglob("*.md")) if wiki_root.is_dir() else []
        for page in pages:
            if page.parent == wiki_root and page.name in {"index.md", "log.md"}:
                continue
            scanned += 1
            rel = page.relative_to(project_root).as_posix()
            try:
                original = page.read_text(encoding="utf-8")
            except (OSError, UnicodeError):
                action = "foreign_card_retained"
                foreign += 1
                if (rel, action) not in audited:
                    new_audit_rows.append({"path": rel, "action": action})
                    audited.add((rel, action))
                continue
            updated, action = _rewrite_qmd_card(original)
            if action == "foreign_card_retained":
                foreign += 1
                if (rel, action) not in audited:
                    new_audit_rows.append({"path": rel, "action": action})
                    audited.add((rel, action))
                continue
            if action == "unchanged" or updated is None:
                unchanged += 1
                continue
            if not wc.write_text_atomic(page, updated):
                failures += 1
                continue
            changed += 1
            if (rel, action) not in audited:
                new_audit_rows.append({"path": rel, "action": action})
                audited.add((rel, action))

        if not _append_audit_atomic(audit_path, audit_text, new_audit_rows):
            audit_failed = True

    return MigrationReport(
        scanned=scanned,
        changed_cards=changed,
        foreign_card_retained=foreign,
        unchanged_cards=unchanged,
        write_failures=failures,
        audit_rows=len(new_audit_rows) if not audit_failed else 0,
        audit_write_failed=audit_failed,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    report = migrate_reviewed_state(Path(args.cwd))
    if args.json:
        print(json.dumps(asdict(report), ensure_ascii=False, sort_keys=True))
    return 1 if report.write_failures or report.audit_write_failed else 0


if __name__ == "__main__":
    sys.exit(main())
