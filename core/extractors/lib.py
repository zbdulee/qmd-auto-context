"""Shared helpers for host-CLI wiki extractor adapters.

Adapters are pure functions: read one payload JSON on stdin, run a host CLI in an
isolated temp cwd with tools/writes disabled, emit {"candidates": [...]} on stdout.
They never touch the project filesystem.
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

EXISTING WIKI INDEX (avoid duplicates):
{index}

SOURCE FILE: {path}
SOURCE CONTENT:
{content}
"""


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
        index=str(wiki.get("index", ""))[:4000],
        path=str(source.get("path", "")),
        content=str(source.get("content", "")),
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


def run_adapter(cli_name: str, env_override: str, build_cmd) -> int:
    """Full adapter flow shared by all host adapters."""
    payload = read_payload()
    prompt = build_prompt(payload)
    binary = resolve_bin(cli_name, env_override)
    if not binary:
        return CLI_ABSENT
    timeout = int(payload.get("timeout") or os.environ.get("QMD_EXTRACTOR_TIMEOUT") or 120)
    out, code = run_isolated(build_cmd(binary, prompt), timeout)
    if out is None:
        return code
    if code != 0:
        return code
    return emit(extract_candidates(out))
