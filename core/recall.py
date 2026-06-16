#!/usr/bin/env python3
import sys
import os
import json
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
HEALTH_TIMEOUT = 0.5
QUERY_TIMEOUT = 5.0

def daemon_alive(daemon_url: str) -> bool:
    try:
        req = urllib.request.Request(f"{daemon_url}/health", method="GET")
        with urllib.request.urlopen(req, timeout=HEALTH_TIMEOUT) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False

def load_project_config(cwd: str) -> dict:
    # Look for .agents/qmd-recall.json under cwd or its parent directories (global to local search)
    path = Path(cwd).resolve()
    config_file = None
    
    # Simple check under current directory first
    target = path / ".agents" / "qmd-recall.json"
    if target.exists():
        config_file = target
    else:
        # Traverse upwards to find .agents/qmd-recall.json
        for parent in path.parents:
            target = parent / ".agents" / "qmd-recall.json"
            if target.exists():
                config_file = target
                break
                
    if config_file:
        try:
            with open(config_file, "r", encoding="utf-8") as f:
                parsed = json.load(f)
                return qmd_config.normalize_config(parsed)
        except (json.JSONDecodeError, OSError):
            pass

    # Default fallback config
    fallback = qmd_config.normalize_config({})
    fallback["collections"] = [path.name.replace(" ", "-")]
    return fallback

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

def format_context(results: list[dict], prefix_style: str = "full") -> str:
    lines = ["관련 문서:"]
    for result in results:
        uri = result.get("file", "")
        filepath = qmd_uri_to_filepath(uri)
        title = result.get("title", "")
        collection = result.get("_collection", "") or qmd_uri_to_collection(uri)
        
        tag = collection
        if prefix_style == "tag" and collection:
            tag = collection.rsplit("-", 1)[-1]
        prefix = f"[{tag}] " if tag else ""
        
        if title:
            lines.append(f"- {prefix}{filepath} - {title}")
        else:
            lines.append(f"- {prefix}{filepath}")
    lines.append("필요시 참조.")
    return "\n".join(lines)

def log_score_observation(log_path: str, results: list[dict], collections: list[str]) -> None:
    if not results:
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
    
    # Load configuration
    config = load_project_config(cwd)
    if not qmd_config.event_enabled(config, payload.get("hook_event_name", "UserPromptSubmit")):
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
        return 0

    # Query daemon or use fixture
    fixture_path = os.environ.get("QMD_QUERY_FIXTURE")
    results = []
    
    collections = config.get("collections", [])
    if not collections:
        return 0

    if fixture_path:
        try:
            with open(fixture_path, "r", encoding="utf-8") as f:
                fixture_data = json.load(f)
                results = fixture_data.get("results", [])
        except (OSError, json.JSONDecodeError):
            return 0
    else:
        daemon_url = os.environ.get("QMD_DAEMON_URL", DEFAULT_DAEMON_URL)
        if not daemon_alive(daemon_url):
            return 0
        else:
            lexical_query = " ".join(deduped_lexical_terms)
            vector_query = re.sub(r"\s+", " ", prompt).strip()
            
            query_payload = {
                "searches": [
                    {"type": "lex", "query": lexical_query},
                    {"type": "vec", "query": vector_query},
                ],
                "collections": collections,
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
                results = parsed.get("results", [])
                if not isinstance(results, list):
                    results = []
            except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
                return 0

    # Log observation if requested
    log_path = os.environ.get("QMD_RECALL_LOG")
    if log_path:
        log_score_observation(log_path, results, collections)

    # Inject _collection if missing
    for result in results:
        if "_collection" not in result:
            uri = result.get("file", "")
            if uri.startswith("qmd://"):
                result["_collection"] = uri[len("qmd://"):].split("/", 1)[0]

    if "ep" in config.get("lexicalPatterns", []):
        promote_ep_exact_matches(results, ep_numbers(prompt))

    # Filter and sort results
    # Sort by score descending
    results = sorted(results, key=lambda r: r.get("score", 0), reverse=True)
    
    # Filter based on skipPaths and default .zb-context
    skip_paths = config.get("skipPaths", [])
    # Always include .zb-context in skip list
    if ".zb-context" not in skip_paths:
        skip_paths.append(".zb-context")
        
    filtered_results = []
    min_score = float(config.get("minScore", 0.0))
    
    for r in results:
        filepath = r.get("file", "")
        # Check skip paths
        should_skip = False
        for skip in skip_paths:
            if skip in filepath:
                should_skip = True
                break
        if should_skip:
            continue
            
        # Check minScore
        if r.get("score", 0) < min_score:
            continue
            
        filtered_results.append(r)

    # Limit to topN
    top_n = int(config.get("topN", 3))
    final_results = filtered_results[:top_n]
    
    if not final_results:
        return 0

    # Output formatted JSON
    output = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": format_context(final_results, resolve_prefix_style(config))
        }
    }
    print(json.dumps(output, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    sys.exit(main())
