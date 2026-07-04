#!/usr/bin/env python3
import sys
import os
import json
import math
import re
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime, timezone

# Add current directory to path to import core sibling modules
sys.path.insert(0, str(Path(__file__).parent.resolve()))
import config as qmd_config
import keywords as qmd_keywords

DEFAULT_DAEMON_URL = "http://localhost:8483"
DEFAULT_HEALTH_TIMEOUT = 2.0
QUERY_TIMEOUT = 5.0

def health_timeout() -> float:
    try:
        timeout = float(os.environ.get("QMD_HEALTH_TIMEOUT", DEFAULT_HEALTH_TIMEOUT))
    except (TypeError, ValueError):
        return DEFAULT_HEALTH_TIMEOUT
    return timeout if math.isfinite(timeout) and timeout > 0 else DEFAULT_HEALTH_TIMEOUT

def daemon_alive(daemon_url: str) -> bool:
    try:
        req = urllib.request.Request(f"{daemon_url}/health", method="GET")
        with urllib.request.urlopen(req, timeout=health_timeout()) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False

def load_project_config(cwd: str) -> dict:
    return qmd_config.load_project_config(cwd)

def qmd_uri_to_filepath(uri: str) -> str:
    if uri.startswith("qmd://"):
        parts = uri[len("qmd://"):].split("/", 1)
        if len(parts) == 2:
            return parts[1]
    return uri

def qmd_uri_to_collection(uri: str) -> str:
    if uri.startswith("qmd://"):
        return uri[len("qmd://"):].split("/", 1)[0]
    return uri.split("/", 1)[0] if "/" in uri else ""

def resolve_wiki_result_path(result: dict, config: dict, cwd: str) -> Path | None:
    uri = result.get("file", "")
    collection = result.get("_collection", "") or qmd_uri_to_collection(uri)
    collection_paths = config.get("collectionPaths", {}) if isinstance(config.get("collectionPaths"), dict) else {}
    wiki_path = config.get("wikiPath", ".auto-context/wiki")
    project_root = Path(qmd_config.find_project_config(cwd).get("projectRoot", cwd)).resolve()
    wiki_root = (project_root / wiki_path).resolve()
    candidates = []
    if uri.startswith("qmd://") and "/" in uri[len("qmd://"):]:
        rel = uri[len("qmd://"):].split("/", 1)[1]
        base = collection_paths.get(collection, "")
        if base:
            candidates.append((project_root / base / rel).resolve())
        candidates.append((project_root / rel).resolve())
    elif uri:
        path = Path(uri)
        candidates.append(path.resolve() if path.is_absolute() else (project_root / path).resolve())
    for candidate in candidates:
        try:
            candidate.relative_to(wiki_root)
        except ValueError:
            continue
        if candidate.is_file():
            return candidate
    return None

# wiki_compile.is_auto_writable_page의 보호 status 집합과 동일 — reviewed 판정 기준 공유.
REVIEWED_WIKI_STATUSES = {"reviewed", "canon", "manual", "superseded"}

def read_wiki_meta(result: dict, config: dict, cwd: str) -> dict:
    """wiki 결과의 frontmatter에서 status와 검수 여부를 읽는다.

    검수 판정: reviewed:true, 보호 status, 또는 createdBy가 명시적으로
    qmd-auto-context가 아닌 경우. createdBy 부재 시에는 status가 기준이다
    (status 부재 기본값 generated = 미검수 — 기존 status 기본값 규약과 일치).
    """
    meta = {"status": "generated", "reviewed": False}
    path = resolve_wiki_result_path(result, config, cwd)
    if path is None:
        return meta
    try:
        text = path.read_text(encoding="utf-8")[:4096]
    except OSError:
        return meta
    if not text.startswith("---"):
        return meta
    end = text.find("\n---", 3)
    if end == -1:
        return meta
    fields = {}
    for line in text[3:end].splitlines():
        stripped = line.strip()
        for key in ("status", "reviewed", "createdBy"):
            if stripped.startswith(f"{key}:"):
                value = stripped.split(":", 1)[1].strip().strip('"\'')
                if value:
                    fields[key] = value
    if fields.get("status"):
        meta["status"] = fields["status"]
    created_by = fields.get("createdBy", "")
    meta["reviewed"] = (
        fields.get("reviewed", "").lower() == "true"
        or meta["status"].lower() in REVIEWED_WIKI_STATUSES
        or (created_by != "" and created_by != "qmd-auto-context")
    )
    return meta

