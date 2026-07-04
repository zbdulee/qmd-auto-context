"""Shared helpers for host-CLI wiki extractor adapters.

Adapters are pure functions: read one payload JSON on stdin, run a host CLI in an
isolated temp cwd with tools/writes disabled, emit {"candidates": [...]} on stdout.
They never touch the project filesystem.

The same adapters double as card verifiers: a payload with {"task": "verify"}
switches to the adversarial verify prompt and emits {"verdict": ...} instead.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

CLI_ABSENT = 127

ALLOWED_TYPES = ("concept", "entity", "decision", "comparison")

_PROMPT_TEMPLATE = """You convert one source document into compact, durable wiki candidates.

Output RULES (strict):
- Output ONLY a single JSON object: {{"candidates": [ ... ]}}. No prose, no code fence.
- Each candidate: {{"title": str, "summary": str, "suggestedType": one of {types}, "confidence": "low"|"medium"|"high", "canonicalKey": optional str, "aliases": optional str[], "targetPath": optional str}}.
- Treat title as a display name only. Prefer a stable English kebab-case or snake_case canonicalKey that can survive title changes.
- aliases should include Korean title variants and common alternate names when they exist.
- If the source overlaps an existing wiki entry, reuse that entry's canonicalKey and targetPath instead of creating a new concept.
- Do not split into multiple candidates unless the source contains clearly independent durable concepts. If uncertain, emit one candidate or none.
- summary is a short durable conclusion (a decision, rule, concept, or entity fact). NOT a transcript, NOT step-by-step dialog.
- Never include secrets, API keys, tokens, or credentials. Omit anything sensitive.
- If nothing durable is worth saving, output {{"candidates": []}}.
- Do NOT use any tools. Do NOT read or write files. Answer directly.

WIKI SCHEMA (for orientation):
{schema}

{existing_context_section}

SOURCE FILE: {path}
SOURCE CONTENT:
{content}
"""

VERDICT_VALUES = ("pass", "fail", "inconclusive")

_VERIFY_PROMPT_TEMPLATE = """You are an adversarial fact-checker for one auto-generated wiki card.

Your job: try to REFUTE the card using only the SOURCE documents below.

Output RULES (strict):
- Output ONLY a single JSON object: {{"verdict": "pass"|"fail"|"inconclusive", "claims": [{{"claim": str, "supported": true|false|null, "quote": str, "sourcePath": str}}], "reasons": [str]}}. No prose, no code fence.
- Decompose the card (title, summary, body) into its substantive factual claims.
- For each claim, search the SOURCE content for evidence. "quote" MUST be a verbatim excerpt copied from the source ("" when none).
- supported=false ONLY when the source CONTRADICTS the claim or states the opposite.
- supported=null when the source neither confirms nor denies it.
- verdict rules:
  - "fail" if ANY substantive claim contradicts the source (some supported=false).
  - "pass" if every substantive claim is backed by a verbatim quote (all supported=true).
  - "inconclusive" otherwise — including when a source is marked truncated and the missing part could hold the evidence.
- Frontmatter metadata and style are NOT claims. Judge only factual/semantic content.
- Never include secrets, API keys, tokens, or credentials in output.
- Do NOT use any tools. Do NOT read or write files. Answer directly.

CARD FILE: {card_path}
CARD CONTENT:
{card_content}

{sources_section}
"""

_SIMILAR_PAGES_TEMPLATE = """TOP MATCHING EXISTING WIKI PAGES (reuse canonicalKey/targetPath below if this source overlaps one):

