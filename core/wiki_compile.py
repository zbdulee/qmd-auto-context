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
FRONTMATTER_RE = re.compile(r"\A---\n(.*?)\n---\n", re.S)


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


def safe_compile_file(root: Path, compile_dir: Path, rel: object) -> Path | None:
    if not isinstance(rel, str) or not rel:
        return None
    path = (root / rel).resolve()
    try:
        path.relative_to(compile_dir)
    except ValueError:
        return None
    return path


def normalize_identity(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", value.strip().lower())


def slug_identity(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"[^A-Za-z0-9가-힣]+", "-", value.lower()).strip("-")


def identity_keys(value: object) -> set[str]:
    return {key for key in (normalize_identity(value), slug_identity(value)) if key}


def clean_aliases(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    aliases = []
    seen = set()
    for item in value:
        if not isinstance(item, str):
            continue
        alias = item.strip()
        if not alias:
            continue
        norm = normalize_identity(alias)
        if norm in seen:
            continue
        seen.add(norm)
        aliases.append(alias)
    return aliases


def clean_canonical_key(value: object) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


def unquote_yaml(value: str) -> str:
    text = value.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        text = text[1:-1]
    return text.replace('\\"', '"')


def parse_yaml_scalar(value: str):
    text = unquote_yaml(value)
    if text.lower() == "true":
        return True
    if text.lower() == "false":
        return False
    return text


def parse_yaml_inline_list(value: str) -> list:
    text = value.strip()
    if not (text.startswith("[") and text.endswith("]")):
        return []
    inner = text[1:-1].strip()
    if not inner:
        return []
    return [parse_yaml_scalar(part.strip()) for part in inner.split(",") if part.strip()]


def parse_frontmatter(text: str) -> tuple[dict, bool]:
    match = FRONTMATTER_RE.match(text)
    if not match:
        return {}, False
    meta = {}
    current_key = None
    for raw_line in match.group(1).splitlines():
        if not raw_line.strip():
            continue
        if raw_line.startswith("  - "):
            if current_key is None:
                return {}, False
            meta.setdefault(current_key, []).append(parse_yaml_scalar(raw_line[4:]))
            continue
        if raw_line.startswith(" ") or ":" not in raw_line:
            return {}, False
        key, raw_value = raw_line.split(":", 1)
        key = key.strip()
        if not key:
            return {}, False
        if key in meta:
            return {}, False
        raw_value = raw_value.strip()
        if raw_value == "":
            meta[key] = []
            current_key = key
        elif raw_value.startswith("[") and raw_value.endswith("]"):
            meta[key] = parse_yaml_inline_list(raw_value)
            current_key = None
        else:
            meta[key] = parse_yaml_scalar(raw_value)
            current_key = None
    return meta, True


def identity_values_from_meta(meta: dict) -> list[str]:
    values = []
    for key in ("canonicalKey", "title"):
        value = meta.get(key)
        if isinstance(value, str) and value.strip():
            values.append(value.strip())
    aliases = meta.get("aliases")
    if isinstance(aliases, list):
        values.extend(alias.strip() for alias in aliases if isinstance(alias, str) and alias.strip())
    elif isinstance(aliases, str) and aliases.strip():
        values.append(aliases.strip())
    return values


def build_identity_index(wiki_root: Path) -> dict[str, set[Path]]:
    index: dict[str, set[Path]] = {}
    if not wiki_root.exists():
        return index
    for page in wiki_root.rglob("*.md"):
        try:
            text = page.read_text(encoding="utf-8")
        except OSError:
            continue
        meta, ok = parse_frontmatter(text)
        if not ok:
            continue
        for value in identity_values_from_meta(meta):
            for key in identity_keys(value):
                index.setdefault(key, set()).add(page.resolve())
    return index


def candidate_identity_tiers(candidate: dict) -> list[tuple[str, list[str]]]:
    tiers = []
    canonical = clean_canonical_key(candidate.get("canonicalKey"))
    if canonical:
        tiers.append(("canonicalKey", [canonical]))
    aliases = clean_aliases(candidate.get("aliases"))
    if aliases:
        tiers.append(("aliases", aliases))
    title = str(candidate.get("title") or "").strip()
    if title:
        tiers.append(("title", [title]))
    return tiers


def lookup_identity(candidate: dict, identity_index: dict[str, set[Path]]) -> tuple[str, list[Path]]:
    for reason, values in candidate_identity_tiers(candidate):
        matches = set()
        for value in values:
            for key in identity_keys(value):
                matches.update(identity_index.get(key, set()))
        if matches:
            return reason, sorted(matches)
    return "", []


def resolve_target(root: Path, wiki_root: Path, candidate: dict, suggested_type: str, identity_index: dict[str, set[Path]]) -> tuple[Path | None, str, list[Path]]:
    raw_target = candidate.get("targetPath")
    if isinstance(raw_target, str) and raw_target.strip():
        target = (root / raw_target).resolve()
    else:
        match_reason, matches = lookup_identity(candidate, identity_index)
        if len(matches) == 1:
            return matches[0], match_reason, matches
        if len(matches) > 1:
            return None, f"ambiguous_{match_reason}", matches
        title = str(candidate.get("title") or "wiki-page")
        slug = re.sub(r"[^A-Za-z0-9가-힣]+", "-", title.lower()).strip("-") or "wiki-page"
        target = (wiki_root / TYPE_DIRS.get(suggested_type, "concepts") / f"{slug}.md").resolve()
    try:
        target.relative_to(wiki_root)
    except ValueError:
        return None, "unsafe", []
    return target, "explicit" if isinstance(raw_target, str) and raw_target.strip() else "slug", []


def redact(text: str) -> tuple[str, list[str]]:
    redactions = []
    result = text
    for pattern in SECRET_PATTERNS:
        if pattern.search(result):
            redactions.append("secret_like")
            result = pattern.sub("[REDACTED]", result)
    return result, sorted(set(redactions))


def source_hash(candidate: dict) -> str:
    identity = clean_canonical_key(candidate.get("canonicalKey")) or str(candidate.get("title") or "")
    stable = {
        "identity": identity,
        "summary": candidate.get("summary"),
        "sources": candidate.get("sources"),
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


def same_generated_identity(row: dict, record: dict) -> bool:
    if row.get("targetPath") and row.get("targetPath") == record.get("targetPath"):
        return True
    if record.get("targetResolution") == "explicit":
        return False
    if row.get("sourceHash") and row.get("sourceHash") == record.get("sourceHash"):
        return True
    canonical_key = record.get("canonicalKey")
    if canonical_key and row.get("canonicalKey") == canonical_key:
        return True
    return False


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
    canonical_key = clean_canonical_key(candidate.get("canonicalKey"))
    aliases = clean_aliases(candidate.get("aliases"))
    lines = [
        "---",
        f"title: {yaml_scalar(candidate.get('title') or 'Untitled')}",
    ]
    if canonical_key:
        lines.append(f"canonicalKey: {yaml_scalar(canonical_key)}")
    if aliases:
        lines.append("aliases:")
        for alias in aliases:
            lines.append(f"  - {yaml_scalar(alias)}")
    else:
        lines.append("aliases: []")
    lines.extend([
        f"type: {suggested_type}",
        f"status: {status}",
        f"created: {created}",
        f"updated: {created}",
        "createdBy: qmd-auto-context",
        f"confidence: {confidence}",
        "reviewed: false",
        "sources:",
    ])
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


def is_auto_writable_page(path: Path) -> tuple[bool, list[str]]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return False, ["unreadable_target"]
    meta, ok = parse_frontmatter(text)
    if not ok:
        return False, ["frontmatter_unparseable"]
    findings = []
    if meta.get("reviewed") is True:
        findings.append("reviewed_true")
    if str(meta.get("status") or "").strip().lower() in {"reviewed", "canon", "manual"}:
        findings.append("protected_status")
    if meta.get("createdBy") != "qmd-auto-context":
        findings.append("non_qmd_created_by")
    if not AUTO_BLOCK_RE.search(text):
        findings.append("managed_section_missing")
    return not findings, findings


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
    if mode == "off":
        return 0
    wiki_rel = config.get("wikiPath", ".auto-context/wiki")
    wiki_root = safe_managed_dir(root, wiki_rel)
    compile_dir = safe_managed_dir(root, ".auto-context/compile")
    if wiki_root is None or compile_dir is None:
        print(json.dumps({"action": "rejected", "reason": "unsafe_managed_path"}, ensure_ascii=False))
        return 1

    suggested_type = candidate.get("suggestedType") if candidate.get("suggestedType") in ALLOWED_TYPES else "concept"
    identity_index = build_identity_index(wiki_root)
    target, target_reason, target_matches = resolve_target(root, wiki_root, candidate, suggested_type, identity_index)
    max_lines = int(compile_cfg.get("maxAutoPageLines", 120) or 120)
    lint = lint_candidate(candidate, target, max_lines)
    title = str(candidate.get("title") or "Untitled").strip() or "Untitled"
    summary, redactions = redact(str(candidate.get("summary") or "").strip())
    h = source_hash({**candidate, "summary": summary})

    candidate_path = safe_compile_file(root, compile_dir, compile_cfg.get("candidatePath", ".auto-context/compile/candidates.jsonl"))
    tombstone_path = safe_compile_file(root, compile_dir, compile_cfg.get("tombstonePath", ".auto-context/compile/tombstones.jsonl"))
    manifest_path = safe_compile_file(root, compile_dir, compile_cfg.get("manifestPath", ".auto-context/compile/generated-manifest.jsonl"))
    if candidate_path is None or tombstone_path is None or manifest_path is None:
        print(json.dumps({"action": "rejected", "reason": "unsafe_compile_path"}, ensure_ascii=False))
        return 1

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
        "canonicalKey": clean_canonical_key(candidate.get("canonicalKey")),
        "aliases": clean_aliases(candidate.get("aliases")),
        "targetResolution": target_reason,
        "targetMatches": [match.relative_to(root).as_posix() for match in target_matches],
        "sourceHash": h,
        "lint": lint,
        "redactions": redactions,
    }

    if target_reason.startswith("ambiguous_"):
        record["action"] = "merge-needed"
        record["lint"] = {"verdict": "needs_review", "findings": [target_reason]}
        append_jsonl(candidate_path, record)
        print(json.dumps({"action": "merge-needed", "reason": target_reason, "targetMatches": record["targetMatches"]}, ensure_ascii=False))
        return 0

    if lint["verdict"] != "clean" or target is None:
        if "transcript_like" in lint.get("findings", []):
            record["summary"] = "[REDACTED_TRANSCRIPT]"
            record["redactions"] = sorted(set(record.get("redactions", []) + ["transcript_like"]))
        record["action"] = "rejected"
        append_jsonl(candidate_path, record)
        print(json.dumps({"action": "rejected", "findings": lint["findings"]}, ensure_ascii=False))
        return 0

    tombstones = read_jsonl(tombstone_path)
    if any(same_generated_identity(row, record) for row in tombstones) and not args.regenerate:
        record["action"] = "suppressed"
        append_jsonl(candidate_path, record)
        print(json.dumps({"action": "suppressed", "targetPath": record["targetPath"]}, ensure_ascii=False))
        return 0

    previous = [
        row for row in read_jsonl(manifest_path)
        if same_generated_identity(row, record)
    ]
    if previous and not target.exists() and not args.regenerate:
        tombstone = {**record, "action": "deleted", "status": "deleted", "previousStatus": previous[-1].get("status", "generated")}
        append_jsonl(tombstone_path, tombstone)
        record["action"] = "tombstoned"
        append_jsonl(candidate_path, record)
        print(json.dumps({"action": "tombstoned", "targetPath": record["targetPath"]}, ensure_ascii=False))
        return 0

    if mode == "candidates" or not compile_cfg.get("autoWrite", False):
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
        auto_writable, findings = is_auto_writable_page(target)
        if not auto_writable:
            record["action"] = "merge-needed"
            record["lint"] = {"verdict": "needs_review", "findings": findings}
            append_jsonl(candidate_path, record)
            print(json.dumps({"action": "merge-needed", "targetPath": record["targetPath"], "findings": findings}, ensure_ascii=False))
            return 0
        page_block_match = AUTO_BLOCK_RE.search(page)
        if page_block_match is None:
            record["action"] = "merge-needed"
            record["lint"] = {"verdict": "needs_review", "findings": ["generated_section_missing"]}
            append_jsonl(candidate_path, record)
            print(json.dumps({"action": "merge-needed", "targetPath": record["targetPath"], "findings": ["generated_section_missing"]}, ensure_ascii=False))
            return 0
        page_block = page_block_match.group(0)
        page = AUTO_BLOCK_RE.sub(page_block, old)
        action = "updated"
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