def ep_numbers(prompt: str) -> list[int]:
    nums: list[int] = []
    for match in re.finditer(r"\bEP[\s_-]*0*(\d{1,3})\b|\b0*(\d{1,3})\s*화", prompt, re.IGNORECASE):
        ep = match.group(1) or match.group(2)
        if ep:
            nums.append(int(ep))
    return list(dict.fromkeys(nums))

def ep_file_matches(filepath: str, n: int) -> bool:
    base = qmd_uri_to_filepath(filepath or "").rsplit("/", 1)[-1].lower()
    for match in re.finditer(r"ep[-_]?0*(\d{1,3})(?!\d)|0*(\d{1,3})\s*화(?![가-힣])", base):
        tok = match.group(1) or match.group(2)
        if tok and int(tok) == n:
            return True
    return False

def promote_ep_exact_matches(results: list[dict], nums: list[int]) -> None:
    if not nums:
        return
    for result in results:
        filepath = result.get("file", "")
        if any(ep_file_matches(filepath, n) for n in nums):
            try:
                score = float(result.get("score", 0) or 0)
            except (TypeError, ValueError):
                score = 0
            result["score"] = max(score, 1.0)
            result["_exact_match"] = True

def resolve_prefix_style(config: dict) -> str:
    if os.environ.get("QMD_PREFIX_STYLE") == "tag" or config.get("prefixStyle") == "tag":
        return "tag"
    return "full"

def format_context(results: list[dict], prefix_style: str = "full", collection_roles: dict | None = None) -> str:
    collection_roles = collection_roles or {}
    lines = ["관련 문서:"]
    has_unreviewed = False
    for result in results:
        uri = result.get("file", "")
        filepath = qmd_uri_to_filepath(uri)
        title = result.get("title", "")
        collection = result.get("_collection", "") or qmd_uri_to_collection(uri)

        tag = collection_roles.get(collection, collection)
        if tag == "wiki" and result.get("_wiki_status"):
            tag = f"wiki:{result['_wiki_status']}"
        if collection not in collection_roles and prefix_style == "tag" and collection:
            tag = collection.rsplit("-", 1)[-1]
        prefix = f"[{tag}] " if tag else ""

        # 미검수 자동생성 wiki 카드 배지: 모델이 카드를 검수된 캐논으로 오신뢰하는 것 방지.
        suffix = ""
        if result.get("_wiki_status") and not result.get("_wiki_reviewed", False):
            suffix = " (미검수)"
            has_unreviewed = True

        if title:
            lines.append(f"- {prefix}{filepath} - {title}{suffix}")
        else:
            lines.append(f"- {prefix}{filepath}{suffix}")
    if has_unreviewed:
        lines.append("주의: (미검수) 표시는 자동 생성 요약 — 단독 캐논 근거로 인용 금지, 원문 대조 필요.")
    lines.append("필요시 참조.")
    return "\n".join(lines)

def log_score_observation(log_path: str | None, results: list[dict], collections: list[str]) -> None:
    if not log_path or not results:
        return
    scores = [r.get("score", 0) for r in results]
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": "qmd_score_observation",
        "engine": os.environ.get("QMD_ENGINE", "gemini"),
        "transport": "http",
        "collections": collections,
        "top_n": len(results),
        "scores": scores,
        "max_score": max(scores) if scores else 0,
    }
    try:
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except OSError:
        pass

def log_recall_event(log_path: str | None, reason: str, **fields) -> None:
    """Append a one-line selection/skip reason to QMD_RECALL_LOG.

    Writes to the log file only (never stdout), and only when QMD_RECALL_LOG
    is set — so it never touches the model context and is a no-op in normal runs.
    Lets an operator tell *why* recall produced empty output (event_disabled /
    no_keywords / no_collections / daemon_unreachable / query_failed /
    no_results_after_filter / selected).
    """
    if not log_path:
        return
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": "qmd_recall_selection",
        "engine": os.environ.get("QMD_ENGINE", "gemini"),
        "reason": reason,
    }
    payload.update(fields)
    try:
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except OSError:
        pass