{pages}"""

_INDEX_TEMPLATE = """EXISTING WIKI INDEX (avoid duplicates):
{index}"""


def render_existing_context_section(wiki: dict) -> str:
    similar_pages = wiki.get("similarPages")
    if isinstance(similar_pages, list) and similar_pages:
        blocks = []
        for page in similar_pages:
            if not isinstance(page, dict):
                continue
            path = str(page.get("path", ""))
            score = page.get("score", "")
            content = str(page.get("content", ""))
            blocks.append(f"### {path} (score: {score})\n{content}")
        if blocks:
            return _SIMILAR_PAGES_TEMPLATE.format(pages="\n\n".join(blocks))
    return _INDEX_TEMPLATE.format(index=str(wiki.get("index", ""))[:4000])


def read_payload() -> dict:
    try:
        raw = sys.stdin.read()
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def build_prompt(payload: dict) -> str:
    source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
    wiki = payload.get("wiki") if isinstance(payload.get("wiki"), dict) else {}
    return _PROMPT_TEMPLATE.format(
        types="/".join(ALLOWED_TYPES),
        schema=str(wiki.get("schema", ""))[:4000],
        existing_context_section=render_existing_context_section(wiki),
        path=str(source.get("path", "")),
        content=str(source.get("content", "")),
    )


def build_verify_prompt(payload: dict) -> str:
    card = payload.get("card") if isinstance(payload.get("card"), dict) else {}
    sources = payload.get("sources") if isinstance(payload.get("sources"), list) else []
    blocks = []
    for src in sources:
        if not isinstance(src, dict):
            continue
        path = str(src.get("path", ""))
        truncated = " (truncated: true)" if src.get("truncated") else ""
        blocks.append(f"SOURCE FILE: {path}{truncated}\nSOURCE CONTENT:\n{src.get('content', '')}")
    return _VERIFY_PROMPT_TEMPLATE.format(
        card_path=str(card.get("path", "")),
        card_content=str(card.get("content", "")),
        sources_section="\n\n".join(blocks) if blocks else "SOURCE CONTENT: (none provided)",
    )


def extract_candidates(text: str) -> dict:
    if not isinstance(text, str) or "candidates" not in text:
        return {}
    # Use the JSON decoder (which respects string escaping) to scan each '{' as a
    # possible object start. A naive brace counter miscounts '{'/'}' inside string
    # values, so output whose summary contains a lone brace would be dropped.
    # Prefer the last object that parses with a "candidates" list.
    decoder = json.JSONDecoder()
    found = None
    idx = 0
    length = len(text)
    while idx < length:
        start = text.find("{", idx)
        if start == -1:
            break
        try:
            obj, end = decoder.raw_decode(text, start)
        except json.JSONDecodeError:
            idx = start + 1
            continue
        if isinstance(obj, dict) and isinstance(obj.get("candidates"), list):
            found = obj
        idx = max(end, start + 1)
    return found or {}


def extract_verdict(text: str) -> dict:
    """Last JSON object in stdout carrying a valid "verdict" — extract_candidates와 동일 스캔."""
    if not isinstance(text, str) or "verdict" not in text:
        return {}
    decoder = json.JSONDecoder()
    found = None
    idx = 0
    length = len(text)
    while idx < length:
        start = text.find("{", idx)
        if start == -1:
            break
        try:
            obj, end = decoder.raw_decode(text, start)
        except json.JSONDecodeError:
            idx = start + 1
            continue
        if isinstance(obj, dict) and obj.get("verdict") in VERDICT_VALUES:
            found = obj
        idx = max(end, start + 1)
    return found or {}


def resolve_bin(name: str, env_override: str) -> str | None:
    override = os.environ.get(env_override)
    if override:
        return override
    path = os.environ.get("PATH", "")
    extra = []
    fnm_root = Path.home() / ".local" / "share" / "fnm" / "node-versions"
    if fnm_root.exists():
        versions = sorted(fnm_root.glob("v*/installation/bin"))
        if versions:
            extra.append(str(versions[-1]))
    bun = Path.home() / ".bun" / "bin"
    if bun.exists():
        extra.append(str(bun))
    search = os.pathsep.join(extra + [path]) if extra else path
    return shutil.which(name, path=search)


def run_isolated(cmd: list[str], timeout: int) -> tuple[str | None, int]:
    workdir = tempfile.mkdtemp(prefix="qmd-extract-")
    # QMD_SANDBOX=1 neuters any qmd hook the nested CLI might fire (the dispatcher
    # and core scripts honor it with an immediate silent exit), so the headless
    # extractor can never recurse back into the compile pipeline.
    child_env = {**os.environ, "QMD_SANDBOX": "1"}
    try:
        proc = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=False,
            cwd=workdir,
            env=child_env,
        )
        if proc.stderr:
            sys.stderr.write(proc.stderr[-4000:])
        return proc.stdout, proc.returncode
    except subprocess.TimeoutExpired:
        return None, 1
    except FileNotFoundError:
        return None, CLI_ABSENT
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def emit(candidates_obj: dict) -> int:
    candidates = candidates_obj.get("candidates") if isinstance(candidates_obj, dict) else None
    if not isinstance(candidates, list):
        return 1
    print(json.dumps({"candidates": candidates}, ensure_ascii=False))
    return 0


def emit_verdict(verdict_obj: dict) -> int:
    if not isinstance(verdict_obj, dict) or verdict_obj.get("verdict") not in VERDICT_VALUES:
        return 1
    out = {
        "verdict": verdict_obj["verdict"],
        "claims": verdict_obj.get("claims") if isinstance(verdict_obj.get("claims"), list) else [],
        "reasons": verdict_obj.get("reasons") if isinstance(verdict_obj.get("reasons"), list) else [],
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0


def run_adapter(cli_name: str, env_override: str, build_cmd) -> int:
    """Full adapter flow shared by all host adapters."""
    payload = read_payload()
    is_verify = payload.get("task") == "verify"
    prompt = build_verify_prompt(payload) if is_verify else build_prompt(payload)
    binary = resolve_bin(cli_name, env_override)
    if not binary:
        return CLI_ABSENT
    timeout = int(payload.get("timeout") or os.environ.get("QMD_EXTRACTOR_TIMEOUT") or 120)
    out, code = run_isolated(build_cmd(binary, prompt), timeout)
    if out is None:
        return code
    if code != 0:
        return code
    if is_verify:
        return emit_verdict(extract_verdict(out))
    return emit(extract_candidates(out))
