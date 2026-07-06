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
import urllib.error
import urllib.request
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
TYPE_DIR_NAMES = set(TYPE_DIRS.values())
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


def classify_explicit_target(raw: str, wiki_root: Path, suggested_type: str) -> tuple[str, Path | None]:
    """Decide how to treat an extractor-provided targetPath.

    Extractors sometimes emit wiki-root-relative paths (``concepts/foo.md``)
    instead of project-root-relative ones (``.auto-context/wiki/concepts/foo.md``).
    Returns one of:
    - ("use", path): wiki-root-relative path, normalized under wiki_root
    - ("fallback", None): looks wiki-root-relative but untrusted (bad extension,
      type mismatch, escapes wiki_root) — ignore it and resolve by identity
    - ("legacy", None): treat as project-root-relative (original behavior)
    """
    segments = [s for s in raw.replace("\\", "/").split("/") if s and s != "."]
    if raw.startswith("/") or not segments:
        return "legacy", None
    if any(s == ".." or s.startswith(".") for s in segments):
        return "legacy", None
    if segments[0] not in TYPE_DIR_NAMES:
        return "legacy", None
    if not segments[-1].endswith(".md"):
        return "fallback", None
    if segments[0] != TYPE_DIRS.get(suggested_type, "concepts"):
        return "fallback", None
    target = wiki_root.joinpath(*segments).resolve()
    try:
        target.relative_to(wiki_root)
    except ValueError:
        return "fallback", None
    return "use", target


def resolve_target(root: Path, wiki_root: Path, candidate: dict, suggested_type: str, identity_index: dict[str, set[Path]]) -> tuple[Path | None, str, list[Path]]:
    raw_target = candidate.get("targetPath")
    if isinstance(raw_target, str) and raw_target.strip():
        outcome, normalized = classify_explicit_target(raw_target.strip(), wiki_root, suggested_type)
        if outcome == "use":
            return normalized, "explicit", []
        if outcome == "legacy":
            target = (root / raw_target).resolve()
            try:
                target.relative_to(wiki_root)
            except ValueError:
                return None, "unsafe", []
            return target, "explicit", []
        # "fallback": untrusted wiki-relative targetPath — resolve by identity instead
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
    return target, "slug", []


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


LOG_MAX_BYTES = 256 * 1024


