#!/usr/bin/env python3
"""Deterministic wiki compile writer for qmd-auto-context.

This command intentionally accepts already-compact candidate JSON. It does not
persist raw transcripts and it does not run from query-time recall hooks.
"""
import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
from dirty_queue import enqueue_collections

ALLOWED_TYPES = {
    "concept",
    "entity",
    "decision",
    "session",
    "comparison",
    "query",
    "character",
    "world-rule",
    "timeline",
    "plot-decision",
    "style",
}
TYPE_DIRS = {
    "concept": "concepts",
    "entity": "entities",
    "decision": "decisions",
    "session": "sessions",
    "comparison": "comparisons",
    "query": "queries",
    "character": "characters",
    "world-rule": "world",
    "timeline": "timeline",
    "plot-decision": "plot",
    "style": "style",
}
SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"(?i)(api[_-]?key|secret|token)\s*[:=]\s*[^\s]+"),
]
TRANSCRIPT_RE = re.compile(r"(?im)^\s*(user|assistant|system|human|ai)\s*:")
AUTO_START_RE = re.compile(r'<!-- qmd:auto:start id="main" sourceHash="([a-f0-9]+)" -->')
AUTO_BLOCK_RE = re.compile(r'<!-- qmd:auto:start id="main" sourceHash="([a-f0-9]+)" -->\n.*?\n<!-- qmd:auto:end -->', re.S)


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def load_payload() -> dict:
    try:
        parsed = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def project_paths(cwd: str) -> tuple[Path, dict]:
    found = qmd_config.find_project_config(cwd)
    return Path(found["projectRoot"]).resolve(), found["config"]


def safe_managed_dir(root: Path, rel: str) -> Path | None:
    path = (root / rel).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    if path.exists() and (path.is_symlink() or not path.is_dir()):
        return None
    path.mkdir(parents=True, exist_ok=True)
    return path


def resolve_target(root: Path, wiki_root: Path, candidate: dict, suggested_type: str) -> Path | None:
    raw_target = candidate.get("targetPath")
    if isinstance(raw_target, str) and raw_target.strip():
        target = (root / raw_target).resolve()
    else:
        title = str(candidate.get("title") or "wiki-page")
        slug = re.sub(r"[^A-Za-z0-9가-힣]+", "-", title.lower()).strip("-") or "wiki-page"
        target = (wiki_root / TYPE_DIRS.get(suggested_type, "concepts") / f"{slug}.md").resolve()
    try:
        target.relative_to(wiki_root)
    except ValueError:
        return None
    return target


def redact(text: str) -> tuple[str, list[str]]:
    redactions = []
    result = text
    for pattern in SECRET_PATTERNS:
        if pattern.search(result):
            redactions.append("secret_like")
            result = pattern.sub("[REDACTED]", result)
    return result, sorted(set(redactions))


