#!/usr/bin/env python3
"""Compact-context extractor for qmd wiki compile.

This command is the safe bridge between a host/manual compact summary and
core/wiki_compile.py. It accepts already-bounded durable conclusions, converts
them to deterministic candidate JSON, and delegates all write/lint/governance to
wiki_compile.py. It intentionally does not accept or persist raw transcripts.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

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
TRANSCRIPT_RE = re.compile(r"(?im)^\s*(user|assistant|system|human|ai)\s*:")


def load_payload() -> dict[str, Any]:
    try:
        parsed = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9가-힣]+", "-", value.lower()).strip("-")
    return slug or "wiki-page"


def compact_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    if isinstance(payload.get("candidates"), list):
        return [item for item in payload["candidates"] if isinstance(item, dict)]
    durable = payload.get("durable")
    if isinstance(durable, dict):
        return [durable]
    return []


def to_candidate(payload: dict[str, Any], item: dict[str, Any]) -> dict[str, Any] | None:
    title = item.get("title")
    summary = item.get("summary")
    if not isinstance(title, str) or not title.strip():
        return None
    if not isinstance(summary, str) or not summary.strip():
        return None

    suggested_type = item.get("suggestedType") or item.get("type") or "concept"
    if suggested_type not in TYPE_DIRS:
        suggested_type = "concept"
    target_path = item.get("targetPath")
    if not isinstance(target_path, str) or not target_path.strip():
        target_path = f".auto-context/wiki/{TYPE_DIRS[suggested_type]}/{slugify(title)}.md"

    trigger = payload.get("trigger") if isinstance(payload.get("trigger"), str) else "manual"
    source_ref = payload.get("sourceRef") if isinstance(payload.get("sourceRef"), str) else "compact-context"
    source_kind = payload.get("sourceKind") if isinstance(payload.get("sourceKind"), str) else "session"
    sources = item.get("sources") if isinstance(item.get("sources"), list) else [{"kind": source_kind, "ref": source_ref}]

    # If a host accidentally passes transcript-shaped compact input, do not pass
    # the raw text through. wiki_compile will record a rejected candidate without
    # writing a wiki page.
    if TRANSCRIPT_RE.search(summary):
        summary = "[REDACTED_TRANSCRIPT] transcript-like compact input rejected before wiki compile."
        title = title.strip() or "Rejected transcript"
        target_path = f".auto-context/wiki/{TYPE_DIRS[suggested_type]}/{slugify(title)}.md"
        return {
            "trigger": trigger,
            "title": title,
            "summary": "User: [REDACTED_TRANSCRIPT]",
            "suggestedType": suggested_type,
            "confidence": item.get("confidence", "low"),
            "sources": sources,
            "targetPath": target_path,
        }

    return {
        "trigger": trigger,
        "title": title.strip(),
        "summary": summary.strip(),
        "suggestedType": suggested_type,
        "confidence": item.get("confidence", "medium"),
        "sources": sources,
        "targetPath": target_path,
    }


def run_compile(cwd: str, candidate: dict[str, Any], regenerate: bool = False) -> str:
    script = Path(__file__).resolve().with_name("wiki_compile.py")
    argv = [sys.executable, str(script), "--cwd", cwd]
    if regenerate:
        argv.append("--regenerate")
    proc = subprocess.run(
        argv,
        input=json.dumps(candidate, ensure_ascii=False),
        text=True,
        capture_output=True,
        env=os.environ.copy(),
        check=False,
    )
    return (proc.stdout or "").strip()


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract compact durable wiki candidates and compile them.")
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--regenerate", action="store_true")
    args = parser.parse_args()

    if os.environ.get("QMD_SANDBOX"):
        return 0

    payload = load_payload()
    outputs = []
    for item in compact_items(payload):
        candidate = to_candidate(payload, item)
        if candidate is None:
            continue
        out = run_compile(args.cwd, candidate, regenerate=args.regenerate)
        if out:
            outputs.append(out)
    if outputs:
        print("\n".join(outputs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