def trim_jsonl(path: Path, max_bytes: int = LOG_MAX_BYTES) -> None:
    """append-only 로그의 무한 누적 방지: 상한 초과 시 최근 절반만 유지.
    순수 로그(candidates/dedup-deleted/verify-log)용 — 한 줄 유실은 무해.
    correctness가 걸린 파일(manifest)엔 쓰지 말 것 — compact_manifest 사용."""
    try:
        if path.stat().st_size <= max_bytes:
            return
        lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
        path.write_text("".join(lines[len(lines) // 2:]), encoding="utf-8")
    except OSError:
        pass


def write_jsonl_atomic(path: Path, rows: list[dict]) -> None:
    """temp + os.replace 원자적 재작성 (부분 쓰기/유실 방지)."""
    tmp = path.with_suffix(path.suffix + ".compact.tmp")
    try:
        with tmp.open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
        os.replace(tmp, path)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass


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


def compact_manifest(path: Path, max_bytes: int = LOG_MAX_BYTES) -> None:
    """generated-manifest 무한 누적 방지. size trim은 특정 카드 엔트리를 통째
    날려 삭제감지(previous 조회)를 깨므로 쓰지 않고, same_generated_identity로
    서로 매칭되는 오래된 중복만 접는다 — 각 identity의 최신 엔트리는 원순서로
    보존해 previous[-1]/previousStatus 계약을 유지. 임계 초과 시에만 원자적
    replace. worst case(동시 append와 cross-process race로 엔트리 1개 유실)는
    그 카드가 다음 재컴파일 때 재생성되며 self-heal."""
    try:
        if path.stat().st_size <= max_bytes:
            return
    except OSError:
        return
    rows = read_jsonl(path)
    n = len(rows)
    keep = [True] * n
    for i in range(n):
        for j in range(i + 1, n):  # j가 i보다 최신(뒤에 append됨)
            if same_generated_identity(rows[i], rows[j]) or same_generated_identity(rows[j], rows[i]):
                keep[i] = False  # i는 같은 identity의 더 오래된 중복
                break
    kept = [rows[i] for i in range(n) if keep[i]]
    if len(kept) != n:
        write_jsonl_atomic(path, kept)


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


def patch_frontmatter_fields(path: Path, updates: dict[str, str]) -> bool:
    """Rewrite only the named top-level scalar frontmatter keys in place.

    Leaves every other frontmatter line and the managed body untouched. Used by
    wiki_review.py's supersede action to flip an old page's status without
    touching its generated summary block.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return False
    match = FRONTMATTER_RE.match(text)
    if not match:
        return False
    lines = match.group(1).splitlines()
    seen = set()
    new_lines = []
    for line in lines:
        key = None
        if line and not line.startswith(" ") and ":" in line:
            key = line.split(":", 1)[0].strip()
        if key in updates:
            new_lines.append(f"{key}: {yaml_scalar(updates[key])}")
            seen.add(key)
        else:
            new_lines.append(line)
    for key, value in updates.items():
        if key not in seen:
            new_lines.append(f"{key}: {yaml_scalar(value)}")
    new_frontmatter = "\n".join(new_lines)
    patched = text[: match.start(1)] + new_frontmatter + text[match.end(1) :]
    path.write_text(patched, encoding="utf-8")
    return True


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


def resolve_daemon_result_path(root: Path, wiki_root: Path, uri: str, collection: str) -> Path | None:
    if not isinstance(uri, str) or not uri:
        return None
    if uri.startswith("qmd://"):
        rest = uri[len("qmd://"):]
        if "/" not in rest:
            return None
        _, rel = rest.split("/", 1)
    elif collection and uri.startswith(f"{collection}/"):
        rel = uri[len(collection) + 1:]
    else:
        return None
    for candidate_root in (wiki_root, root):
        candidate_path = (candidate_root / rel).resolve()
        try:
            candidate_path.relative_to(wiki_root)
        except ValueError:
            continue
        if candidate_path.is_file():
            return candidate_path
    return None


def query_wiki_similar(daemon_url: str, collection: str, text: str, top_k: int, timeout: float) -> list[dict] | None:
    """Vector-search `text` against `collection`. Returns daemon `results` list, or
    None on any failure — caller must fail-open on None, never raise.

    Always queries with rerank=True: with rerank=False the daemon's `score`
    field is a reciprocal-rank value (1, 0.5, 0.33, ...) from result position,
    NOT a semantic similarity, which makes every caller's threshold comparison
    meaningless (rank-1 is always ~1.0 regardless of true similarity). Every
    caller here runs off an async path -- the compile worker's write-time
    semantic gate and similar-page lookup (backend_manager.sh forks the worker
    with `&`), the retroactive dedup scanner (update.sh's background embed
    subshell, once per 24h), or the manual wiki-compile skill -- so there is
    no synchronous per-edit caller left that needs to skip rerank for latency.
    """
    fixture_path = os.environ.get("QMD_QUERY_FIXTURE")
    if fixture_path:
        try:
            with open(fixture_path, "r", encoding="utf-8") as f:
                parsed = json.load(f)
            if not isinstance(parsed, dict):
                return None
            results = parsed.get("results", [])
        except (OSError, json.JSONDecodeError):
            return None
        return results if isinstance(results, list) else []
    # qmd's vec search rejects multi-line queries (store.js structuredSearch:
    # "queries must be single-line. Remove newline characters.") with a 500.
    # Card bodies are almost always multi-line, so passing them raw made every
    # caller (write-time semantic gate, retroactive dedup scan, similar-page
    # lookup) silently fail-open on any multi-line card -- the dominant cause of
    # near-duplicate proliferation. Collapse all whitespace to single spaces.
    single_line = " ".join(text.split())
    payload = {
        "searches": [{"type": "vec", "query": single_line}],
        "collections": [collection],
        "limit": max(1, top_k),
        "minScore": 0,
        "timeout": timeout,
        "rerank": True,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{daemon_url}/query",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
        parsed = json.loads(body)
        if not isinstance(parsed, dict):
            return None
        results = parsed.get("results", [])
        return results if isinstance(results, list) else []
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
        return None


def find_wiki_semantic_match(
    root: Path, wiki_root: Path, config: dict, candidate: dict, summary: str
) -> tuple[Path | None, float | None]:
    """Return (matched_path, score) for the top daemon hit above threshold, or
    (None, top_score_or_None) if nothing qualifies or the daemon/fixture failed."""
    compile_cfg = config.get("compile") if isinstance(config.get("compile"), dict) else {}
    semantic_cfg = compile_cfg.get("semanticDedup") if isinstance(compile_cfg.get("semanticDedup"), dict) else {}
    if not semantic_cfg.get("enabled", True):
        return None, None
    collection, _ = find_wiki_collection(config)
    if not collection:
        return None, None
    text = f"{candidate.get('title') or ''} {summary}".strip()
    if not text:
        return None, None
    daemon_url = os.environ.get("QMD_DAEMON_URL", "http://localhost:8483")
    timeout = float(config.get("queryTimeout", 5.0) or 5.0)
    results = query_wiki_similar(daemon_url, collection, text, int(semantic_cfg.get("topK", 3)), timeout)
    if not results:
        return None, None
    def numeric_score(value) -> float:
        return value if isinstance(value, (int, float)) else 0

    top = max(results, key=lambda r: numeric_score(r.get("score", 0)) if isinstance(r, dict) else 0)
    score = numeric_score(top.get("score", 0)) if isinstance(top, dict) else 0
    threshold = float(semantic_cfg.get("threshold", 0.82))
    if score < threshold:
        return None, score
    matched = resolve_daemon_result_path(root, wiki_root, top.get("file", "") if isinstance(top, dict) else "", collection)
    return matched, score


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
    if str(meta.get("status") or "").strip().lower() in {"reviewed", "canon", "manual", "superseded"}:
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
    merge_needed_path = safe_compile_file(root, compile_dir, compile_cfg.get("mergeNeededPath", ".auto-context/compile/merge-needed.jsonl"))
    if candidate_path is None or tombstone_path is None or manifest_path is None or merge_needed_path is None:
        print(json.dumps({"action": "rejected", "reason": "unsafe_compile_path"}, ensure_ascii=False))
        return 1

    # candidates.jsonl is a write-only audit log (every compile attempt appends a
    # row, no reader) -- cap it up front so it can't grow unbounded.
    trim_jsonl(candidate_path)

    record = {
        "ts": now_iso(),
        "trigger": candidate.get("trigger", "manual"),
        "title": title,
        "summary": summary,
        "suggestedType": suggested_type,
        "suggestedStatus": compile_cfg.get("defaultStatus", "generated"),
        "confidence": candidate.get("confidence", "medium"),
        "sources": candidate.get("sources") if isinstance(candidate.get("sources"), list) else [],
        "targetPath": target.relative_to(root).as_posix() if target else str(candidate.get("targetPath") or ""),
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

    if target_reason == "slug" and not target.exists():
        matched_path, score = find_wiki_semantic_match(root, wiki_root, config, candidate, summary)
        if matched_path is not None:
            suggested_action = "supersede-or-new" if suggested_type == "decision" else "merge"
            append_jsonl(merge_needed_path, {
                "ts": now_iso(),
                "candidate": record,
                "matchedPath": matched_path.relative_to(root).as_posix(),
                "matchedScore": score,
                "suggestedAction": suggested_action,
            })
            record["action"] = "queued_for_review"
            append_jsonl(candidate_path, record)
            print(json.dumps({
                "action": "queued_for_review",
                "matchedPath": matched_path.relative_to(root).as_posix(),
                "score": score,
            }, ensure_ascii=False))
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

    if action == "updated":
        # updated 경로는 AUTO_BLOCK만 치환하고 기존 frontmatter를 보존하므로, 이전
        # verified/contested 상태가 새 내용에 그대로 붙는 stale 검증이 된다 — 쓰기
        # status(defaultStatus)로 명시 리셋해 재검증 대상으로 되돌린다.
        old_meta, _ = parse_frontmatter(old)
        old_status = str(old_meta.get("status") or "").strip()
        if old_status and old_status != status:
            updates = {"status": status}
            if "verifiedBy" in old_meta or "verifiedAt" in old_meta:
                updates["verifiedBy"] = ""
                updates["verifiedAt"] = ""
            patch_frontmatter_fields(target, updates)

    record["action"] = action
    append_jsonl(candidate_path, record)
    append_jsonl(manifest_path, {**record, "status": status})
    # manifest is read for delete-detection (previous lookup); compact by folding
    # same-identity duplicates rather than size-trimming (which would drop a card's
    # entry and break tombstoning). Threshold-gated + atomic inside.
    compact_manifest(manifest_path)
    update_index(wiki_root, target, title)
    append_log(wiki_root, action, target, title)

    collection, collection_path = find_wiki_collection(config)
    if collection and collection_path:
        enqueue_collections({collection: str((root / collection_path).resolve())})

    # 기계 검수(auto-verify) enqueue: generated로 쓰인 카드만 대상. verify worker가
    # 카드 주장 vs 원문을 대조해 verified 승격 또는 (onFail) 삭제한다.
    verify_cfg = compile_cfg.get("verify") if isinstance(compile_cfg.get("verify"), dict) else {}
    if verify_cfg.get("enabled", True) and status == "generated":
        verify_queue_path = safe_compile_file(
            root, compile_dir, verify_cfg.get("queuePath", ".auto-context/compile/verify-queue.jsonl")
        )
        if verify_queue_path is not None:
            append_jsonl(verify_queue_path, {
                "ts": now_iso(),
                "targetPath": record["targetPath"],
                "sources": record["sources"],
                "sourceHash": h,
                "engine": candidate.get("engine") if isinstance(candidate.get("engine"), str) else "",
                "trigger": record["trigger"],
            })

    print(json.dumps({"action": action, "targetPath": record["targetPath"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