def source_hash(candidate: dict) -> str:
    stable = {
        "title": candidate.get("title"),
        "summary": candidate.get("summary"),
        "sources": candidate.get("sources"),
        "targetPath": candidate.get("targetPath"),
    }
    return hashlib.sha256(json.dumps(stable, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def lint_candidate(candidate: dict, target: Path | None, max_lines: int) -> dict:
    findings = []
    title = str(candidate.get("title") or "").strip()
    summary = str(candidate.get("summary") or "").strip()
    if not title:
        findings.append("missing_title")
    if not summary:
        findings.append("missing_summary")
    if target is None:
        findings.append("unsafe_target_path")
    if TRANSCRIPT_RE.search(summary):
        findings.append("transcript_like")
    if any(pattern.search(summary) or pattern.search(title) for pattern in SECRET_PATTERNS):
        findings.append("secret_like")
    if len(summary.splitlines()) > max_lines:
        findings.append("too_many_lines")
    return {"verdict": "clean" if not findings else "reject", "findings": findings}


def append_jsonl(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            rows.append(parsed)
    return rows


def yaml_scalar(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value).replace('"', '\\"')
    return f'"{text}"'


def markdown_page(candidate: dict, summary: str, status: str, redactions: list[str], h: str) -> str:
    created = today()
    suggested_type = str(candidate.get("suggestedType") or "concept")
    confidence = str(candidate.get("confidence") or "medium")
    sources = candidate.get("sources") if isinstance(candidate.get("sources"), list) else []
    triggers = [candidate.get("trigger")] if isinstance(candidate.get("trigger"), str) else []
    lines = [
        "---",
        f"title: {yaml_scalar(candidate.get('title') or 'Untitled')}",
        f"type: {suggested_type}",
        f"status: {status}",
        f"created: {created}",
        f"updated: {created}",
        "createdBy: qmd-auto-context",
        f"confidence: {confidence}",
        "reviewed: false",
        "sources:",
    ]
    if sources:
        for source in sources:
            if isinstance(source, dict):
                parts = ", ".join(f"{k}: {yaml_scalar(v)}" for k, v in source.items() if isinstance(k, str))
                lines.append(f"  - {{{parts}}}")
    else:
        lines.append("  - {kind: unknown}")
    lines.append("triggers:")
    if triggers:
        for trigger in triggers:
            lines.append(f"  - {trigger}")
    lines.append("redactions:")
    if redactions:
        for item in redactions:
            lines.append(f"  - {item}")
    lines.extend([
        "---",
        "",
        "> Auto-generated by qmd-auto-context from conversation/work context. Review, edit, or delete if wrong.",
        "",
        f'<!-- qmd:auto:start id="main" sourceHash="{h}" -->',
        "## Summary",
        summary,
        '<!-- qmd:auto:end -->',
        "",
    ])
    return "\n".join(lines)


def update_index(wiki_root: Path, target: Path, title: str) -> None:
    index = wiki_root / "index.md"
    if not index.exists():
        index.write_text("# Auto-context Wiki Index\n\n", encoding="utf-8")
    rel = target.relative_to(wiki_root).as_posix()
    line = f"- {rel} - {title}\n"
    text = index.read_text(encoding="utf-8")
    if rel not in text:
        index.write_text(text.rstrip() + "\n" + line, encoding="utf-8")


def append_log(wiki_root: Path, action: str, target: Path, title: str) -> None:
    log = wiki_root / "log.md"
    if not log.exists():
        log.write_text("# Auto-context Wiki Log\n\n", encoding="utf-8")
    rel = target.relative_to(wiki_root).as_posix()
    with log.open("a", encoding="utf-8") as handle:
        handle.write(f"- {now_iso()} {action} {rel} - {title}\n")


def find_wiki_collection(config: dict) -> tuple[str | None, str | None]:
    roles = config.get("collectionRoles") if isinstance(config.get("collectionRoles"), dict) else {}
    paths = config.get("collectionPaths") if isinstance(config.get("collectionPaths"), dict) else {}
    for name in config.get("collections", []):
        if roles.get(name) == "wiki":
            return name, paths.get(name, config.get("wikiPath", ".auto-context/wiki"))
    return None, None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--regenerate", action="store_true")
    args = parser.parse_args()

    if os.environ.get("QMD_SANDBOX"):
        return 0

    candidate = load_payload()
    root, config = project_paths(args.cwd)
    compile_cfg = config.get("compile") if isinstance(config.get("compile"), dict) else {}
    if config.get("indexing") is not True or not compile_cfg.get("enabled"):
        return 0

    mode = compile_cfg.get("mode", "off")
    wiki_rel = config.get("wikiPath", ".auto-context/wiki")
    wiki_root = safe_managed_dir(root, wiki_rel)
    compile_dir = safe_managed_dir(root, ".auto-context/compile")
    if wiki_root is None or compile_dir is None:
        print(json.dumps({"action": "rejected", "reason": "unsafe_managed_path"}, ensure_ascii=False))
        return 1

    suggested_type = candidate.get("suggestedType") if candidate.get("suggestedType") in ALLOWED_TYPES else "concept"
    target = resolve_target(root, wiki_root, candidate, suggested_type)
    max_lines = int(compile_cfg.get("maxAutoPageLines", 120) or 120)
    lint = lint_candidate(candidate, target, max_lines)
    title = str(candidate.get("title") or "Untitled").strip() or "Untitled"
    summary, redactions = redact(str(candidate.get("summary") or "").strip())
    h = source_hash({**candidate, "summary": summary})

    candidate_path = root / compile_cfg.get("candidatePath", ".auto-context/compile/candidates.jsonl")
    tombstone_path = root / compile_cfg.get("tombstonePath", ".auto-context/compile/tombstones.jsonl")
    manifest_path = root / compile_cfg.get("manifestPath", ".auto-context/compile/generated-manifest.jsonl")

    record = {
        "ts": now_iso(),
        "trigger": candidate.get("trigger", "manual"),
        "title": title,
        "summary": summary,
        "suggestedType": suggested_type,
        "suggestedStatus": compile_cfg.get("defaultStatus", "generated"),
        "confidence": candidate.get("confidence", "medium"),
        "sources": candidate.get("sources") if isinstance(candidate.get("sources"), list) else [],
        "targetPath": str(candidate.get("targetPath") or (target.relative_to(root).as_posix() if target else "")),
        "sourceHash": h,
        "lint": lint,
        "redactions": redactions,
    }

    if lint["verdict"] != "clean" or target is None:
        if "transcript_like" in lint.get("findings", []):
            record["summary"] = "[REDACTED_TRANSCRIPT]"
            record["redactions"] = sorted(set(record.get("redactions", []) + ["transcript_like"]))
        record["action"] = "rejected"
        append_jsonl(candidate_path, record)
        print(json.dumps({"action": "rejected", "findings": lint["findings"]}, ensure_ascii=False))
        return 0

    previous = [row for row in read_jsonl(manifest_path) if row.get("targetPath") == record["targetPath"] or row.get("sourceHash") == h]
    if previous and not target.exists() and not args.regenerate:
        tombstone = {**record, "action": "deleted", "status": "deleted", "previousStatus": previous[-1].get("status", "generated")}
        append_jsonl(tombstone_path, tombstone)
        record["action"] = "tombstoned"
        append_jsonl(candidate_path, record)
        print(json.dumps({"action": "tombstoned", "targetPath": record["targetPath"]}, ensure_ascii=False))
        return 0

    tombstones = read_jsonl(tombstone_path)
    if any(row.get("targetPath") == record["targetPath"] or row.get("sourceHash") == h for row in tombstones) and not args.regenerate:
        record["action"] = "suppressed"
        append_jsonl(candidate_path, record)
        print(json.dumps({"action": "suppressed", "targetPath": record["targetPath"]}, ensure_ascii=False))
        return 0

    if mode in ("off", "candidates") or not compile_cfg.get("autoWrite", False):
        record["action"] = "candidate"
        append_jsonl(candidate_path, record)
        print(json.dumps({"action": "candidate", "targetPath": record["targetPath"]}, ensure_ascii=False))
        return 0

    if mode == "guarded" and candidate.get("confidence") != "high":
        record["action"] = "candidate"
        append_jsonl(candidate_path, record)
        print(json.dumps({"action": "candidate", "targetPath": record["targetPath"]}, ensure_ascii=False))
        return 0

    status = compile_cfg.get("defaultStatus", "generated")
    target.parent.mkdir(parents=True, exist_ok=True)
    page = markdown_page(candidate, summary, status, redactions, h)
    action = "created"
    if target.exists():
        old = target.read_text(encoding="utf-8")
        if AUTO_BLOCK_RE.search(old):
            page_block = AUTO_BLOCK_RE.search(page).group(0)
            page = AUTO_BLOCK_RE.sub(page_block, old)
            action = "updated"
        else:
            record["action"] = "conflict"
            record["lint"] = {"verdict": "reject", "findings": ["managed_section_missing"]}
            append_jsonl(candidate_path, record)
            print(json.dumps({"action": "conflict", "targetPath": record["targetPath"]}, ensure_ascii=False))
            return 0
    target.write_text(page, encoding="utf-8")

    record["action"] = action
    append_jsonl(candidate_path, record)
    append_jsonl(manifest_path, {**record, "status": status})
    update_index(wiki_root, target, title)
    append_log(wiki_root, action, target, title)

    collection, collection_path = find_wiki_collection(config)
    if collection and collection_path:
        enqueue_collections({collection: str((root / collection_path).resolve())})

    print(json.dumps({"action": action, "targetPath": record["targetPath"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
