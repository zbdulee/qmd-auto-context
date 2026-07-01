#!/usr/bin/env python3
"""Human-in-the-loop resolution for candidates the semantic gate queued.

Reads .auto-context/compile/merge-needed.jsonl, applies one action to the
entry at --index, and rewrites the queue with that entry removed. Never
touches entries other than the one resolved this run.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
import wiki_compile as wc
from wiki_compile_worker import claim_queue, requeue_lines

ACTIONS = {"merge", "supersede", "separate", "discard"}


def merge_needed_path(root: Path, config: dict) -> Path:
    compile_cfg = config.get("compile") if isinstance(config.get("compile"), dict) else {}
    rel = compile_cfg.get("mergeNeededPath", ".auto-context/compile/merge-needed.jsonl")
    compile_dir = wc.safe_managed_dir(root, ".auto-context/compile")
    return wc.safe_compile_file(root, compile_dir, rel) if compile_dir else None


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


def write_new_page(root: Path, wiki_root: Path, candidate: dict, extra_frontmatter: dict | None = None) -> tuple[Path, str]:
    suggested_type = candidate.get("suggestedType") if candidate.get("suggestedType") in wc.ALLOWED_TYPES else "concept"
    title = str(candidate.get("title") or "Untitled").strip() or "Untitled"
    slug = wc.re.sub(r"[^A-Za-z0-9가-힣]+", "-", title.lower()).strip("-") or "wiki-page"
    summary, redactions = wc.redact(str(candidate.get("summary") or "").strip())
    h = wc.source_hash({**candidate, "summary": summary})
    type_dir = wc.TYPE_DIRS.get(suggested_type, "concepts")
    target = (wiki_root / type_dir / f"{slug}.md").resolve()
    if target.exists():
        # Never silently clobber an unrelated page that happened to land on the
        # same slug (e.g. a wiki-compile run created it after this candidate was
        # queued). Disambiguate with a short hash suffix instead.
        target = (wiki_root / type_dir / f"{slug}-{h[:8]}.md").resolve()
    page = wc.markdown_page(candidate, summary, "generated", redactions, h)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(page, encoding="utf-8")
    if extra_frontmatter:
        wc.patch_frontmatter_fields(target, extra_frontmatter)
    wc.update_index(wiki_root, target, title)
    wc.append_log(wiki_root, "created", target, title)
    return target, title


def resolve_entry(root: Path, wiki_root: Path, config: dict, entry: dict, action: str) -> dict:
    candidate = entry.get("candidate") if isinstance(entry.get("candidate"), dict) else {}
    matched_rel = entry.get("matchedPath")
    matched_path = (root / matched_rel).resolve() if isinstance(matched_rel, str) and matched_rel else None
    if matched_path is not None:
        try:
            matched_path.relative_to(wiki_root)
        except ValueError:
            # Queue entry points outside the wiki (hand-edited/corrupted
            # merge-needed.jsonl). Never read or write outside the wiki root —
            # treat exactly like a stale/missing match.
            matched_path = None
    match_exists = matched_path is not None and matched_path.is_file()

    if action == "discard":
        return {"action": "discarded"}

    if action == "separate":
        target, _ = write_new_page(root, wiki_root, candidate)
        return {"action": "created", "targetPath": target.relative_to(root).as_posix()}

    if action == "merge":
        if not match_exists:
            target, _ = write_new_page(root, wiki_root, candidate)
            return {"action": "created", "targetPath": target.relative_to(root).as_posix(), "fallback": "stale_match"}
        writable, findings = wc.is_auto_writable_page(matched_path)
        if not writable:
            target, _ = write_new_page(root, wiki_root, candidate)
            return {
                "action": "created",
                "targetPath": target.relative_to(root).as_posix(),
                "fallback": "target_not_writable",
                "reason": findings,
            }
        title = str(candidate.get("title") or "Untitled").strip() or "Untitled"
        summary, redactions = wc.redact(str(candidate.get("summary") or "").strip())
        h = wc.source_hash({**candidate, "summary": summary})
        page = wc.markdown_page(candidate, summary, "generated", redactions, h)
        old = matched_path.read_text(encoding="utf-8")
        page_block_match = wc.AUTO_BLOCK_RE.search(page)
        if page_block_match is None:
            return {"action": "merge-needed", "reason": "generated_section_missing"}
        old = wc.AUTO_BLOCK_RE.sub(page_block_match.group(0), old)
        matched_path.write_text(old, encoding="utf-8")
        wc.append_log(wiki_root, "updated", matched_path, title)
        return {"action": "updated", "targetPath": matched_path.relative_to(root).as_posix()}

    if action == "supersede":
        if not match_exists:
            target, _ = write_new_page(root, wiki_root, candidate)
            return {"action": "created", "targetPath": target.relative_to(root).as_posix(), "fallback": "stale_match"}
        new_target, _ = write_new_page(
            root, wiki_root, candidate,
            extra_frontmatter={"supersedes": matched_path.relative_to(root).as_posix()},
        )
        wc.patch_frontmatter_fields(matched_path, {
            "status": "superseded",
            "supersededBy": new_target.relative_to(root).as_posix(),
        })
        return {
            "action": "created",
            "targetPath": new_target.relative_to(root).as_posix(),
            "supersedes": matched_path.relative_to(root).as_posix(),
        }

    return {"action": "rejected", "reason": "unknown_action"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=".")
    parser.add_argument("--index", type=int, required=True)
    parser.add_argument("--action", required=True, choices=sorted(ACTIONS))
    args = parser.parse_args()

    found = qmd_config.find_project_config(args.cwd)
    root = Path(found["projectRoot"]).resolve()
    config = found["config"]
    wiki_rel = config.get("wikiPath", ".auto-context/wiki")
    wiki_root = wc.safe_managed_dir(root, wiki_rel)
    queue_path = merge_needed_path(root, config)
    if wiki_root is None or queue_path is None:
        print(json.dumps({"action": "rejected", "reason": "unsafe_managed_path"}, ensure_ascii=False))
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
        # Unparseable garbage line: intentionally dropped from the queue, not
        # a resolve_entry() failure, so this is excluded from the requeue
        # exactly like the success path below.
        remaining_raw = [r for i, (r, _) in enumerate(rows) if i != args.index]
        requeue_lines(queue_path, remaining_raw)
        claimed.unlink(missing_ok=True)
        print(json.dumps({"action": "rejected", "reason": "malformed_entry"}, ensure_ascii=False))
        return 1

    # Ordering invariant: resolve_entry() must complete successfully BEFORE
    # this entry is excluded from the requeue. If resolve_entry() raises
    # (disk full, permission error, unexpected bug), the entry must still be
    # sitting in the live queue afterward — never lost. Do not move the
    # requeue_lines(...) call above this try/except.
    try:
        result = resolve_entry(root, wiki_root, config, entry, args.action)
    except Exception:
        requeue_lines(queue_path, [r for r, _ in rows])
        claimed.unlink(missing_ok=True)
        raise

    remaining_raw = [r for i, (r, _) in enumerate(rows) if i != args.index]
    requeue_lines(queue_path, remaining_raw)
    claimed.unlink(missing_ok=True)

    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("action") != "rejected" else 1


if __name__ == "__main__":
    sys.exit(main())