def main():
    # If QMD_SANDBOX is set or --sandbox option is in sys.argv, exit immediately with no output
    if os.environ.get("QMD_SANDBOX") or "--sandbox" in sys.argv:
        return 0

    # Parse stdin
    raw = sys.stdin.read().strip()
    if not raw:
        return 0
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return 0

    prompt = payload.get("prompt", "")
    if len(prompt) < 10:
        return 0

    cwd = payload.get("cwd") or os.getcwd()

    # Read once up front so early-exit paths can record their reason too.
    log_path = os.environ.get("QMD_RECALL_LOG")

    # Load configuration
    config = load_project_config(cwd)
    if not qmd_config.event_enabled(config, payload.get("hook_event_name", "UserPromptSubmit")):
        log_recall_event(log_path, "event_disabled")
        return 0
    
    # Extract keywords
    kw_result_raw = qmd_keywords.extract_keywords(prompt)
    
    # Extract lexical terms
    lexical_terms = []
    if "ep" in config.get("lexicalPatterns", []):
        lexical_terms.extend(qmd_keywords.extract_ep_terms(prompt))
    lexical_terms.extend(kw_result_raw)
    
    # Deduplicate lexical terms
    seen = set()
    deduped_lexical_terms = []
    for term in lexical_terms:
        if term not in seen:
            seen.add(term)
            deduped_lexical_terms.append(term)
            
    if not kw_result_raw and not deduped_lexical_terms:
        log_recall_event(log_path, "no_keywords")
        return 0

    # Query daemon or use fixture
    fixture_path = os.environ.get("QMD_QUERY_FIXTURE")
    results = []
    
    collections = config.get("collections", [])
    if not collections:
        log_recall_event(log_path, "no_collections")
        return 0
    raw_collections = []
    queried_wiki_first = False
    daemon_url = os.environ.get("QMD_DAEMON_URL", DEFAULT_DAEMON_URL)

    def query_daemon(query_collections: list[str]) -> list[dict] | None:
        return None

    if fixture_path:
        try:
            with open(fixture_path, "r", encoding="utf-8") as f:
                fixture_data = json.load(f)
                results = fixture_data.get("results", [])
        except (OSError, json.JSONDecodeError):
            log_recall_event(log_path, "fixture_error", fixture=fixture_path)
            return 0
    else:
        if not daemon_alive(daemon_url):
            log_recall_event(log_path, "daemon_unreachable", daemon=daemon_url)
            return 0
        else:
            lexical_query = " ".join(deduped_lexical_terms)
            vector_query = re.sub(r"\s+", " ", prompt).strip()

            def query_daemon(query_collections: list[str]) -> list[dict] | None:
                query_payload = {
                    "searches": [
                        {"type": "lex", "query": lexical_query},
                        {"type": "vec", "query": vector_query},
                    ],
                    "collections": query_collections,
                    "limit": 8,
                    "minScore": 0,
                    "timeout": config.get("queryTimeout", QUERY_TIMEOUT),
                    "rerank": False,
                }

                data = json.dumps(query_payload).encode("utf-8")
                req = urllib.request.Request(
                    f"{daemon_url}/query",
                    data=data,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                try:
                    timeout = float(config.get("queryTimeout", QUERY_TIMEOUT))
                    with urllib.request.urlopen(req, timeout=timeout) as resp:
                        body = resp.read().decode("utf-8")
                    parsed = json.loads(body)
                    daemon_results = parsed.get("results", [])
                    return daemon_results if isinstance(daemon_results, list) else []
                except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
                    return None

            if config.get("recallStrategy") == "hierarchical":
                roles = config.get("collectionRoles", {})
                wiki_collections = [c for c in collections if roles.get(c) == "wiki"]
                raw_collections = [c for c in collections if roles.get(c) != "wiki"]
                if wiki_collections:
                    queried_wiki_first = True
                    results = query_daemon(wiki_collections)
                    if results is None:
                        log_recall_event(log_path, "query_failed", daemon=daemon_url)
                        return 0
                else:
                    results = query_daemon(collections)
            else:
                results = query_daemon(collections)

            if results is None:
                log_recall_event(log_path, "query_failed", daemon=daemon_url)
                return 0

    # Log raw score observation if requested (log_path read once near the top)
    if log_path:
        log_score_observation(log_path, results, collections)

    # Inject _collection if missing
    for result in results:
        if "_collection" not in result:
            uri = result.get("file", "")
            if uri.startswith("qmd://"):
                result["_collection"] = uri[len("qmd://"):].split("/", 1)[0]
        roles = config.get("collectionRoles", {}) if isinstance(config.get("collectionRoles"), dict) else {}
        if roles.get(result.get("_collection", "")) == "wiki":
            wiki_meta = read_wiki_meta(result, config, cwd)
            result["_wiki_status"] = wiki_meta["status"]
            result["_wiki_reviewed"] = wiki_meta["reviewed"]

    if "ep" in config.get("lexicalPatterns", []):
        promote_ep_exact_matches(results, ep_numbers(prompt))

    # Filter and sort results
    # Sort by score descending
    results = sorted(results, key=lambda r: r.get("score", 0), reverse=True)
    
    # Filter based on skipPaths and default .auto-context-ignore
    skip_paths = config.get("skipPaths", [])
    # Always include .auto-context-ignore in skip list
    if ".auto-context-ignore" not in skip_paths:
        skip_paths.append(".auto-context-ignore")
        
    filtered_results = []
    min_score = float(config.get("minScore", 0.0))
    dropped_skip = 0
    dropped_min_score = 0

    for r in results:
        filepath = r.get("file", "")
        # Check skip paths
        should_skip = False
        for skip in skip_paths:
            if skip in filepath:
                should_skip = True
                break
        if should_skip:
            dropped_skip += 1
            continue

        # Check minScore
        if r.get("score", 0) < min_score:
            dropped_min_score += 1
            continue

        filtered_results.append(r)

    if (
        config.get("recallStrategy") == "hierarchical"
        and queried_wiki_first
        and raw_collections
        and not filtered_results
        and not fixture_path
    ):
        raw_results = query_daemon(raw_collections)
        if raw_results is None:
            log_recall_event(log_path, "query_failed", daemon=daemon_url)
            return 0
        for result in raw_results:
            if "_collection" not in result:
                uri = result.get("file", "")
                if uri.startswith("qmd://"):
                    result["_collection"] = uri[len("qmd://"):].split("/", 1)[0]
            roles = config.get("collectionRoles", {}) if isinstance(config.get("collectionRoles"), dict) else {}
            if roles.get(result.get("_collection", "")) == "wiki":
                wiki_meta = read_wiki_meta(result, config, cwd)
                result["_wiki_status"] = wiki_meta["status"]
                result["_wiki_reviewed"] = wiki_meta["reviewed"]
        if "ep" in config.get("lexicalPatterns", []):
            promote_ep_exact_matches(raw_results, ep_numbers(prompt))
        results = sorted(raw_results, key=lambda r: r.get("score", 0), reverse=True)
        filtered_results = []
        dropped_skip = 0
        dropped_min_score = 0
        for r in results:
            filepath = r.get("file", "")
            should_skip = False
            for skip in skip_paths:
                if skip in filepath:
                    should_skip = True
                    break
            if should_skip:
                dropped_skip += 1
                continue
            if r.get("score", 0) < min_score:
                dropped_min_score += 1
                continue
            filtered_results.append(r)

    compile_cfg = config.get("compile", {}) if isinstance(config.get("compile"), dict) else {}

    if config.get("recallStrategy") == "hierarchical":
        roles = config.get("collectionRoles", {})
        excluded_statuses = set(compile_cfg.get("excludeStatusesFromRecall", ["discarded", "contested"]))
        filtered_results = [
            r for r in filtered_results
            if roles.get(r.get("_collection", "")) != "wiki" or r.get("_wiki_status", "generated") not in excluded_statuses
        ]
        wiki_results = [r for r in filtered_results if roles.get(r.get("_collection", "")) == "wiki"]
        if wiki_results:
            filtered_results = wiki_results

    # lowPriorityStatuses 강등: 미검수 low-priority wiki 카드를 topN 절단 전에 뒤로 보낸다.
    # score 내림차순 위의 안정 정렬이라 그룹 내 순위는 유지되고, 검수 카드가
    # 저점수여도 미검수 generated 카드에 topN 슬롯을 뺏기지 않는다.
    low_priority = set(compile_cfg.get("lowPriorityStatuses", ["generated", "tentative"]))
    filtered_results.sort(
        key=lambda r: r.get("_wiki_status") in low_priority and not r.get("_wiki_reviewed", False)
    )

    # Limit to topN
    top_n = int(config.get("topN", 3))
    final_results = filtered_results[:top_n]

    # Record why recall produced (or withheld) output — file-only, never stdout.
    log_recall_event(
        log_path,
        "selected" if final_results else "no_results_after_filter",
        candidates=len(results),
        dropped_skip=dropped_skip,
        dropped_min_score=dropped_min_score,
        dropped_top_n=max(0, len(filtered_results) - len(final_results)),
        selected=len(final_results),
        min_score=min_score,
        top_n_limit=top_n,
        max_score=max((r.get("score", 0) for r in results), default=0),
    )
    
    if not final_results:
        return 0

    # Output formatted JSON
    output = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": format_context(final_results, resolve_prefix_style(config), config.get("collectionRoles", {}))
        }
    }
    print(json.dumps(output, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    sys.exit(main())
