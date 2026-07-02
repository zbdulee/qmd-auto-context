#!/usr/bin/env python3
"""Resolve one entry in the retroactive wiki dedup queue.

Reads .auto-context/compile/dedup-needed.jsonl, applies one action to the
entry at --index, and rewrites the queue with that entry removed. Never
touches entries other than the one resolved this run.

Note: unlike core/wiki_review.py's `merge` (which UPDATES a matched page in
place), this script's `merge` action DELETES a file -- the caller (the
wiki-dedup-resolver subagent) has already folded any unique content into the
page it is keeping via its own Edit tool before invoking this CLI.
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
import wiki_compile as wc
import wiki_dedup_scan as dedup_scan
from dirty_queue import enqueue_collections
from wiki_compile_worker import claim_queue, requeue_lines

ACTIONS = {"merge", "skip"}
DEDUP_NEEDED_REL = ".auto-context/compile/dedup-needed.jsonl"
DEDUP_DELETED_REL = ".auto-context/compile/dedup-deleted.jsonl"
DEDUP_SKIPPED_REL = ".auto-context/compile/dedup-skipped.jsonl"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_entries(claimed: Path) -> list[tuple[str, dict | None]]:
    if not claimed.exists():
        return []
    rows = []
    for line in claimed.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            rows.append((line, None))
            continue
        rows.append((line, parsed if isinstance(parsed, dict) else None))
    return rows


def record_skip(root: Path, wiki_root: Path, compile_dir: Path, entry: dict) -> bool:
    """Append the skip judgment to dedup-skipped.jsonl so the scanner can
    suppress re-queueing this pair while both bodies are unchanged.

    Returns False -- recording NOTHING -- for stale skips: either page
    missing, path-unsafe, or unreadable. A stale skip is not a content
    judgment, and recording one would create a bogus permanent suppression.
    Recording failure never fails the skip itself.

    The hashes are computed HERE, by the CLI, at skip time -- never supplied
    by the resolver agent (an agent-supplied hash would be nondeterministic).
    """
    page_a = entry.get("pageA")
    page_b = entry.get("pageB")
    if not (isinstance(page_a, str) and isinstance(page_b, str)) or page_a == page_b:
        return False
    texts: dict[str, str] = {}
    for rel in (page_a, page_b):
        target = (wiki_root / rel).resolve()
        try:
            target.relative_to(wiki_root)
        except ValueError:
            return False
        if not target.is_file():
            return False  # stale skip: no content judgment happened
        try:
            texts[rel] = target.read_text(encoding="utf-8")
        except OSError:
            return False
    skipped_path = wc.safe_compile_file(root, compile_dir, DEDUP_SKIPPED_REL)
    if skipped_path is None:
        return False
    first, second = sorted((page_a, page_b))  # order-independent pair key
    wc.append_jsonl(skipped_path, {
        "pageA": first,
        "pageB": second,
        "pageAHash": dedup_scan.body_hash(texts[first]),
        "pageBHash": dedup_scan.body_hash(texts[second]),
        "skippedAt": now_iso(),
    })
    return True


def resolve_entry(root: Path, wiki_root: Path, compile_dir: Path, entry: dict, action: str, delete_rel: str | None) -> dict:
    page_a = entry.get("pageA")
    page_b = entry.get("pageB")
    valid_choices = {p for p in (page_a, page_b) if isinstance(p, str)}

    if action == "skip":
        recorded = record_skip(root, wiki_root, compile_dir, entry)
        return {"action": "skipped", "recorded": recorded}

    if action == "merge":
        if delete_rel not in valid_choices:
            return {"action": "rejected", "reason": "delete_not_in_entry"}
        target = (wiki_root / delete_rel).resolve()
        try:
            target.relative_to(wiki_root)
        except ValueError:
            return {"action": "rejected", "reason": "unsafe_delete_path"}
        if not target.is_file():
            return {"action": "skipped", "reason": "stale_target"}

        paired_with = page_b if delete_rel == page_a else page_a
        content = target.read_text(encoding="utf-8")
        deleted_path = wc.safe_compile_file(root, compile_dir, DEDUP_DELETED_REL)
        if deleted_path is not None:
            wc.append_jsonl(deleted_path, {
                "deletedPath": delete_rel,
                "content": content,
                "pairedWith": paired_with,
                "score": entry.get("score"),
                "resolvedAt": now_iso(),
            })
        target.unlink()
        return {"action": "deleted", "deletedPath": delete_rel}

    return {"action": "rejected", "reason": "unknown_action"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=".")
    parser.add_argument("--index", type=int, required=True)
    parser.add_argument("--action", required=True, choices=sorted(ACTIONS))
    parser.add_argument("--delete", default=None)
    args = parser.parse_args()

    found = qmd_config.find_project_config(args.cwd)
    root = Path(found["projectRoot"]).resolve()
    config = found["config"]
    wiki_rel = config.get("wikiPath", ".auto-context/wiki")
    wiki_root = wc.safe_managed_dir(root, wiki_rel)
    compile_dir = wc.safe_managed_dir(root, ".auto-context/compile")
    if wiki_root is None or compile_dir is None:
        print(json.dumps({"action": "rejected", "reason": "unsafe_managed_path"}, ensure_ascii=False))
        return 1
    queue_path = wc.safe_compile_file(root, compile_dir, DEDUP_NEEDED_REL)
    if queue_path is None:
        print(json.dumps({"action": "rejected", "reason": "unsafe_compile_path"}, ensure_ascii=False))
        return 1

    if args.action == "merge" and not args.delete:
        print(json.dumps({"action": "rejected", "reason": "missing_delete_arg"}, ensure_ascii=False))
        return 1

    claimed = claim_queue(queue_path)
    if claimed is None:
        print(json.dumps({"action": "rejected", "reason": "queue_empty"}, ensure_ascii=False))
        return 1

    rows = load_entries(claimed)
    if not (0 <= args.index < len(rows)):
        requeue_lines(queue_path, [raw for raw, _ in rows])
        claimed.unlink(missing_ok=True)
        print(json.dumps({"action": "rejected", "reason": "index_out_of_range"}, ensure_ascii=False))
        return 1

    raw, entry = rows[args.index]

    if entry is None:
        remaining_raw = [r for i, (r, _) in enumerate(rows) if i != args.index]
        requeue_lines(queue_path, remaining_raw)
        claimed.unlink(missing_ok=True)
        print(json.dumps({"action": "rejected", "reason": "malformed_entry"}, ensure_ascii=False))
        return 1

    # Ordering invariant (same as core/wiki_review.py): resolve_entry() must
    # complete BEFORE this entry is excluded from the requeue, so a crash
    # never loses the entry.
    try:
        result = resolve_entry(root, wiki_root, compile_dir, entry, args.action, args.delete)
    except Exception:
        requeue_lines(queue_path, [r for r, _ in rows])
        claimed.unlink(missing_ok=True)
        raise

    # A "rejected" outcome means the resolution did NOT apply (e.g. --delete
    # failed re-validation) -- the entry must stay in the queue for a retry,
    # unlike "deleted"/"skipped" which did apply and are done with.
    if result.get("action") == "rejected":
        requeue_lines(queue_path, [r for r, _ in rows])
    else:
        remaining_raw = [r for i, (r, _) in enumerate(rows) if i != args.index]
        requeue_lines(queue_path, remaining_raw)
    claimed.unlink(missing_ok=True)

    if result.get("action") == "deleted":
        collection, collection_path = wc.find_wiki_collection(config)
        if collection and collection_path:
            enqueue_collections({collection: str((root / collection_path).resolve())})

    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("action") != "rejected" else 1


if __name__ == "__main__":
    sys.exit(main())
